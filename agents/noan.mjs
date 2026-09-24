/**
 * NOAN API client. Thin wrapper over fetch with auth, pagination,
 * rate-limit backoff, and the few task/tag helpers the worker needs.
 *
 * Contracts confirmed against the OpenAPI spec:
 *   GET   /me
 *   GET   /facts?block_slug=<slug>        → { meta, links, items:[{id,blockSlug,content,createdAt}] }
 *   GET   /contacts?q=<query>             → { ..., items:[Contact] }  ← matches NAME only,
 *                                            never email; for an address use findContactByEmail()
 *   GET   /blocks ?slug/title             → { ..., items:[BlockListItem] }
 *   GET   /tasks ?status&completed        → { ..., items:[Task] }
 *   POST  /tasks                          → create
 *   PATCH /tasks/{id}  {status,completed,details,title}   ← partial update (confirmed)
 *   (no GET /tasks/{id}, no POST /tasks/{id}/notes — both 404; a "note on the
 *    task" is appendTaskDetails()/appendTaskNote() below, into `details`)
 *   PUT   /tasks/{id}/tags  {tagIds[]}    ← REPLACES the set
 *   POST  /notes  {content,title?,externalId?}   ← content caps at 25,000 chars; post via postNote()
 *   POST  /facts  {blockSlug,content}
 *   GET   /tags                           → { ..., items:[Tag] }
 */
import { agentIdentityIds, agentIdentityId, agentName as defaultAgentName } from "./required-env.mjs";
import { buildAgentComment, commentSecret, markerOverhead, hasAgentMarker } from "./agent-comment.mjs";

const BASE = process.env.NOAN_API_URL
  ? `${process.env.NOAN_API_URL.replace(/\/$/, "")}/v1`
  : "https://api.getnoan.com/v1";

// Read per call, not at import: an agent process may set NOAN_AGENT_API_KEY
// (a restricted per-agent key, e.g. the social agent's no-contact-read key)
// before its first API call; everything else falls through to the shared key.
/** The key this process will authenticate with, or "" if it has none. */
export function noanKey() {
  return (process.env.NOAN_AGENT_API_KEY || process.env.NOAN_PERSONAL_API_KEY || "").trim();
}

/** Refuse to run without a key, loudly.
 *
 *  A workflow whose secret is missing or misspelled renders `${{ secrets.X }}` as an EMPTY
 *  STRING, not an error. Before the per-category split that fell through to the shared key and
 *  the run went green under the wrong identity — and after it, a missing NOAN_KEY_* would have
 *  fallen back to a broad personal key with none of the category's scope or stack limits, with
 *  nothing in the log to say so. Every boundary was one absent secret away from being bypassed
 *  silently. Hence: no key, no run. */
export function assertNoanKey() {
  if (!noanKey()) {
    throw new Error(
      "No NOAN API key. Set NOAN_PERSONAL_API_KEY (a personal key from the NOAN app, Settings > " +
      "API), or NOAN_AGENT_API_KEY where a workflow runs under a per-agent key. A GitHub secret " +
      "that is missing or misspelled renders as an empty string, so check the secret name first.");
  }
}

/** Refuse to silently fall back from a per-category key to the shared one.
 *
 *  This is the hole the per-category split left open. A workflow sets
 *  NOAN_AGENT_API_KEY: ${{ secrets.NOAN_KEY_DEMAND }}; if that secret is missing, revoked or
 *  misspelled, GitHub renders it as an EMPTY STRING rather than failing. The empty value is
 *  falsy, so the client fell through to NOAN_PERSONAL_API_KEY — a broad personal key with none
 *  of the category's scopes or stack limits — and the run went green with nothing in the log.
 *  Every boundary was one absent secret away from being bypassed, invisibly.
 *
 *  So a workflow that means to use a category key says so with NOAN_REQUIRE_AGENT_KEY=1, and
 *  the fallback becomes an error instead of a downgrade. Steps that deliberately want the
 *  shared key — trial.yml's seed step, which needs a human key for its fact writes — set it
 *  to 0 alongside blanking NOAN_AGENT_API_KEY, so the intent is written down at the call site.
 */
function assertNoDowngrade() {
  if (process.env.NOAN_REQUIRE_AGENT_KEY !== "1") return;
  if (!(process.env.NOAN_AGENT_API_KEY || "").trim()) {
    throw new Error(
      "NOAN_REQUIRE_AGENT_KEY=1 but NOAN_AGENT_API_KEY is empty. This run expects a " +
      "per-category key and will NOT fall back to NOAN_PERSONAL_API_KEY, because that key has " +
      "broader scopes and no stack limit. A GitHub secret that is missing or misspelled renders " +
      "as an empty string — check the secret name in the workflow's env block first.");
  }
}

function headers() {
  assertNoDowngrade();
  const key = noanKey();
  if (!key) assertNoanKey();
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

/* Errors carry e.noan = { status, kind } so surfaces can speak like a person
 * instead of echoing "NOAN GET /facts?… → 401" at the user (2026-08-21,
 * after a key reset): kind "auth" = the key is bad/reset (401/403),
 * "unreachable" = network/5xx exhaustion, "api" = everything else. */
function tag(err, status, payload) {
  err.noan = {
    status: status ?? null,
    kind: status === 401 || status === 403 ? "auth" : status == null || status >= 500 || status === 429 ? "unreachable" : "api",
    // The parsed body, not just its prose. A 4xx can carry the identifier the
    // caller needs to recover — a 409 from POST /contacts names the contact
    // that already owns the address — and reading it back out of the message
    // string with a regex is how that recovery silently stops working the day
    // the wording changes.
    code: payload?.code ?? null,
    payload: payload ?? null,
  };
  return err;
}

async function call(method, path, body, { retries = 4 } = {}) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  // Build the headers ONCE, and OUTSIDE the try below. Still per request, so an
  // agent that sets NOAN_AGENT_API_KEY before its first call is honoured — but
  // no longer per ATTEMPT, and no longer inside the catch that retries.
  //
  // headers() can throw: a missing key, or a category key that a workflow left
  // empty (assertNoDowngrade). Both are permanent configuration faults. Inside
  // the try they were caught as transient network errors and retried through the
  // full 2+4+8+15s ladder — 29s per call, and connectMenu()'s six probes turned
  // that into a 174s unit-test run. Same class of mistake as reporting a 403
  // MissingPermission as a retryable blip: a config error must fail on the spot.
  const hdrs = headers();
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: hdrs,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (attempt >= retries) throw tag(new Error(`NOAN ${method} ${path} → network: ${e.message}`), null);
      await new Promise(r => setTimeout(r, Math.min(2000 * 2 ** attempt, 15000)));
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw tag(new Error(`NOAN ${method} ${path} → ${res.status} after ${attempt} retries`), res.status);
      const wait = Math.min(2000 * 2 ** attempt, 15000);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let payload; try { payload = JSON.parse(text); } catch { payload = text; }
    if (!res.ok) {
      const code = payload?.code ? `${payload.code}: ` : "";
      const msg  = payload?.message || text || res.statusText;
      throw tag(new Error(`NOAN ${method} ${path} → ${res.status} ${code}${msg}`), res.status, typeof payload === "object" ? payload : null);
    }
    return payload;
  }
}

export const noanGet   = (p)        => call("GET", p);
export const noanPost  = (p, b)     => call("POST", p, b);
export const noanPatch = (p, b)     => call("PATCH", p, b);
export const noanPut   = (p, b)     => call("PUT", p, b);

/** The same path with one query param replaced and, optionally, others dropped
 *  (page/per_page are the two we rewrite). Every OTHER param survives — that is
 *  the whole point, see sweepOnce. The one query-rewriting code path. */
const withParam = (path, key, value, { drop = [] } = {}) => {
  const [base, qs = ""] = path.split("?");
  const params = new URLSearchParams(qs);
  params.set(key, String(value));
  for (const k of drop) params.delete(k);
  return `${base}?${params}`;
};

/** One pass at a fixed page size. Returns the rows AND the server's own totalItems
 *  so the caller can tell a complete read from a partial one.
 *
 *  NEVER follows `links.next`. The API's next-page link DROPS EVERY QUERY PARAM:
 *  measured 2026-09-11, `GET /tasks?completed=false&per_page=100` reports
 *  meta.totalItems 120 and links.next `…/tasks?page=2&per_page=100` — no
 *  `completed`. Following it, this walked the WHOLE board from page two: 1215
 *  rows, 1095 of them completed, for a 120-item open list. Same on every list
 *  endpoint (/notes, /assets — which also loses its sort/order — /contacts,
 *  /facts). The failure is silent and only appears once the filtered set passes
 *  per_page: `status=backlog` sat at 94 that day, one page short of the general
 *  lane's claim list including tasks from every status.
 *
 *  So each page URL is built from the ORIGINAL path plus page=N, and the walk
 *  stops on meta.hasNext === false; links.next is consulted only when a response
 *  carries no meta at all (none does today — kept as the fallback so an endpoint
 *  that drops meta degrades to the old behaviour, not to a single page). */
export function pageUrl(path, page) {
  return page === 1 && !/[?&]page=/.test(path) ? path : withParam(path, "page", page);
}

/** Whether another page follows: the server's own flag first, the link only when
 *  there is no flag. Exported for the test; pure. */
export function hasNextPage(res) {
  if (typeof res?.meta?.hasNext === "boolean") return res.meta.hasNext;
  return !!res?.links?.next;
}

/** Retry budget for ONE page of a paginated read. Deliberately larger than call()'s
 *  default of 4 (2+4+8+15s ≈ 29s), which is tuned for a single request — and a sweep
 *  is not a single request. noanGetAll("/contacts") is ~70 of them back to back,
 *  because the union passes at 100/75/50/25 always run in full there (the first pass
 *  never reaches meta.totalItems on that endpoint, which is the whole reason the union
 *  exists). A burst that size can rate-limit itself.
 *
 *  On 2026-09-23 it did. The reply worker's hourly sweep landed inside the Wednesday
 *  weekly-activity-report run — the fleet's other heavy /contacts reader, two full
 *  unions of its own plus tasks/facts/blocks/stacks/notes/assets — and died on
 *  `/contacts?per_page=50&page=4` with `429 after 4 retries`: 29s of backoff was not
 *  enough to outlast the throttle, and the throw took down a worker that had already
 *  established there was no inbound mail to handle.
 *
 *  Note what is NOT the fix: moving the cron. reply-worker fires at :13, and Actions
 *  schedule drift on it measured +6 to +42 min over 20 consecutive runs, so it starts
 *  anywhere in the hour regardless of what the cron says. Collisions cannot be
 *  scheduled away; they have to be survived.
 *
 *  8 gives ~89s (2+4+8+15+15+15+15+15). READS ONLY — writes keep the tight budget on
 *  purpose: a write that cannot land should say so promptly rather than hold a run open
 *  on a retry ladder. The job timeout is the backstop for NOAN being down rather than
 *  merely busy. */
export const SWEEP_RETRIES = 8;

async function sweepOnce(path) {
  const items = [];
  let totalItems = null;
  const startPage = parseInt((path.match(/[?&]page=(\d+)/) || [])[1] || "1", 10) || 1;
  for (let page = startPage, guard = 0; guard < 50; page++, guard++) {
    const res = await call("GET", pageUrl(path, page), null, { retries: SWEEP_RETRIES });
    if (totalItems == null && typeof res?.meta?.totalItems === "number") totalItems = res.meta.totalItems;
    items.push(...(res?.items || []));
    if (!hasNextPage(res)) break;
  }
  return { items, totalItems };
}

