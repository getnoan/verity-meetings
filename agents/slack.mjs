/**
 * Slack helper. Raw fetch, no SDK — zero-dependency rule holds.
 *
 * Two tokens, two jobs:
 *   SLACK_BOT_TOKEN (xoxb-…)  Web API calls (post messages, look up users)
 *   SLACK_APP_TOKEN (xapp-…)  Socket Mode only (apps.connections.open)
 *
 * The websocket itself is Node's native WebSocket client — experimental on
 * Node 20, so the daemon runs with --experimental-websocket (drop the flag
 * when the fleet moves to Node ≥22).
 */

const API = "https://slack.com/api";

/* ---------------- the agent relay ----------------
 * With VERITY_SLACK_RELAY_URL and VERITY_SLACK_RELAY_TOKEN set, calls go
 * through the hosted Slack app (slack.getnoan.com) instead of a bot token of our own:
 * the token was minted by the workspace owner on the app's setup page, it
 * can post only into channels the app is already in, and reads need a token
 * minted with reads on (channel history, the channel list, the member
 * directory). Methods the relay does not carry (auth.test, the socket) still
 * go to Slack directly when a bot token exists, and fail plainly when not. */
export const RELAY_METHODS = new Set(["chat.postMessage", "chat.update", "conversations.history", "conversations.replies", "conversations.list", "users.lookupByEmail", "users.list", "users.info"]);
export const relayConfig = (env = process.env) => env.VERITY_SLACK_RELAY_URL && env.VERITY_SLACK_RELAY_TOKEN
  ? { url: String(env.VERITY_SLACK_RELAY_URL).replace(/\/+$/, ""), token: env.VERITY_SLACK_RELAY_TOKEN } : null;

async function relayCall(method, args, { relay, retries = 3 }) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${relay.url}/agents/slack`, {
        method: "POST",
        headers: { Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ method, args }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      if (attempt < retries) { await new Promise(r => setTimeout(r, 2000 * 2 ** attempt)); continue; }
      throw new Error(`Slack relay ${method} → network: ${e.cause?.code || e.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) { await new Promise(r => setTimeout(r, 2000 * 2 ** attempt)); continue; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(`Slack relay ${method} → ${data.error || res.status}`);
    return data;
  }
}

async function call(method, args = {}, { token, retries = 3, relay = relayConfig() } = {}) {
  if (relay && RELAY_METHODS.has(method)) {
    // During the cutover a bot token may still be set: when the relay refuses
    // (the hosted app is not in that channel yet, a cap, an outage) the call
    // goes the old way and says so once, instead of losing the message.
    try { return await relayCall(method, args, { relay, retries }); }
    catch (e) {
      if (!token) throw e;
      console.warn(`slack: relay refused ${method} (${String(e.message).split("→").pop().trim()}); falling back to the bot token`);
    }
  }
  if (!token) throw new Error(`Slack ${method} → no bot token, and the relay does not carry this method`);
  // form-encoded, not JSON: Slack accepts application/x-www-form-urlencoded on
  // EVERY method, but application/json only on write methods (chat.postMessage
  // etc.) — read methods like users.info silently ignore a JSON body and then
  // complain the arguments are missing. Learned live, 2026-07-25.
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null) form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      // connect timeouts / DNS blips reject the fetch itself and never reach
      // the HTTP retry path below — cost a 2026-07-27 Actions run before this
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
        continue;
      }
      throw new Error(`Slack ${method} → network: ${e.cause?.code || e.message}`);
    }
    if (res.status === 429 && attempt < retries) {
      const wait = (parseInt(res.headers.get("retry-after") || "2", 10) + 1) * 1000;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      if ((res.status >= 500) && attempt < retries) {
        await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
        continue;
      }
      throw new Error(`Slack ${method} → ${data.error || res.status}`);
    }
    return data;
  }
}

export const slackApi = (method, args = {}) =>
  call(method, args, { token: process.env.SLACK_BOT_TOKEN });

/* ---------------- @handle → <@ID> mention linking ----------------
 *
 * Slack only pings on <@U…> ids; a literal "@hope" renders as inert text, so
 * the model could never actually mention anyone. Both post functions now run
 * outgoing text through a directory lookup: an @word that matches a workspace
 * member's handle, display name, or real name becomes a real mention.
 *
 * Deliberate properties:
 *   - CODE decides what converts, from users.list — the model cannot mint an
 *     id, and @channel/@here/@everyone are never users so can never convert
 *     to the <!channel>-style mass pings.
 *   - A name shared by two members converts for NEITHER (ambiguity drops the
 *     variant); an unknown @word is left as typed.
 *   - Fail-soft: if users.list is unavailable the text posts unchanged.
 */