/** A union pass restarts from page 1 at a different size. */
const withPerPage = (path, n) => withParam(path, "per_page", n, { drop: ["page"] });

/** Read every page of a list endpoint — the query filter included, on every page
 *  (see sweepOnce: the API's own next link loses it).
 *
 *  Two defects this works around, both in GET /contacts and both silent (a known pagination bug in the API):
 *
 *  1. THE ROWS ARE NOT UNIQUE. Pagination runs over a non-deterministic sort with no
 *     tiebreaker, so a single pass at per_page=100 returns fewer rows than the server's own
 *     count — some are DUPLICATES of rows already seen, and as many others never come back.
 *     This function used to hand that array straight back, so every caller silently received
 *     duplicate objects. Now deduped by id.
 *
 *  2. A DIFFERENT ~5% IS MISSED EACH PAGE SIZE. Union across page sizes recovers most of it
 *     (measured 2026-08-26 across 100/75/50/25, which left about 3% still unreachable).
 *
 *  The extra passes only run when the first one comes up short against the server's own
 *  meta.totalItems, so endpoints that paginate correctly — /tasks, /notes, /assets all do —
 *  pay nothing. That check is also the only honest way to know: absence from one sweep is
 *  not evidence a record does not exist.
 *
 *  STILL NOT A CENSUS. The union can remain short, and this returns what it got rather than
 *  throwing — most callers legitimately want best-effort. When completeness MATTERS, pass
 *  { strict: true } to throw instead, or address the record by id, which is unaffected.
 */
export async function noanGetAll(path, { strict = false } = {}) {
  const first = await sweepOnce(path);
  const byId = new Map();
  const add = (rows) => { for (const r of rows) byId.set(r?.id ?? Symbol(), r); };
  add(first.items);

  const total = first.totalItems;
  if (typeof total === "number" && byId.size < total) {
    for (const size of [75, 50, 25]) {
      const pass = await sweepOnce(withPerPage(path, size));
      add(pass.items);
      if (byId.size >= total) break;
    }
  }

  const out = [...byId.values()];
  if (typeof total === "number" && out.length < total) {
    const msg = `noanGetAll(${path}): read ${out.length} of ${total} reported — pagination is lossy (a known API bug), this is a FLOOR not a census`;
    if (strict) throw new Error(msg);
    console.warn(`  warn: ${msg}`);
  }
  return out;
}

/** NOAN rejects a note whose `content` exceeds 25,000 characters — `400 InvalidArguments`,
 *  "content: Too big" — it does NOT truncate. The limit is absent from the OpenAPI spec, and
 *  the project CLAUDE.md points the other way, recommending `POST /notes` with "the full
 *  detail" as the escape hatch for the 2048-char cap on a task's `details`.
 *
 *  This bit the weekly activity report on 2026-09-02. A backlog purge closed
 *  283 long-stale tasks in four minutes, the report enumerated all 355 completions, and the
 *  body came to 25,136 characters. The run died — and it died at the LAST step, after the model
 *  synthesis had already been paid for, so the retry cost the full generation again.
 *
 *  Hence a cap that degrades instead of throwing: an over-long report still lands, truncated at
 *  a line boundary with a marker saying so, and the run completes. A truncated note is a visible
 *  problem someone can fix; a failed run is a silent gap in the record. */
export const NOTE_CONTENT_CAP = 25000;

/** Truncate `content` to fit NOTE_CONTENT_CAP, marking the cut. Returns it unchanged when it
 *  already fits. The marker is reserved out of the budget first, so the result is always
 *  <= NOTE_CONTENT_CAP no matter how long the input was. */
export function capNoteContent(content, label = "note") {
  const s = String(content ?? "");
  if (s.length <= NOTE_CONTENT_CAP) return s;
  const marker = `\n\n[...truncated: this ${label} rendered to ${s.length} characters, over NOAN's ${NOTE_CONTENT_CAP}-character limit for a note. The tail is missing — shorten the report's longest section rather than raising this cap.]`;
  let body = s.slice(0, NOTE_CONTENT_CAP - marker.length);
  const nl = body.lastIndexOf("\n");
  if (nl > body.length - 500) body = body.slice(0, nl);   // prefer a clean line boundary
  return body + marker;
}

/** POST /notes with the content cap enforced. Every report worker posts through this rather
 *  than calling noanPost("/notes", ...) directly — a test upstream asserts
 *  exactly that, because a raw call is the bug: it throws away a finished run over length. */
export async function postNote(body) {
  const original = String(body?.content ?? "");
  const content = capNoteContent(original, body?.title || "note");
  if (content.length !== original.length) {
    console.warn(`  warn: note "${body?.title || "(untitled)"}" truncated ${original.length} → ${content.length} chars to fit NOAN's ${NOTE_CONTENT_CAP}-char note limit`);
  }
  return noanPost("/notes", { ...body, content });
}

/* ---------------- overflow: what a details trim would have deleted ----------
 * Task details cap at 2048 and every append trims to fit. Trimming agent
 * chatter is normal and expected. Deleting something a HUMAN wrote is not,
 * and until 2026-09-11 it happened silently.
 *
 * So when a trim is about to drop a human's [Note], the dropped text is
 * written to a NOAN note FIRST and the note's id goes into the marker that
 * replaces it. The text stops being lost; it moves somewhere with a name.
 *
 * The trigger is deliberately narrow — a human note, not any trim. A busy
 * task sits at the cap for weeks, and posting a note on every append would
 * put hundreds of them on the board, which is how a safety net becomes
 * noise nobody reads. */

/** The marker that cites a preserved note. A full uuid, because GET /notes
 *  has no search and no by-id route (see the API gaps in CLAUDE.md): paging
 *  the list for an exact id is the only way to find it again, and a short
 *  prefix would not survive that. */
/** A human's note, by the fleet-wide [Note] convention. Deliberately a copy
 *  of the site builder's HUMAN_RX rather than an import: that module is
 *  dependency-free on purpose, and noan.mjs importing it would invert the
 *  layering. An overflow test upstream asserts the two agree. */
export const HUMAN_NOTE_RX = /\[Note\]/;

/** externalId → note id, for this process. See postOverflowNote. */
const _overflowSeen = new Map();
/** Short, stable digest of the dropped text; only needs to separate one
 *  trim from another on the same task, not resist anything. */
function _hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export const overflowMark = (noteId) => `[…older notes trimmed → note ${noteId}…]`;
export const OVERFLOW_MARK_RX = /\[…older notes trimmed → note ([0-9a-f-]{36})…\]/;
/** Room to reserve before the id is known; every uuid is the same length. */
export const OVERFLOW_MARK_ROOM = overflowMark("00000000-0000-0000-0000-000000000000").length;

/** Preserve text a details trim is about to delete, as a NOAN note. Returns
 *  the note id, or null when the post failed.
 *
 *  NEVER throws. A failed note must not fail the write that triggered it:
 *  the caller falls back to the plain honest marker, which is exactly the
 *  behaviour before this existed. Losing the safety net is bad; losing the
 *  append as well would be worse. */
export async function postOverflowNote(droppedText, { taskId = null, taskTitle = null, post = postNote, log = console.warn, seen = _overflowSeen } = {}) {
  const text = String(droppedText || "").trim();
  if (!text) return null;
  /* Same task, same dropped text = the same preservation. A retry that
   *  re-runs an append (a re-poll, or a PATCH that failed AFTER this note
   *  landed) would otherwise post a second copy. Mostly self-limiting - once
   *  the PATCH lands the text is gone from the details and cannot be dropped
   *  again - but the failed-PATCH window is real, and duplicates are exactly
   *  what makes a safety net unreadable.
   *
   *  In-process only, and deliberately: `externalId` is set below for
   *  correlation, but it CANNOT be read back to dedupe across runs - GET
   *  /notes has no externalId filter and the Note schema does not even
   *  return the field (see the API gaps in CLAUDE.md). A worker process is
   *  the widest scope a dedupe can actually cover today. */
  const externalId = `overflow:${taskId || "unknown"}:${_hash(text)}`;
  if (seen?.has(externalId)) return seen.get(externalId);
  const title = `Trimmed from task details${taskTitle ? `: ${taskTitle}` : ""}`.slice(0, 200);
  const header = [
    `Preserved ${new Date().toISOString().slice(0, 16).replace("T", " ")} because a task's details reached NOAN's 2048-character cap and this text, including something a human wrote, would otherwise have been deleted.`,
    taskId ? `Task: ${taskId}` : null,
    taskTitle ? `Title: ${taskTitle}` : null,
    "", "--- trimmed from the task ---", "",
  ].filter(v => v !== null).join("\n");
  try {
    const created = await post({ title, content: `${header}${text}`, externalId });
    // Creates nest under the resource name, but that shape is not guaranteed
    // stable — read both, the way every other create in this file does.
    const id = created?.note?.id || created?.id || null;
    if (!id) log(`  warn: overflow note posted but returned no id; the marker will not cite it`);
    if (id) seen?.set(externalId, id);
    return id;
  } catch (e) {
    log(`  warn: could not preserve trimmed details in a note (${e.message}); the text is lost and the marker will say so`);
    return null;
  }
}

/** Verify the key + see identity/scope. */
export async function whoAmI() {
  return noanGet("/me");
}

/* ---------------- tags ---------------- */

/* 5-min TTL (was cache-forever): fine for short-lived Actions workers either
 * way, but RESIDENT processes (the voice servers) held a boot-time snapshot
 * for their whole life — a tag created in the NOAN UI after boot stayed
 * invisible until redeploy (found live 2026-08-06: the Prospect tag). */
let _tagCache = { at: 0, tags: null };
async function allTags() {
  if (_tagCache.tags && Date.now() - _tagCache.at < 5 * 60_000) return _tagCache.tags;
  _tagCache = { at: Date.now(), tags: await noanGetAll("/tags?per_page=100") };
  return _tagCache.tags;
}

/** Find a tag id by (case-insensitive) name, or null. */
export async function findTagId(name) {
  const t = (await allTags()).find(t => (t.name || "").toLowerCase() === name.toLowerCase());
  return t?.id || null;
}

/**
 * Ensure a tag exists and return its id.
 *
 * NOTE: `POST /tags` DOES exist and is not deprecated (confirmed against the
 * live spec 2026-08-31; this comment claimed the opposite until 2026-09-04).
 * This helper still refuses to create one, and that is a policy choice rather
 * than an API limit: a tag is frequently a credential in this fleet — it arms
 * customer-facing automations — so an agent minting one on demand is how the
 * vocabulary drifts and how an automation gets armed by accident. Creating it
 * stays a human decision. (Used only for "needs-human".)
 */
export async function ensureTag(name) {
  const id = await findTagId(name);
  if (id) return id;
  throw new Error(
    `Tag "${name}" does not exist in NOAN. Agents deliberately do not create ` +
    `tags — create it once (NOAN UI, Settings → Tags), then re-run.`
  );
}

/* ---------------- task metadata (readable since API v1.0.0, 2026-07-24) ----------------
 * GET /tasks now embeds tags[] {id,name}, assignees[] {id,name,email} and
 * contacts[] {id,name} on every task. Agents trigger on
 *   trigger tag present  AND  the agent among the assignees
 * — never on the title. The [marker] title convention is retired. */

/** The agent's accepted identity ids — AGENT_IDENTITY_IDS (comma-separated),
 *  else AGENT_IDENTITY_ID; the fleet's VERITY_* names are read as a fallback.
 *  A project may hold more than one: the canonical writing identity and the
 *  identity humans pick in the UI when they assign the agent. `verityIds` is
 *  the historical name every caller uses; `agentIds` is the same function. */
export function verityIds() {
  return agentIdentityIds();
}
export const agentIds = verityIds;

/* ---------- who this process writes as ----------------------------------
 *
 * assertNoanKey and assertNoDowngrade check that a key is PRESENT and in the
 * right SLOT. Neither checks WHOSE it is, and until 2026-09-18 nothing had to:
 * a comment carried `createdByAssistant`, so an agent-authored comment was
 * marked as such by the server whoever's key wrote it.
 *
 * That field is gone. A comment is now attributed to the KEY'S OWNER and
 * nothing else, so `creator.id` is the entire basis on which
 * normalizeComments decides a comment is the agent's own and must not steer
 * it. If a worker posts status comments under a human's key, its own words
 * come back as that human's instruction and reach the approval gates — the
 * exact failure newsletter-approval already had once, when its self-guard was
 * inert (see the note there).
 *
 * A deployment that splits its work across per-category keys (see
 * NOAN_AGENT_API_KEY above) has one NOAN user per key, so "is this key the
 * agent's?" is a question per key, not one for the install. AGENT_IDENTITY_IDS
 * must list every identity that writes. The identity check upstream reports
 * what a given key actually resolves to; run it per key rather than guessing.
 */
let _identityCheck = null;
/** What identity this process's key writes as, and whether we recognise it.
 *  Memoised: one GET /me per process, and a failure is cached too so an
 *  outage costs one call rather than one per write. */
export async function agentIdentityCheck() {
  if (_identityCheck) return _identityCheck;
  let me = null, error = null;
  try { me = await noanGet("/me"); } catch (e) { error = e; }
  const id = me?.identity?.id || null;
  const known = agentIdentityIds();
  _identityCheck = {
    ok: !!(id && known.includes(id)),
    id, email: me?.identity?.email || null, name: me?.identity?.name || null,
    project: me?.project?.name || null, known, error,
  };
  return _identityCheck;
}

/** Refuse to write as someone we cannot confirm is the agent.
 *
 *  Fails CLOSED on an unreachable /me as well as on a mismatch: an unverified
 *  write is the thing being prevented, and "the API was down" is not a reason
 *  to post under an unknown identity. Never prints the key. */
export async function assertAgentIdentity(what = "this write") {
  const c = await agentIdentityCheck();
  if (c.ok) return c;
  if (c.error) {
    throw new Error(
      `Cannot verify the writing identity before ${what}: GET /me failed (${c.error.message}). ` +
      "Refusing to write rather than post under an unconfirmed identity.");
  }
  throw new Error(
    `Refusing ${what}: this key writes as ${c.email || c.id || "an unknown identity"}` +
    `${c.name ? ` ("${c.name}")` : ""}, which is not in AGENT_IDENTITY_IDS [${c.known.join(", ") || "empty"}]. ` +
    "Since 2026-09-18 a task comment is attributed to the key's OWNER and carries no " +
    "agent marker, so a comment written with this key would be read back as that person's " +
    "own words and would reach the approval gates. Fix by pointing the workflow at the " +
    "agent's own key, or by adding this identity to AGENT_IDENTITY_IDS if it IS the agent. " +
    "agents/check-noan-identity.mjs reports what a key resolves to.");
}

let _companyName;   // undefined = not fetched yet; "" = fetched, nothing usable
/** Whose agents these are, for prompts that speak on the company's behalf.
 *  COMPANY_NAME when set; otherwise the workspace's own project name from
 *  GET /me, fetched ONCE per process — a miss is cached too, so a NOAN outage
 *  costs one retry ladder, not one per inbound message. Never a built-in name. */
export async function companyName() {
  const env = (process.env.COMPANY_NAME || "").trim();
  if (env) return env;
  if (_companyName === undefined) {
    try {
      const me = await noanGet("/me");
      _companyName = String(me?.project?.name || "").trim();
    } catch { _companyName = ""; }
  }
  return _companyName || "the company";
}

export function taskHasTag(task, name) {
  return (task?.tags || []).some(t => (t.name || "").toLowerCase() === String(name).toLowerCase());
}

export function taskAssignedToVerity(task) {
  const ids = new Set(verityIds());
  return (task?.assignees || []).some(a => ids.has(a.id));
}

/** The trigger predicate every agent shares: trigger tag AND the agent assigned.
 *  Never a completed task: status and the completed flag are independent in the
 *  API, and completed-but-backlog tasks are real (observed 2026-08-15 in
 *  voice-goals, 2026-08-26 in the voice brief) — acting on one re-runs work a
 *  human already closed. */
export function taskTriggers(task, tagName) {
  return !task?.completed && taskHasTag(task, tagName) && taskAssignedToVerity(task);
}

/* ---------------- task idempotency ---------------- */

/** Every task, fetched at most ONCE per process and deduped by id.
 *
 *  The API does not enforce externalId uniqueness, so "have I already filed
 *  this?" is an explicit lookup — and a board of any size is several pages, so a
 *  caller that checks per item would re-page the whole board every time.
 *
 *  Deduped because noanGetAll does not: paginated task fetches have been
 *  observed returning the same row twice (the board sweep dedupes for the
 *  same reason). A sweep can also MISS a row, so a "not found" here is not
 *  proof — this guard makes duplicate filing rare, it cannot make it
 *  impossible. Callers must stay safe to run twice.
 */
let _taskCache = null;
export async function allTasksOnce() {   // per PROCESS RUN — never invalidated
  if (!_taskCache) {
    const fetched = await noanGetAll(`/tasks?per_page=100`);
    _taskCache = [...new Map(fetched.map(t => [t.id, t])).values()];
  }
  return _taskCache;
}

/** Record a task this process just created, so a second check in the same run
 *  sees it without another fetch.
 *
 *  Takes the externalId rather than trusting the create response to echo it.
 *  The OpenAPI spec says POST /tasks returns a full Task including externalId,
 *  but the spec and the API have already diverged on exactly this field
 *  elsewhere — POST /notes accepts externalId and the read shape never returns
 *  it. If the echo were ever missing, the cached row would carry no externalId,
 *  findTaskByExternalId would not match it, and this helper would silently stop
 *  doing the one thing it exists for. */
export function rememberTask(task, externalId = null) {
  if (!_taskCache || !task?.id) return;
  _taskCache.push(task.externalId ? task : { ...task, externalId });
}

/** Existing task carrying this externalId, or null. */
export async function findTaskByExternalId(ext) {
  return (await allTasksOnce()).find(t => t.externalId === ext) || null;
}

/** Like findTaskByExternalId, but ignoring allTasksOnce's per-process cache.
 *
 *  For a LONG-LIVED service: that cache is
 *  never invalidated, so in a process that has been up for hours it answers from
 *  a snapshot taken at startup - which is exactly the wrong answer for "did a
 *  previous attempt already file this?".
 *
 *  It pages the whole board, because NOAN offers no way to ask. GET
 *  /tasks?externalId=... is not rejected: the parameter is ignored and the
 *  entire board comes back at HTTP 200 (verified live 2026-09-18 - 1,509 items
 *  for a one-task query). So this is deliberately not something to call on a
 *  happy path; call it where a retry is already known to be in progress. */
export async function findTaskByExternalIdFresh(externalId) {
  return (await noanGetAll(`/tasks?per_page=100`)).find(t => t.externalId === externalId) || null;
}

/**
 * Create a task only if one with this externalId is not already there.
 *
 * WHY THIS EXISTS, and why an externalId alone is not enough. NOAN does not
 * enforce uniqueness on externalId and offers no way to query by it: GET
 * /tasks?externalId=... is not rejected, it silently returns the WHOLE board
 * (verified live 2026-09-18, 1,509 items back for a one-task query). So the key
 * is a label until somebody reads it, and the only read available is paging the
 * board.
 *
 * That is not a theoretical gap. A sweep of the live board on 2026-09-18 found
 * 49 duplicate tasks across 22 externalIds - every one of them carrying the key
 * that was supposed to prevent it. The PR weekly sweep kept recommending "carry
 * an externalId on new write paths", and it would have prevented none of them:
 * the missing half was always the lookup.
 *
 * Use this where a create can genuinely be retried for the same logical event -
 * a cron that may run twice, an HTTP handler a client may call again, a queue
 * item whose work was abandoned mid-flight. Do NOT reach for it reflexively: a
 * create already guarded by a state ledger, or one whose externalId is a label
 * rather than an identity (social posts carry social:<date>:<pillar> and there
 * are up to ten a day, by design), does not need it and pays a board scan for
 * nothing.
 *
 * `fresh` decides which board it reads. The default uses allTasksOnce's
 * per-process cache, which is right for a cron worker that starts, runs and
 * exits. A LONG-LIVED service must pass fresh: true - that cache is never
 * invalidated, so an hours-old snapshot would miss exactly the task the retry
 * is looking for.
 *
 * @returns {{task: object, created: boolean, id: string}} - `created: false`
 *          means one was already there and nothing was written.
 */
export async function createTaskOnce(body, { fresh = false, log = () => {} } = {}) {
  const externalId = body?.externalId;
  if (!externalId) throw new Error("createTaskOnce needs an externalId - without one there is nothing to dedupe on");

  const existing = fresh
    ? await findTaskByExternalIdFresh(externalId)
    : await findTaskByExternalId(externalId);
  if (existing) {
    log(`  task ${externalId} already exists (${existing.id}) - not creating a second`);
    return { task: existing, created: false, id: existing.id };
  }

  const created = await noanPost("/tasks", body);
  // Both shapes: creates nest under the resource name, but that is documented
  // nowhere and is not guaranteed stable.
  const id = created?.task?.id || created?.id;
  if (!id) throw new Error(`POST /tasks returned no task id for ${externalId}`);
  const task = { ...(created?.task || created), id };
  rememberTask(task, externalId);
  return { task, created: true, id };
}

/* ---------------- a "note on the task" goes into details ----------------
 * There is no POST /tasks/{id}/notes. It 404s from Express's default handler
 * (verified live 2026-09-10), and there is no GET /tasks/{id} either. Every
 * worker that "left a note on the task" through that route, wrapped in a
 * catch, was writing nothing: the note vanished and the run carried on as if
 * it had landed. Task comments are readable (task-comments.mjs) but have no
 * write route yet. So a note is an entry appended to `details`, the way the
 * general agent has done it since the 2048 cap was found. PATCH replaces the
 * whole field, so the append starts from the text in hand and compacts to
 * the cap. These live here, not in the general agent's tools, so grants, missions
 * and the task worker can import them without pulling in the whole belt.
 * A test upstream fails CI on any return to the dead route. */

/** Em dashes never reach a NOAN write (house style, and the model's tell). */
export function sanitizeCopy(s) {
  return String(s ?? "").replace(/\s*[—―]\s*/g, " - ");
}