let mentionDir = { at: 0, byHandle: new Map() };

async function mentionDirectory() {
  if (Date.now() - mentionDir.at < 10 * 60_000) return mentionDir.byHandle;
  const byHandle = new Map();
  const taken = (k) => byHandle.has(k);
  const conflict = new Set();
  let cursor;
  do {
    const d = await slackApi("users.list", { limit: 200, ...(cursor ? { cursor } : {}) });
    for (const u of d.members || []) {
      if (u.is_bot || u.deleted || u.id === "USLACKBOT") continue;
      const variants = new Set();
      for (const raw of [u.name, u.profile?.display_name, u.real_name]) {
        const v = String(raw || "").trim().toLowerCase();
        if (!v) continue;
        variants.add(v.replace(/\s+/g, "."));   // "Jane Doe" → "jane.doe"
        variants.add(v.replace(/\s+/g, ""));    //            → "janedoe"
        const first = v.split(/\s+/)[0];
        if (first.length >= 3) variants.add(first);  // "jane" — dropped below if two Janes
      }
      for (const v of variants) {
        if (conflict.has(v)) continue;
        if (taken(v) && byHandle.get(v) !== u.id) { byHandle.delete(v); conflict.add(v); continue; }
        byHandle.set(v, u.id);
      }
    }
    cursor = d.response_metadata?.next_cursor || null;
  } while (cursor);
  mentionDir = { at: Date.now(), byHandle };
  return byHandle;
}

/** Pure half, exported for tests: convert @handles found in `byHandle`.
 *  The char before @ must be start/whitespace/bracket so emails never match. */
export function linkMentionsIn(text, byHandle) {
  return String(text).replace(/(^|[\s([{])@([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)/gi, (m, pre, word) => {
    const id = byHandle.get(word.toLowerCase());
    return id ? `${pre}<@${id}>` : m;
  });
}

async function linkMentions(text) {
  if (!/@/.test(String(text))) return text;
  try { return linkMentionsIn(text, await mentionDirectory()); }
  catch { return text; }   // fail-soft: an unpingable name beats a lost message
}

/** Post into a thread. Copy discipline applies here too: no em dashes. */
export async function postThread(channel, thread_ts, text) {
  return slackApi("chat.postMessage", {
    channel, thread_ts,
    text: (await linkMentions(String(text).replace(/\s*[—―]\s*/g, " - "))).slice(0, 3500),
    unfurl_links: false,
  });
}

/** Fresh post in a channel (goals/digests — not thread replies). Fails with
 *  not_in_channel if the bot isn't a member, which is the membership guard. */
export async function postChannel(channel, text) {
  return slackApi("chat.postMessage", {
    channel,
    text: (await linkMentions(String(text).replace(/\s*[—―]\s*/g, " - "))).slice(0, 3500),
    unfurl_links: false,
  });
}

/** auth.test → { userId, botId, team }. */
export async function botIdentity() {
  const d = await slackApi("auth.test");
  return { userId: d.user_id, botId: d.bot_id, team: d.team };
}

/** Slack user id → their profile email (cached per process). Bots → null.
 *  Only DEFINITIVE answers are cached — a failed API call (rate limit, scope
 *  still propagating after a reinstall) returns null this once but is retried
 *  next time, so one transient error can't lock a teammate out for the
 *  process's lifetime. */
const emailCache = new Map();
export async function userEmail(userId) {
  if (emailCache.has(userId)) return emailCache.get(userId);
  try {
    const d = await slackApi("users.info", { user: userId });
    const email = (d.user && !d.user.is_bot && !d.user.deleted)
      ? ((d.user.profile?.email || "").toLowerCase() || null)
      : null;
    emailCache.set(userId, email);   // definitive answer — cache it
    return email;
  } catch {
    return null;                     // transient failure — fail closed, do NOT cache
  }
}

/** Open a Socket Mode connection; returns the WebSocket (caller wires events). */
export async function openSocket() {
  const d = await call("apps.connections.open", {}, { token: process.env.SLACK_APP_TOKEN });
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket client unavailable — run node with --experimental-websocket (Node 20) or upgrade to Node ≥22");
  }
  return new WebSocket(d.url);
}