/** NOAN caps task details at 2048 chars (API-enforced, rejected not
 *  truncated; discovered in rehearsal). Compaction keeps the head (the
 *  requester's original brief) and the newest tail, and trims the middle.
 *
 *  NARROWED 2026-09-19. The agent's own status notes are comments now
 *  (postTaskComment), which have a 25,000 cap and no trim, so nothing routine
 *  lands here any more. What is left writing to `details` is exactly two kinds
 *  of thing, and both are the reason this compaction is worth its complexity:
 *
 *    - a person's words the agent is CARRYING — the `[Note]` relays in
 *      the reply and voice relays. fitDetailsPreserving exists
 *      for these: a human [Note] on its way out of the middle is rescued into
 *      a note first rather than vanishing.
 *    - an ASK, whose answer is read straight back out of `details` by
 *      newTextSince(task.details, askSnapshot) — the only grant-creating path.
 *
 *  So the cap now guards human text almost exclusively. Before adding a caller,
 *  ask which of those two it is; if it is neither, it is a status note and
 *  belongs in a comment. A sweep upstream enforces that; this pack does not ship it. */
export const DETAILS_MAX = 2000;

/** How much of ONE append survives when the details have to be compacted. Not
 *  a limit on what you may write — an entry that fits is never touched (see
 *  planDetails) — but a budget: it bounds how much of the prior middle a single
 *  append can push out. Named because it is referenced from three places, and a
 *  warning quoting a stale number is worse than no warning. */
export const ENTRY_MAX = 900;

/** The same compaction, as data: the text, plus the slice of `prior` that
 *  fell out of the middle. Pure — the caller decides whether the dropped
 *  text is worth preserving (planDetails is what appendTaskDetails uses to
 *  spot a human [Note] on its way out). `mark` is injectable so a marker
 *  citing a preserved note can take the place of the plain one. */
export function planDetails(prior, entry, { mark = "[...trimmed...]" } = {}) {
  const whole = String(entry);
  prior = String(prior || "");

  // The fits-check comes FIRST. The ENTRY_MAX cap below is a budget for
  // compaction — it bounds how much of the middle a single append can push out
  // — and applying it before knowing whether compaction is needed truncated
  // notes that would have fitted with room to spare. A 1,176-char handoff
  // landed as 862 chars mid-sentence on 2026-09-18 into details that finished
  // at 1,713 of 2,000, and the part lost was the "what is NOT done" section at
  // the end. Nothing had to be dropped at all.
  const full = prior ? `${prior}\n\n${whole}` : whole;
  if (full.length <= DETAILS_MAX) return { out: full, dropped: "", entryTrimmed: false };

  entry = whole.slice(0, ENTRY_MAX);   // the parameter, reused: the compaction budget
  const next = prior ? `${prior}\n\n${entry}` : entry;
  if (next.length <= DETAILS_MAX) return { out: next, dropped: "", entryTrimmed: entry.length < whole.length };

  /* Both cuts snap to a BLOCK boundary. A raw character offset splits
   * whatever sits across it, and the way that fails is silent and specific:
   * a [Note] straddling the head boundary leaves its "[Note]" marker in the
   * head and its sentences in the dropped slice, so the overflow check below
   * sees no human note and drops the body with nothing preserved. Found by
   * the overflow fixture upstream, which is why that fixture puts
   * a note exactly there. Snapping can only shrink head and tail, never grow
   * them, so the cap maths stays safe. */
  const snapBack = (s) => { const i = s.lastIndexOf("\n\n"); return i > 0 ? s.slice(0, i) : s; };
  const snapFwd = (s) => { const i = s.indexOf("\n\n"); return i >= 0 ? s.slice(i + 2) : s; };

  const head = snapBack(prior.slice(0, 700));
  const tailBudget = DETAILS_MAX - head.length - entry.length - mark.length - 4;
  const tail = tailBudget > 60 ? snapFwd(prior.slice(-tailBudget)) : "";
  const dropped = prior.slice(head.length, tail ? prior.lastIndexOf(tail) : prior.length).trim();
  return { out: `${head}\n${mark}\n${tail}\n\n${entry}`.slice(0, DETAILS_MAX + 48), dropped,
           entryTrimmed: entry.length < whole.length };
}

export function fitDetails(prior, entry) {
  return planDetails(prior, entry).out;
}

/** fitDetails, except that when the trim would delete something a HUMAN wrote,
 *  the dropped text is preserved in a NOAN note first and the marker cites its
 *  id. Returns { details, noteId }.
 *
 *  `entry` is used VERBATIM — no author stamp — because the callers that most
 *  need this are recording a human's OWN words: reply-worker writes
 *  "[Note] Reply from <email>" for an emailed answer, slack-worker writes
 *  "[Note] <email> in Slack" for a thread reply. Those two are how most human
 *  [Note] text reaches a task in the first place, and they trimmed without
 *  any protection until 2026-09-11.
 *
 *  Only a human [Note] triggers a note; routine agent chatter does not, or a
 *  task at the cap would spawn one per append. A failed preserve falls back to
 *  the plain marker rather than failing the write. */
export async function fitDetailsPreserving(prior, entry, { preserve = postOverflowNote, taskId = null, taskTitle = null } = {}) {
  const plan = planDetails(prior, entry);
  const trimmed = plan.entryTrimmed;
  if (!preserve || !plan.dropped || !HUMAN_NOTE_RX.test(plan.dropped)) return { details: plan.out, noteId: null, entryTrimmed: trimmed };
  const noteId = await preserve(plan.dropped, { taskId, taskTitle });
  if (!noteId) return { details: plan.out, noteId: null, entryTrimmed: trimmed };
  return { details: planDetails(prior, entry, { mark: overflowMark(noteId) }).out, noteId, entryTrimmed: trimmed };
}

const detailsStamp = () => new Date().toISOString().slice(0, 16).replace("T", " ");
const agentName = () => defaultAgentName();

/** One task by id, or null. There is no GET /tasks/{id}: page the status
 *  lists, in-progress first (where a worker's own task usually is), then
 *  backlog, then done. Each list is swept whole, so a task past the first
 *  page of `done` is still found. */
export async function findTaskById(taskId) {
  for (const st of ["in-progress", "backlog", "done"]) {
    const rows = await noanGetAll(`/tasks?per_page=100&status=${st}`);
    const hit = rows.find(t => t.id === taskId);
    if (hit) return hit;
  }
  return null;
}

/** Append a note entry to a task ALREADY IN HAND. No re-read: the task's own
 *  `details` is the base, compacted to the cap, written back in one PATCH.
 *  `task.details` is updated in place so a second append in the same run
 *  builds on the first instead of clobbering it.
 *
 *  Only for the object the poll returned, BEFORE anything else in the run
 *  has written to the task. Two ways to get that wrong, both of which put a
 *  stale base on the board: (1) after the model loop, where the model may
 *  have appended via noan_add_task_note (appendTaskNote below, a re-read
 *  PATCH) — use appendTaskNote(task.id, ...) there; (2) a working copy such
 *  as the belt's ctx.task, whose details carry the standing-grant lines
 *  re-presented for the model — those must never be written back.
 *
 *  Throws on a failed write; the caller decides whether a lost note is
 *  fatal, and a catch around it must at least log. `patch` is injectable
 *  for tests. */
export async function appendTaskDetails(task, text, { author = agentName(), patch = noanPatch, preserve = postOverflowNote } = {}) {
  if (!task?.id) throw new Error("appendTaskDetails: no task id");
  const prior = task.details || "";
  const entry = `[${author} ${detailsStamp()}] ${sanitizeCopy(text)}`;
  // The compaction trims the MIDDLE of the prior details. Agent chatter going
  // that way is routine; a human's [Note] going that way is the silent loss
  // fixed on 2026-09-11. When one is on its way out, preserve
  // the dropped slice in a note first and cite it in the marker.
  const { details: next, entryTrimmed } = await fitDetailsPreserving(prior, entry, { preserve, taskId: task.id, taskTitle: task.title });
  // Two different events, and only one of them is routine. `trimmed` has always
  // meant "something got shorter", which is the normal compaction of old
  // chatter. `entryTrimmed` means THE TEXT YOU JUST WROTE was cut - a caller
  // that cannot tell them apart cannot know its handoff lost its ending.
  if (entryTrimmed) {
    console.warn(`  warn: the note appended to task ${task.id} was cut to ${ENTRY_MAX} chars to fit; `
      + `${entry.length - ENTRY_MAX} char(s) were dropped from its END. Post the long form with postNote() and cite the note id.`);
  }
  await patch(`/tasks/${task.id}`, { details: next });
  task.details = next;
  return { appended: true, taskId: task.id, details: next, entryTrimmed: !!entryTrimmed,
           trimmed: next.length < prior.length + entry.length };
}

/** Read-append-verify by task id, for callers that hold only the id. Re-reads
 *  the task (a stale copy would wipe a teammate's edits on write-back),
 *  appends with cap compaction, and verifies the brief's head survived. */
export async function appendTaskNote(taskId, text, { author = agentName() } = {}) {
  const task = await findTaskById(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  const prior = task.details || "";
  const r = await appendTaskDetails(task, text, { author });
  const verify = await noanGetAll(`/tasks?per_page=100&status=${task.status || "backlog"}`);
  const after = verify.find(t => t.id === taskId);
  if (after && prior && !(after.details || "").includes(prior.slice(0, 120))) {
    throw new Error(`task ${taskId} description verify failed — the brief's head is missing after append`);
  }
  return { appended: true, taskId, trimmed: r.trimmed, entryTrimmed: r.entryTrimmed };
}

/** Post a comment on a task — the ONLY way the fleet writes one.
 *
 *  Comments are appended and never replace each other, so unlike a `details`
 *  entry this needs no read-modify-write and cannot trim anyone's text. The
 *  cap is 25,000 characters (12x `details`), and the API rejects rather than
 *  truncates, so an over-long body is shortened here at a line boundary with
 *  a visible marker — same contract as postNote().
 *
 *  Every comment goes out MARKED as the agent's own (agent-comment.mjs), which
 *  is what stops the next poll reading it back as a human's instruction. The
 *  marker is load-bearing, not decoration: a comment is attributed to the owner
 *  of the key that posted it, and in a deployment running under a person's key
 *  the author says nothing about who actually wrote it.
 *
 *  Refuses to post when neither safeguard is available — no signing secret AND
 *  a key that is not one of the agent's own identities — because that comment
 *  would come back as steering from whoever owns the key, and would count
 *  toward the approval gates. Fail closed; a lost status note is cheap.
 */
export async function postTaskComment(taskId, body, { name = agentName() } = {}) {
  if (!taskId) throw new Error("postTaskComment: no task id");
  // An unsigned comment is still a MARKED comment (agent-comment-marker.json),
  // so a missing secret costs tamper-detection, not recognition — and a
  // downstream install that never sets one still gets safe comments. Worth
  // saying out loud, since the signature is what catches a forged marker.
  if (!commentSecret()) {
    console.warn("postTaskComment: AGENT_COMMENT_SECRET is not set — comments are marked but unsigned, and cannot be verified");
  }
  // Trim the BODY, then sign — never the other way round. Signing first and
  // fitting after slices the signature line off any over-cap comment, and an
  // unmarked agent comment is read back as teammate steering: the one outcome
  // this whole mechanism exists to prevent.
  const text = buildAgentComment(fitComment(String(body ?? ""), COMMENT_MAX - markerOverhead(name)), taskId, { name });
  // Belt and braces, and deliberately not specific to the bug above: if ANY
  // path ever yields an unmarked comment, it must not reach the board.
  if (!hasAgentMarker(text) && !(await agentIdentityCheck()).ok) {
    throw new Error("postTaskComment: refusing to post an UNMARKED comment — it would be read back as the key owner's own words");
  }
  const created = await noanPost(`/tasks/${taskId}/comments`, { content: text });
  return created?.comment || created;
}

/** The comment character cap, and the trim that keeps a run alive when a body
 *  runs past it. Rejected outright by the API above this, never truncated. */
export const COMMENT_MAX = 25000;
export function fitComment(text, max = COMMENT_MAX) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const marker = "\n[…trimmed to the comment character cap]";
  const keep = s.slice(0, max - marker.length);
  const cut = keep.lastIndexOf("\n");
  return (cut > max / 2 ? keep.slice(0, cut) : keep) + marker;
}

/** Merge tags onto a task (PUT replaces the set, so send union of what's there). */
export async function addTaskTags(task, ...tagNames) {
  const ids = new Set((task.tags || []).map(t => t.id));
  for (const name of tagNames) {
    const id = await findTagId(name);
    if (id) ids.add(id);
    else console.warn(`noan: tag "${name}" not found — skipped`);
  }
  await noanPut(`/tasks/${task.id}/tags`, { tagIds: [...ids] });
}

/** Merge contacts onto a task (PUT replaces the set, so send union of what's there).
 *
 *  Same read-union-PUT shape as addTaskTags/assignVerity, and it exists for the
 *  same reason: /tasks/{id}/contacts is a full-set replacement, so a bare PUT
 *  silently drops every link already on the task. There is no GET /tasks/{id},
 *  so `task.contacts` is the only view of the current set — pass a task object
 *  from a list read or a create, not a stub built from an id. */
export async function addTaskContacts(task, ...contactIds) {
  const ids = new Set((task.contacts || []).map(c => c.id));
  for (const id of contactIds) if (id) ids.add(id);
  await noanPut(`/tasks/${task.id}/contacts`, { contactIds: [...ids] });
}

/** Add the agent's canonical identity to a task's assignees, preserving humans. */
export async function assignVerity(task) {
  const canonical = agentIdentityId();
  if (!canonical) return;
  const ids = new Set((task.assignees || []).map(a => a.id));
  ids.add(canonical);
  await noanPut(`/tasks/${task.id}/assignees`, { assigneeIds: [...ids] });
}

/** Add identities to a task's assignees, PRESERVING everyone already on it.
 *
 *  The claim-side mirror of the bug parkForHuman exists to stop. PUT
 *  /tasks/{id}/assignees replaces the whole set, so `assigneeIds: [me]` on a
 *  task that came off the board removes whoever else was on it — and the
 *  fleet's shared trigger predicate (taskTriggers: trigger tag AND the agent
 *  assigned) selects exactly the tasks a human has handed back by re-assigning
 *  the agent in the UI. A human who hands their own task back and stays on it was
 *  silently dropped from it by the worker's claim() until 2026-09-13, which is
 *  invisible from their side: the task simply stops being theirs.
 *
 *  Unlike assignVerity this decides nothing about WHO — each caller keeps its
 *  own identity constant (AGENT_IDENTITY_ID, a reviewer list, a resolved
 *  owner). It only guarantees the write is an addition rather than a
 *  replacement, the same contract addTaskTags and addTaskContacts already give
 *  for the other two full-replacement endpoints.
 *
 *  Base is the task IN HAND, no re-read — same convention as parkForHuman and
 *  appendTaskDetails.
 *
 *  ALWAYS returns who is on the task afterwards, whether or not a PUT was sent
 *  — a caller asking "is this person on it now" gets the same answer either
 *  way, which an empty return for the already-present case did not give
 *  (a review finding). The PUT is skipped when nothing would change: re-writing
 *  an unchanged set is a wasted call, and on this endpoint every write is a
 *  chance to lose someone. */
export async function addTaskAssignees(task, ...ids) {
  if (!task?.id) throw new Error("addTaskAssignees: no task id");
  const have = new Set((task.assignees || []).map(a => a.id).filter(Boolean));
  const next = new Set(have);
  for (const id of ids) if (id) next.add(id);
  const assigneeIds = [...next];
  if (next.size === have.size) return assigneeIds;
  await noanPut(`/tasks/${task.id}/assignees`, { assigneeIds });
  return assigneeIds;
}

/** Remove every agent identity from a task's assignees, preserving humans.
 *  Unassigned-but-tagged is the "waiting on a human / awaiting confirm" state:
 *  re-assigning the agent in the UI hands the task back to it. */
export async function unassignVerity(task) {
  const ids = new Set(verityIds());
  const keep = (task.assignees || []).map(a => a.id).filter(id => !ids.has(id));
  await noanPut(`/tasks/${task.id}/assignees`, { assigneeIds: keep });
}

/* ---------------- parking a task for a human ----------------
 *
 * "Parked" is the fleet's hand-back state: the task carries `needs-human`,
 * the agent is off the assignees, and re-assigning it is the retry. Until
 * 2026-09-10 roughly twenty files hand-rolled that as tag + unassign and
 * NOBODY was added, so a parked task had no human on it and the only thing
 * that ever read the tag back was the weekly board sweep. The board that day:
 * 16 open needs-human tasks, 14 with no human assignee — eight site-preview
 * parks and four support escalations the CS owner had only been emailed about.
 *
 * parkForHuman() is the one place the park is written (a source-read test,
 * a test upstream fails CI on a raw needs-human write elsewhere) and
 * it ALWAYS leaves a human on the task. Who, in order:
 *
 *   1. `assignees` passed explicitly (an agent with its own pinned list, e.g.
 *      CI_ALERT_ASSIGNEES, REPLY_HUMAN_ASSIGNEES) — used as given;
 *   2. the REQUESTER, when the caller knows one and it maps to a workspace
 *      identity through HUMAN_IDENTITIES ("email=id,email=id"). The person
 *      who asked for the work is the person who unparks it;
 *   3. PARK_ASSIGNEES_<AGENT> — a per-agent override, `agent` upper-cased
 *      with "-" → "_" (PARK_ASSIGNEES_SITE_BUILDER);
 *   4. PARK_ASSIGNEES_<LANE> — the lane default: CS, SALES and ENG each
 *      have an owner;
 *   5. PARK_ASSIGNEES_ENG as the last resort, logged loudly, because a task
 *      parked to nobody is the failure this exists to end. Refusing to park
 *      would be worse: the agent would stay assigned and the worker would retry
 *      the same guard every poll.
 *
 * Identity ids are raw: no API resolves one from an email, so
 * HUMAN_IDENTITIES is maintained by hand from
 * live task assignees. Never derive an assignee from GET /me — that is the
 * key's account, not a person.
 *
 * Tags and assignees are merged, never replaced: the trigger tag stays (that
 * is what makes re-assign a retry) and any human already on the task stays.
 * Every step is fail-soft — a park runs at the END of a failed path and must
 * not throw the worker out of its loop — and the result says what landed.
 */

export const PARK_TAG = "needs-human";

export const PARK_LANES = ["cs", "sales", "eng"];

/** The inverse of the tag half of parkForHuman: drop needs-human from a task
 *  that is being worked again (a human re-assigned the agent, or a comment
 *  re-armed it). PUT replaces the set, so the remainder is written from the
 *  task object in hand — pass one from this poll's list read, the only view
 *  of the current set (there is no GET /tasks/{id}). No-op when the tag is
 *  not there. Mutates task.tags to match, so a later merge in the same poll
 *  does not re-add it from a stale copy. Returns true when a PUT was made. */
export async function unparkTask(task) {
  if (!taskHasTag(task, PARK_TAG)) return false;
  const keep = (task.tags || []).filter(t => String(t.name || "").toLowerCase() !== PARK_TAG);
  await noanPut(`/tasks/${task.id}/tags`, { tagIds: keep.map(t => t.id) });
  task.tags = keep;
  return true;
}

function parseIdList(v) {
  return String(v || "").split(",").map(s => s.trim()).filter(Boolean);
}

/** HUMAN_IDENTITIES="someone@example.com=53f6…,other@example.com=e64f…" → Map(email → id). */
export function humanIdentities(env = process.env) {
  const m = new Map();
  for (const pair of String(env.HUMAN_IDENTITIES || "").split(",")) {
    const i = pair.indexOf("=");
    if (i < 1) continue;
    const email = pair.slice(0, i).trim().toLowerCase();
    const id = pair.slice(i + 1).trim();
    if (email && id) m.set(email, id);
  }
  return m;
}

/** Workspace identity id for a human's email, or null. The agent's own addresses
 *  never resolve: it is not a human, whatever HUMAN_IDENTITIES says. */
export function humanIdentityFor(email, env = process.env) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const id = humanIdentities(env).get(e) || null;
  if (id && verityIds().includes(id)) return null;
  return id;
}

/** The requester a task names in its own details: a `Notify:` line wins,
 *  then `Requested by <email>`. Null when neither is there — callers that
 *  need a fallback add their own (the general agent's GENERAL_NOTIFY is for the
 *  report email, not for who owns a park). */
export function taskRequesterEmail(task) {
  const d = String(task?.details || "");
  const notify = d.match(/^Notify:\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/mi);
  if (notify) return notify[1].toLowerCase();
  const reqBy = d.match(/Requested by\s+([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  if (reqBy) return reqBy[1].toLowerCase();
  return null;
}

/** Who a park goes to, and why. Pure: no API, no side effects. */
export function resolveParkAssignees({ lane, agent, requesterEmail = null, assignees = null } = {}, env = process.env) {
  // An explicit list wins - but never lets the agent through as "the human".
  // Parking a task to the agent that just gave up on it is not a hand-back,
  // and nothing downstream would catch it: the task would carry needs-human
  // and an assignee, so every "handed to nobody" check would pass.
  if (Array.isArray(assignees)) {
    const self = new Set(verityIds());
    const explicit = assignees.filter(a => a && !self.has(a));
    if (explicit.length) return { ids: explicit, source: "explicit" };
  }
  const req = humanIdentityFor(requesterEmail, env);
  if (req) return { ids: [req], source: `requester ${String(requesterEmail).toLowerCase()}` };
  if (agent) {
    const key = `PARK_ASSIGNEES_${String(agent).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    const ids = parseIdList(env[key]);
    if (ids.length) return { ids, source: key };
  }
  const ln = String(lane || "").toLowerCase();
  if (ln && !PARK_LANES.includes(ln)) console.warn(`noan: parkForHuman lane "${lane}" is not one of ${PARK_LANES.join("/")} — using the ENG fallback`);
  if (PARK_LANES.includes(ln)) {
    const ids = parseIdList(env[`PARK_ASSIGNEES_${ln.toUpperCase()}`]);
    if (ids.length) return { ids, source: `PARK_ASSIGNEES_${ln.toUpperCase()}` };
  }
  const eng = parseIdList(env.PARK_ASSIGNEES_ENG);
  if (eng.length) return { ids: eng, source: "PARK_ASSIGNEES_ENG (fallback)" };
  return { ids: [], source: "none" };
}

/**
 * Park `task` for a human. Merges `needs-human` onto its tags, optionally
 * moves it to `status`, then writes the assignee set ONCE: the humans already
 * on it, minus every agent identity when `unassign` is true, plus the human
 * resolved above. Pass a task object from a list read or a create — PUT
 * replaces the set and there is no GET /tasks/{id}, so `task.tags` and
 * `task.assignees` are the only view of what is there (a fresh create can
 * pass `{ id, tags: [], assignees: [] }`).
 *
 * `unassign: false` keeps the agent on the task — the "flagged, still assigned,
 * worker retries" shape slack-approvals uses —
 * and still adds the human, so somebody sees a send that keeps failing.
 *
 * `extraTags` ride along in the same tag PUT — a freshly created task that
 * also needs its lane tag ("customer success") must not make two merge
 * calls from a stale `tags: []`, because the second would drop the first.
 *
 * Returns { tagged, status, assigned: [ids], source, errors: [] }. Never
 * throws. `dryRun` resolves and logs, writes nothing.
 */
export async function parkForHuman(task, {
  lane = null, agent = null, reason = "", requesterEmail = null, assignees = null,
  unassign = true, status = "backlog", extraTags = [], dryRun = false, log = console.log,
} = {}) {
  const out = { tagged: false, status: null, assigned: [], source: "none", notifiedSlack: false, errors: [] };
  if (!task?.id) { out.errors.push("no task id"); return out; }
  const who = resolveParkAssignees({ lane, agent, requesterEmail, assignees });
  out.source = who.source;
  if (!who.ids.length) {
    console.warn(`noan: parkForHuman ${task.id} — NO HUMAN RESOLVED (lane=${lane || "-"}, agent=${agent || "-"}, requester=${requesterEmail || "-"}); set PARK_ASSIGNEES_ENG so a park is never unowned`);
  }
  const label = `${agent || lane || "park"}`;
  if (dryRun) {
    log(`  dry-run: would park ${task.id} needs-human${status || !task.status ? ` → ${status || "backlog"}` : ""}, ${unassign ? `${defaultAgentName()} unassigned, ` : ""}assign ${who.ids.join(",") || "nobody"} (${who.source})${reason ? ` — ${String(reason).slice(0, 120)}` : ""}`);
    return out;
  }
  try { await addTaskTags(task, PARK_TAG, ...extraTags); out.tagged = true; }
  catch (e) { out.errors.push(`tag: ${e.message}`); log(`  warn: [${label}] could not tag needs-human on ${task.id}: ${e.message}`); }
  /* `status: null` from a caller means "leave it where it is" - a wound-down
   * in-progress task should stay in-progress, not slide back to backlog.
   *
   * But a park is BY DEFINITION waiting on a human, and on this board a task
   * with no status is waiting on nobody: that is what null status is reserved
   * for, and the only thing it means (decided 2026-09-11). So parking a task
   * that is in no column puts it in backlog -
   * otherwise the park is invisible to every ?status= query, including the
   * board sweep that exists to find neglected parks. A hand-made Site Build
   * task was the case that surfaced it: six site-builder call sites pass
   * status:null, and any of them could park a column-less task into silence. */
  const wanted = status || (task.status ? null : "backlog");
  if (wanted) {
    try { await noanPatch(`/tasks/${task.id}`, { status: wanted }); out.status = wanted; }
    catch (e) { out.errors.push(`status: ${e.message}`); log(`  warn: [${label}] could not move ${task.id} to ${wanted}: ${e.message}`); }
  }
  const verity = new Set(verityIds());
  const keep = (task.assignees || []).map(a => a.id).filter(id => id && (!unassign || !verity.has(id)));
  const next = [...new Set([...keep, ...who.ids])];
  try {
    await noanPut(`/tasks/${task.id}/assignees`, { assigneeIds: next });
    out.assigned = next;
  } catch (e) { out.errors.push(`assignees: ${e.message}`); log(`  warn: [${label}] could not write assignees on ${task.id}: ${e.message}`); }
  /* A task born in a Slack thread is answered IN that thread. Until
   * 2026-09-11 only the general lane knew that: delegation wrote the pointer into a
   * delegated child's details, and the general agent was the only reader, so a
   * child carrying a specialist tag (deck, demo, social, site-build) was
   * worked by a lane with no Slack notion and parked by EMAIL while the
   * requester sat in the thread waiting.
   *
   * It goes here because parkForHuman is already the one door every park
   * goes through - the same reason the assignee step lives here. A lane does
   * not have to know about Slack to answer where it was asked.
   *
   * The email is NOT replaced. The thread is where the REQUESTER is waiting;
   * the park's owner may be someone else entirely who is not in it. That is
   * the fleet's existing answer (the general agent keeps email as a backstop
   * until SLACK_ONLY_NOTIFY=1, a staged flip) and this follows it rather
   * than inventing a second convention.
   *
   * Fail-soft, like every other step here: no token, no pointer, or a Slack
   * error costs the park nothing. */
  out.notifiedSlack = await notifyParkThread(task, { reason, agent: agent || lane, assigned: out.assigned, log });

  log(`  parked ${task.id} for a human (${who.source}${reason ? `; ${String(reason).slice(0, 100)}` : ""})${out.notifiedSlack ? " — and told the Slack thread" : ""}`);
  return out;
}

/** Tell the originating Slack thread that its task is now waiting on a human.
 *  Returns false for every reason not to: no pointer (not from Slack), no
 *  token (this lane's workflow carries none), or the post failed. */
async function notifyParkThread(task, { reason, agent, assigned, log = console.log } = {}) {
  let ptr = null;
  try {
    const { slackPointerFrom, slackConfigured } = await import("./slack-pointer.mjs");
    if (!slackConfigured()) return false;
    ptr = slackPointerFrom(task);
  } catch { return false; }
  if (!ptr) return false;
  try {
    const { postThread } = await import("./slack.mjs");
    const who = assigned?.length ? "It is on a human now" : "Nobody is on it yet";
    await postThread(ptr.channel, ptr.ts, [
      `I have parked this one for a human${agent ? ` (${agent})` : ""}.`,
      reason ? `Why: ${String(reason).slice(0, 400)}` : null,
      `${who}. Re-assign me on the task once it is sorted and I will pick it up.`,
    ].filter(Boolean).join("\n"));
    return true;
  } catch (e) { log(`  warn: could not tell the Slack thread about the park: ${e.message}`); return false; }
}

/**
 * Put a human on a task that was just created, resolved exactly the way a
 * park is (requester → per-agent → lane → ENG).
 *
 * A task nobody is on is a task nobody sees: it appears in no one's list and
 * sends no notification, so "a human will triage it" quietly means nobody
 * does. On 2026-09-11, 33 of 115 open tasks had no assignee — every one of
 * them a deliberate choice made before parkForHuman existed, each reasoning
 * the same way in a different file.
 *
 * The rule is now: every created task has a human, UNLESS the agent is assigned
 * (it is working it) or it is one of two documented resting states — a
 * pipeline record, or a fact candidate the Monday run consumes and closes
 * either way. A test upstream holds that line.
 *
 * FOR A TASK YOU JUST CREATED. The write is PUT /tasks/{id}/assignees, which
 * REPLACES the whole set - it cannot merge with assignees it has not read.
 * On a fresh task that is exactly right and saves a read; on a task that may
 * already carry someone, pass their ids as `keep` or you will silently
 * remove them. Every caller today creates the task two lines above.
 *
 * Fail-soft like parkForHuman: a task that exists unassigned is better than a
 * thrown worker, and the result says what landed. */
export async function assignResolvedOwner(taskId, { lane = null, agent = null, requesterEmail = null, assignees = null, keep = [], log = console.log } = {}) {
  const out = { assigned: [], source: "none", errors: [] };
  if (!taskId) { out.errors.push("no task id"); return out; }
  const who = resolveParkAssignees({ lane, agent, requesterEmail, assignees });
  out.source = who.source;
  if (!who.ids.length) {
    const msg = `noan: assignResolvedOwner ${taskId} — NO HUMAN RESOLVED (lane=${lane || "-"}, agent=${agent || "-"}, requester=${requesterEmail || "-"}); set PARK_ASSIGNEES_ENG so a created task is never unowned`;
    console.warn(msg);
    log(msg);   // the caller's own sink too — this is the failure the helper exists to end
    return out;
  }
  const ids = [...new Set([...(keep || []).filter(Boolean), ...who.ids])];
  try {
    await noanPut(`/tasks/${taskId}/assignees`, { assigneeIds: ids });
    out.assigned = ids;
  } catch (e) {
    out.errors.push(`assignees: ${e.message}`);
    log(`  warn: could not assign ${taskId} (${who.source}): ${e.message}`);
  }
  return out;
}

/** Resolve the contact a task is about: explicit "Contact ID: <uuid>" line in
 *  the details wins; otherwise a single linked contact. Two+ links = ambiguous
 *  → null (caller escalates). */
const TASK_CONTACT_ID_RX = /contact id:?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
export function taskContactId(task) {
  const m = (task.details || "").match(TASK_CONTACT_ID_RX);
  if (m) return m[1];
  const links = task.contacts || [];
  return links.length === 1 ? links[0].id : null;
}

/* ---------------- contacts by email ----------------
 * GET /contacts?q= matches `name` ONLY — it never looks at `email`. An email
 * search therefore returns 0 items for a contact that plainly exists, and a
 * 200-with-nothing reads exactly like "no such contact".
 *
 * It looks like it works, which is why it survived so long: a hit happens when
 * the email string fuzzy-matches the NAME, so contacts created by our own
 * capture surfaces (named `email.split("@")[0]`) match themselves, and contacts
 * created anywhere else usually don't. Measured 2026-09-04 over 40 random live
 * contacts looked up by their own address: 15 missed — 38%.
 *
 * Every one of those misses is a duplicate contact, and on the website chat it
 * was worse than that: `isSubscriber` is derived from this lookup, so a missed
 * subscriber got served the prospect script with the support path disabled.
 *
 * The shape below is the one the voice app's auth has been running since
 * 2026-08-11 (it found the same thing independently, on recently-written
 * contacts): try `q=` first because it is one cheap request and usually right,
 * then fall back to an exact email match over the full list.
 *
 * A fallback sweep can still MISS — noanGetAll warns when its read is a floor
 * rather than a census — so this makes duplicates rare, not impossible.
 * Callers must stay safe to run twice. */

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when `s` is email-shaped, i.e. `q=` will not reliably find it. */
export function looksLikeEmail(s) {
  return EMAIL_RX.test(String(s ?? "").trim());
}

/* Cached full-list fallback. 60s, so a bad-address retry loop can't turn into a
 * ~9-page sweep per attempt. Short-lived agent processes get one sweep at most. */
let _contactsByEmailCache = { at: 0, list: [], reportedTotal: null };
const CONTACTS_CACHE_MS = 60_000;

/** Extra full sweeps to spend before believing a MISS. Only the miss path pays for these.
 *
 *  Two is the useful number, not three: one pass to read, one to prove the read has stopped
 *  changing. Measured on a live project: three consecutive union sweeps returned an identical
 *  row set — the loss is deterministic, so a third pass is a page of requests for nothing. */
const CONTACT_SWEEP_ROUNDS = 2;

/** Contacts the list endpoint CANNOT return, by id. Supplied by the deployment, EMPTY by default.
 *
 *  The API's pagination bug (reported to the platform): `GET /contacts` paginates on a non-unique
 *  sort key with no tiebreaker, so rows inside a large tie group can be returned twice or never.
 *  Where a project has big tie clusters — many contacts created on one exact timestamp — a union
 *  sweep across page sizes tops out below the total `meta.totalItems` reports, missing the same
 *  rows every run. They are ordinary, live records; they just cannot be reached by listing.
 *
 *  They all resolve fine by id. So the miss path reads them directly, and the dedupe stops being
 *  blind to the addresses most at risk of being duplicated — there is no DELETE /contacts, so
 *  each of those duplicates would be permanent.
 *
 *  NOT hardcoded, and that is the point: a row id is meaningful only inside the project it came
 *  from. Baked into shipped code it 404s eight times per miss in every other project and leaks
 *  the origin project's internals; the export sweep now fails on a bare id in code.
 *  Set NOAN_UNREACHABLE_CONTACT_IDS (comma or whitespace separated) where a project needs it.
 *  Ids, not emails, deliberately: an id carries no personal data.
 *
 *  STOP SETTING THIS when the platform's pagination fix lands — a tiebreaker in the ORDER BY makes
 *  every row reachable and this becomes dead weight that silently rots as the board grows. It is a
 *  floor, not a fix: rows can fall into the gap at any time and nothing here will know. */
const UNREACHABLE_CONTACT_IDS = (process.env.NOAN_UNREACHABLE_CONTACT_IDS || "")
  .split(/[\s,]+/).map(s => s.trim()).filter(Boolean);

/** The unreachable rows, read one by one. Cached per process; only the miss path pays. */
let _unreachableCache = null;
async function unreachableContacts() {
  if (_unreachableCache) return _unreachableCache;
  const rows = await Promise.all(UNREACHABLE_CONTACT_IDS.map(id =>
    noanGet(`/contacts/${id}`).then(r => r?.contact || r).catch(() => null)));
  _unreachableCache = rows.filter(c => c?.id);
  return _unreachableCache;
}

/** Thrown by findOrCreateContactByEmail when a miss cannot be trusted. Callers distinguish it
 *  from a real create failure: "we could not read the network" deserves a different answer than
 *  "the write was rejected". */
export const INCOMPLETE_CONTACT_SWEEP = "INCOMPLETE_CONTACT_SWEEP";

/** meta.totalItems for contacts, or null. One tiny request; only the miss path calls it. */
async function reportedContactTotal() {
  try {
    const r = await noanGet(`/contacts?page=1&per_page=1`);
    const t = r?.meta?.totalItems;
    return typeof t === "number" ? t : null;
  } catch { return null; }
}

/** Union sweep with a round count, cached. noanGetAll already unions page sizes 100/75/50/25 in
 *  one pass each, but it never RETRIES a size and it cannot tell the caller whether it succeeded
 *  — it warns to the console and returns the short list. Repeating the whole cycle is the only
 *  lever on a row that four passes happened to drop, since the loss is random rather than a
 *  fixed set of unreachable rows. */
async function contactSnapshot({ rounds = 1 } = {}) {
  const byId = new Map();
  if (Date.now() - _contactsByEmailCache.at <= CONTACTS_CACHE_MS) {
    for (const c of _contactsByEmailCache.list) if (c?.id) byId.set(c.id, c);
  }
  let reportedTotal = _contactsByEmailCache.reportedTotal;

  // CONVERGED, not "reached meta.totalItems". That test was unsatisfiable: the list endpoint
  // cannot return every row (a known API pagination bug), so `seen >= reportedTotal` was permanently false and every
  // caller that gated a write on it refused FOREVER — measured live, a sweep short of the total.
  // What is actually knowable from here is whether the read has stopped changing: a full extra
  // pass that finds nobody new means we have everything the API is willing to give.
  let converged = false;
  for (let round = 0; round < rounds; round++) {
    const before = byId.size;
    for (const c of await noanGetAll(`/contacts?per_page=100`)) if (c?.id) byId.set(c.id, c);
    if (reportedTotal === null) reportedTotal = await reportedContactTotal();
    if (round > 0 && byId.size === before) { converged = true; break; }
  }

  _contactsByEmailCache = { at: Date.now(), list: [...byId.values()], reportedTotal };
  const list = _contactsByEmailCache.list;
  return {
    list,
    reportedTotal,
    converged,
    // What the API admits exists but will not hand over. Reported so a caller can say so out
    // loud instead of quietly treating the gap as absence.
    unreadable: typeof reportedTotal === "number" ? Math.max(0, reportedTotal - list.length) : null,
  };
}

/** Look an address up AND say how much to trust the answer.
 *
 *  `{ contact, complete, seen, reportedTotal, unreadable }`. A hit is always `complete: true` —
 *  a record we READ is real however short the sweep was. A miss is trustworthy when the sweep
 *  CONVERGED: a full extra pass that found nobody new means we have everything the API is
 *  willing to hand over, which is the most any client can establish (a known API pagination bug).
 *
 *  It is deliberately NOT "we saw every row meta.totalItems claims". That is unreachable — the
 *  list endpoint drops rows inside large tie groups — and gating on it made every miss untrusted
 *  forever, which is its own data loss: reply-worker escalated every unknown sender to a human
 *  rather than filing them.
 *
 *  The old caution still stands and is why the miss path is expensive. An established contact —
 *  long-standing, with memos, linked tasks and an open support case — was absent from four
 *  consecutive union sweeps, was reported by network-integrity as an active paying customer
 *  with no contact record, and was duplicated by a script whose guard treated the miss as
 *  absence. There is no DELETE /contacts, so that duplicate is permanent. Any ids configured in
 *  NOAN_UNREACHABLE_CONTACT_IDS are read directly before a create, which covers exactly that
 *  case for the rows a project knows about. */
export async function lookupContactByEmail(email) {
  const needle = String(email ?? "").trim().toLowerCase();
  if (!needle) return { contact: null, complete: true, seen: 0, reportedTotal: 0, unreadable: 0 };
  const match = list => list.find(c => (c.email || "").toLowerCase() === needle) || null;

  // `q=` never matches an address on this API, but it is one cheap request and it does hit when
  // the local part or domain happens to appear in a name, alias or website. Kept as a fast path.
  const viaQ = await noanGet(`/contacts?q=${encodeURIComponent(needle)}&per_page=50`)
    .then(r => match(r?.items || []))
    .catch(() => null);
  if (viaQ) return { contact: viaQ, complete: true, seen: null, reportedTotal: null, unreadable: 0 };

  let snap = await contactSnapshot();
  let hit = match(snap.list);
  // A hit ends it. Only a MISS is worth paying for, and only while the read is still moving.
  if (!hit && !snap.converged) {
    snap = await contactSnapshot({ rounds: CONTACT_SWEEP_ROUNDS });
    hit = match(snap.list);
  }
  // Still nothing: check the rows the list endpoint cannot return, before anyone treats this
  // miss as absence and writes a permanent duplicate of someone already on file.
  if (!hit) hit = match(await unreachableContacts());
  return {
    contact: hit,
    complete: hit ? true : snap.converged,
    unreadable: snap.unreadable,
    seen: snap.list.length,
    reportedTotal: snap.reportedTotal,
  };
}

/** The full-list half of the lookup, for a caller that has ALREADY run the `q=` search and so
 *  must not pay for it twice. One round, deliberately: this serves the agent-facing contact
 *  SEARCH, where a miss is shown to a human who can look again, not used to decide a write. */
async function fullListByEmail(needle) {
  const { list } = await contactSnapshot();
  return list.find(c => (c.email || "").toLowerCase() === needle) || null;
}

/** The contact with exactly this email address, or null.
 *
 *  Use this anywhere the needle is an address. For a NAME, plain
 *  `noanGet("/contacts?q=...")` is correct and much cheaper.
 *
 *  A null here means "not found", which is NOT the same as "not there" — see
 *  lookupContactByEmail if you are about to WRITE on the strength of it. */
export async function findContactByEmail(email) {
  return (await lookupContactByEmail(email)).contact;
}

/** Add a contact to the live cache, once. The list is scanned with `.find`, so a repeat is
 *  harmless to correctness — but the recovery path can resolve a contact the cache already
 *  holds, and a long-running process would accumulate copies of it. */
function rememberContact(contact) {
  if (!_contactsByEmailCache.at || !contact?.id) return;
  if (_contactsByEmailCache.list.some(c => c?.id === contact.id)) return;
  _contactsByEmailCache.list.push(contact);
}

/** Create a contact, and treat the API's duplicate refusal as a find.
 *
 *  THE API DOES NOT DEDUPE CONTACTS. Checked directly against the live service on
 *  2026-09-19: contact creation runs straight into the write with no email check,
 *  and POST /contacts does not answer 409 on an address that already exists.
 *
 *  So the 409 branch below is DEFENSIVE AND CURRENTLY DEAD. It is kept because it
 *  costs nothing and is the right shape if that ever changes — not because it
 *  fires today. Do not reason from it: the lossy lookup above is not a fast path
 *  in front of a server check, it is the ONLY check, and a miss it gets wrong is a
 *  permanent duplicate, because there is no DELETE for contacts.
 *
 *  This comment asserted the opposite until 2026-09-19, and the claim escaped into
 *  a second module and a third author's reasoning before anyone re-checked it. It
 *  began as an attributed, forward-looking sentence — "since <change>, the server
 *  dedupes" — written while that change was expected to land. The change never
 *  landed, and a later pass stripped the reference as an internal pointer, which
 *  left the claim standing alone as a statement of present fact.
 *
 *  So: never write a forward-looking or conditional fact into a shipped comment.
 *  The qualifier that made it honest is exactly what a tidy-up deletes, and what
 *  remains reads as verified. State what is true now, or say plainly that it is
 *  not true yet.
 *
 *  Use this for EVERY create. A bare `noanPost("/contacts", ...)` throws on the
 *  409 — `call()` does not retry a 4xx — which turns "silently made a duplicate"
 *  into "the run died". Two tests fail CI on a return to the raw call, and the
 *  split matters to whoever is reading this file: test-generic-config.mjs sweeps
 *  the shipped closure and travels WITH this module, so the rule holds wherever
 *  this file runs; test-contact-create-409.mjs additionally walks fleet-only
 *  paths and stays behind. This paragraph named only the second one until
 *  2026-09-20, which promised a downstream reader a guard that was not there —
 *  the same mistake as the paragraph above, one level up: a claim true in the
 *  tree it was written in and false in the tree it ships to.
 *
 *  Returns `{ contact, created }`. Throws on anything else, and on a 409 we
 *  cannot resolve: "the server refused, and we cannot say who owns the address"
 *  must not read as success. */
export async function createContact(body) {
  try {
    const res = await noanPost(`/contacts`, body);
    const contact = res?.contact || res;   // creates nest under the resource name; undocumented, read both
    if (!contact?.id) throw new Error("POST /contacts returned no contact id");
    // Same reasoning as findOrCreateContactByEmail: a second lookup in this run
    // must see it, or a caller that creates then re-checks duplicates against itself.
    rememberContact(contact);
    return { contact, created: true };
  } catch (e) {
    if (e?.noan?.status !== 409) throw e;
    // If a 409 ever does arrive, prefer the id it carries over our own lookup:
    // re-deriving it here would re-enter the two failure modes (q= misses
    // addresses, the sweep drops rows) that make our own answer unreliable.
    const id = e.noan.payload?.contactId;
    const existing = id
      ? await noanGet(`/contacts/${encodeURIComponent(id)}`).then(r => r?.contact || r).catch(() => null)
      : body?.email ? await findContactByEmail(body.email).catch(() => null) : null;
    if (!existing?.id) throw e;
    rememberContact(existing);
    return { contact: existing, created: false };
  }
}

/** Find the contact with this email, or create it.
 *
 *  The five-line find-or-create block that was copy-pasted into four website
 *  surfaces and sdr-reply-worker, each with the broken lookup and each with its
 *  own guess at the create response shape. POST /contacts returns
 *  `{contact:{...}}`, but that convention is undocumented and has already
 *  diverged elsewhere, so read both shapes.
 *
 *  Returns `{ contact, created }`. `name` defaults to the address's local part,
 *  which is what every caller was already doing. */
export async function findOrCreateContactByEmail(email, { name, website, tagIds, allowIncompleteSweep = false } = {}) {
  const needle = String(email ?? "").trim().toLowerCase();
  if (!EMAIL_RX.test(needle)) throw new Error(`findOrCreateContactByEmail: not an email: ${email}`);

  const { contact: found, complete, seen, reportedTotal, unreadable } = await lookupContactByEmail(needle);
  if (found) return { contact: found, created: false };

  // A miss we cannot trust must not become a create. Creating is irreversible — the API has no
  // DELETE on contacts — so the asymmetry is total: refusing costs a retry, creating costs a
  // permanent duplicate on a record that may already carry memos, tasks and an open case.
  // Both callers already handle this throw the right way: the email path escalates to a human
  // ("better a parked email than a reply to nobody on record") and the command path refuses.
  //
  // "Cannot trust" now means the read never SETTLED. It used to mean "we saw fewer rows than
  // meta.totalItems", which the list endpoint makes permanently true (a known API pagination bug) — so this threw on
  // every single create, and the two callers' careful handling turned into "no contact is ever
  // filed". A guard that always fires is not a guard.
  if (!complete && !allowIncompleteSweep) {
    const e = new Error(
      `refusing to create a contact for ${needle}: two full sweeps were still returning new rows ` +
      `(read ${seen} of ${reportedTotal} contacts and still moving), so "not found" may mean ` +
      `"not read". There is no DELETE /contacts, so a wrong create is permanent.`);
    e.code = INCOMPLETE_CONTACT_SWEEP;
    throw e;
  }
  // Settled, but the API still admits to rows it would not hand over. Say so at the moment of
  // the write, naming the count — this is the residual duplicate risk, and it is invisible
  // unless something prints it.
  if (unreadable > 0) {
    console.warn(`  warn: creating ${needle} after a settled sweep that read ${seen} of ${reportedTotal} ` +
      `contacts — ${unreadable} row(s) the list endpoint will not return (the API's pagination bug, reported to the platform). ` +
      (UNREACHABLE_CONTACT_IDS.length
        ? `The ${UNREACHABLE_CONTACT_IDS.length} known one(s) were checked by id; any others are a blind spot.`
        : `No known-unreachable ids are configured (NOAN_UNREACHABLE_CONTACT_IDS), so every such row is a blind spot.`));
  }

  const body = { name: (name || "").trim() || needle.split("@")[0], email: needle };
  if (website) body.website = website;
  if (tagIds?.length) body.tagIds = tagIds;

  // Nothing behind this: the sweep above IS the dedupe, because the server does
  // not check (see createContact). createContact's 409 branch would catch a miss
  // if a guard ever landed, but today a wrong answer above becomes a permanent
  // duplicate.
  return createContact(body);
}

/** The display name in an RFC 5322 From header, or null when there is none
 *  worth keeping. `"Ryan O'Connor" <ryan@example.com>` → `Ryan O'Connor`;
 *  `ryan@example.com` → null, and the caller falls back to the address local part,
 *  the fleet's convention for capture-created contacts. A "name" that is itself
 *  an address, a still-encoded `=?UTF-8?...` word, or anything over 120 chars
 *  (a signature block pasted into the header) is rejected the same way — the
 *  worst case must be a plain local-part name, never junk on the record. */
export function senderDisplayName(from) {
  const s = String(from ?? "").trim();
  const lt = s.lastIndexOf("<");
  if (lt <= 0) return null;                       // bare address, or nothing before the bracket
  let name = s.slice(0, lt).trim();
  name = name.replace(/^"(.*)"$/s, "$1").replace(/\\(["\\])/g, "$1").replace(/\s+/g, " ").trim();
  if (!name || name.includes("@") || name.startsWith("=?") || name.length > 120) return null;
  return name;
}

/** Free-text contact search for the model-facing `search_contacts` tools.
 *
 *  `q` there is whatever the model typed — usually a name, often an address.
 *  A name goes straight through (that is what `q=` is for and it is one cheap
 *  request); an email-shaped needle that `q=` failed to match exactly gets the
 *  full-list fallback, so the tool stops answering "no such contact" about
 *  contacts the agent can plainly see elsewhere.
 *
 *  Returns the raw items array — callers do their own field projection. */
export async function searchContacts(q, { perPage = 10 } = {}) {
  const needle = String(q ?? "").trim();
  const res = await noanGet(`/contacts?q=${encodeURIComponent(needle)}&per_page=${perPage}`).catch(() => null);
  const items = res?.items || [];
  if (!looksLikeEmail(needle)) return items;

  const lower = needle.toLowerCase();
  if (items.some(c => (c.email || "").toLowerCase() === lower)) return items;
  const hit = await fullListByEmail(lower);   // the q= half just ran, above
  return hit ? [hit, ...items] : items;
}

/* ---------------- contact memos (readable since API v1.0.0, 2026-07-24) ----------------
 * GET /contacts/{id} returns the contact's full memo history — Granola meeting
 * summaries, agent send-records, CS exchanges. Memos were write-only before, so
 * agents built earlier worked blind to this history.
 *
 * Note the shape split: GET /contacts returns ContactSummary (8 fields, no memos);
 * only GET /contacts/{id} carries `memos`, `notes`, `companyRoles` and `tasks`. */

/**
 * Append one memo to a contact. THE single write path for contact memos — every
 * agent goes through here rather than calling the endpoint directly, so the next
 * time this route moves it is one edit and not thirty-eight.
 *
 * Writes POST /contacts/{id}/memos. POST /contacts/{id}/notes is deprecated in the
 * live spec, as is Contact.notes in favour of Contact.memos. The two are views of
 * the SAME store — a memo written here also appears in the deprecated `notes`
 * array, and vice versa (verified across live contacts 2026-08-31) — so readers on
 * either field keep working and this migration needed no cutover.
 *
 * `title` is the one thing the old route could not do. Left optional and unset by
 * default: the fleet encodes an `[Agent] ...` prefix in the content instead, and
 * lifting those into real titles is a per-agent change, not part of moving route.
 * Where a title IS set it becomes an idempotency marker — see contact-enrich.mjs,
 * which finds its own prior memo by title rather than by matching content.
 */
export async function addContactMemo(contactId, content, title = null) {
  const memo = { content: String(content ?? "") };
  if (title) memo.title = String(title);
  return noanPost(`/contacts/${contactId}/memos`, { memos: [memo] });
}

/**
 * The most recent memos for a contact, formatted as prompt context.
 * Fail-soft: returns null on any error (a missing history is context, not a
 * reason to abort). Newest-last as stored; we take the tail.
 */
export async function fetchContactMemos(contactId, { maxNotes = 8, maxCharsPer = 1200, budget = 7000 } = {}) {
  try {
    const res = await noanGet(`/contacts/${contactId}`);
    return selectRecentMemos((res?.contact || res)?.notes, { maxNotes, maxCharsPer, budget });
  } catch {
    return null;
  }
}

/** The selection half of fetchContactMemos, pure so it can be tested.
 *
 *  ⚠ `notes` arrives NEWEST-FIRST. This used to read `slice(-maxNotes).reverse()`
 *  — "newest last, take the tail" — which is the opposite, and it did not merely
 *  invert the order: past `maxNotes` it dropped the newest memos entirely.
 *
 *  Verified live 2026-09-04. one contact has 13 memos; the five most recent
 *  (all 2026-09-02) fell outside `slice(-8)`, so every agent grounding on his
 *  history read it as ending 2026-08-31. another, with 9 memos, lost only
 *  the newest — the single one most likely to matter.
 *
 *  Twelve workers read contact history through this (reply, reengage, trial,
 *  course, activation, onboard, precog, general-tools, worker, demo-script),
 *  several of them to answer "what did we last say to this person?" — which is
 *  exactly the question the old slice answered with the oldest thing on file.
 *  It stayed invisible because a contact needs MORE than maxNotes memos to lose
 *  anything, and most have fewer. */
export function selectRecentMemos(notes, { maxNotes = 8, maxCharsPer = 1200, budget = 7000 } = {}) {
  const all = Array.isArray(notes) ? notes : [];
  if (!all.length) return null;
  const recent = all.slice(0, maxNotes);   // already newest-first
  const parts = [];
  let used = 0;
  for (const n of recent) {
    const s = String(n);
    const t = s.length > maxCharsPer ? s.slice(0, maxCharsPer) + "\n[...memo truncated]" : s;
    if (used + t.length > budget) break;
    parts.push(t);
    used += t.length;
  }
  return parts.length ? parts.join("\n\n---\n\n") : null;
}

/* ---------------- tasks ---------------- */

/** London calendar date (YYYY-MM-DD) of a Date — en-CA formats ISO-style,
 *  so the strings compare lexicographically. */
function londonDay(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d);
}

/**
 * Due gate. A task with no dueDate is due immediately (pre-dueDate tasks and
 * hand-written ones keep working). One with a dueDate becomes due once its
 * London calendar date is today or earlier — the demo pipeline dates tasks
 * "+3 working days at 09:00 London" and this is the other half of that clock.
 */
export function taskDueNow(task, now = new Date()) {
  if (!task?.dueDate) return true;
  const due = new Date(task.dueDate);
  if (isNaN(due.getTime())) return true;   // unparseable date must not strand the task
  return londonDay(due) <= londonDay(now);
}

/**
 * Backlog tasks to process: the standard trigger (tag + the agent assigned —
 * the old title/"#tag" convention is retired) that are
 * due now. Oldest dueDate first so overdue tasks can't starve behind the cap.
 */
export async function listBacklogTasks({ tagName = "follow-up", limit = 3 } = {}) {
  const all = await noanGetAll(`/tasks?status=backlog&per_page=100`);
  const triggered = all.filter(t => taskTriggers(t, tagName));   // taskTriggers also drops completed tasks
  const due = triggered.filter(t => taskDueNow(t));
  const waiting = triggered.length - due.length;
  // Name the actual tag: this helper now serves every dated agent, and an
  // agent-ideas run reporting "follow-up task(s) waiting" reads as a bug.
  if (waiting > 0) console.log(`noan: ${waiting} ${tagName} task(s) waiting on a future dueDate`);
  due.sort((a, b) => new Date(a.dueDate || 0) - new Date(b.dueDate || 0));
  return due.slice(0, limit);
}
