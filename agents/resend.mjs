/**
 * Resend sender. Raw fetch, no SDK dependency.
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer <RESEND_API_KEY>
 *   body: { from, to, subject, html, text? }
 *
 * Security: subject is user/model-influenced, so strip CR/LF to prevent header
 * injection. We send an idempotency key so re-runs of the worker can't double-send
 * the same task's email.
 *
 * Env guard (2026-09-09): RESEND_API_KEY and MAIL_FROM are read at CALL time
 * and their absence is a named error, never a request. Before this, a missing
 * key went out as `Authorization: Bearer undefined` and Resend answered 401
 * "invalid API key" — the same message a revoked key produces — so the
 * hand-built service that ran the Slack companion, which shipped without the
 * variable, spent nine days reporting a bad key while the key was
 * fine and the dashboard showed nothing (the requests never authenticated, so
 * they never appeared). fetchEmailStatus had the same hole: 50/50
 * "lookup_failed" that read as a fleet-wide auth failure. A missing variable
 * and a bad credential are different problems owned by different people; the
 * error must say which. Tested by test-resend-env-guard.mjs.
 */

const RESEND_URL = "https://api.resend.com/emails";
/** Read at call time so a host that sets env after import still works and the
 *  guard's test can toggle the variables. */
function mailEnv({ needFrom }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set on this host — no request was made. Set it in the service's environment (Actions secret, Render Environment tab, or .env); this is a missing variable, not a bad key.");
  const from = process.env.MAIL_FROM;
  if (needFrom && !from) throw new Error("MAIL_FROM is not set on this host — no request was made. Set it to a sender verified in Resend, e.g. \"Agent <agent@your-domain>\".");
  return { key, from };
}
// Replies go here (the From address, verity@…, isn't a monitored mailbox). Set
// REPLY_TO="" (or unset) omits the header. Env-pinned in the fleet to a
// monitored human inbox; OSS installs set it if replies should divert.
const REPLY_TO = process.env.REPLY_TO || "";
// CC every send here (e.g. a teammate's inbox) so a human sees what the agent sends.
// Suppressed while TEST_RECIPIENT is set — test traffic shouldn't hit the CC inbox.
const MAIL_CC = process.env.TEST_RECIPIENT ? null : (process.env.MAIL_CC || null);

function safeHeader(s = "") {
  return String(s).replace(/[\r\n]+/g, " ").slice(0, 200);
}

export async function sendEmail({ to, subject, html, text, idempotencyKey, headers: extraHeaders, cc, attachments }) {
  const { key: KEY, from: FROM } = mailEnv({ needFrom: true });
  const headers = {
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const body = {
    from: FROM,
    to: Array.isArray(to) ? to : [to],
    subject: safeHeader(subject),
    html,
  };
  if (text) body.text = text;
  if (REPLY_TO) body.reply_to = REPLY_TO;   // route replies to a monitored inbox
  if (MAIL_CC && cc !== false) body.cc = [MAIL_CC];  // human visibility on live sends; cc:false opts a send out (e.g. scheduling)
  if (extraHeaders) body.headers = extraHeaders;  // e.g. In-Reply-To for threading
  if (attachments?.length) body.attachments = attachments;  // [{filename, content: base64}]

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let payload; try { payload = JSON.parse(raw); } catch { payload = raw; }

  if (!res.ok) {
    const msg = payload?.message || payload?.error?.message || raw || res.statusText;
    const err = new Error(`Resend ${res.status}: ${msg}`);
    // Structured detail so callers can branch on the failure instead of
    // string-matching the message. sendReportEmail below needs the 409
    // idempotency codes specifically; everything else still just throws.
    err.status = res.status;
    err.code = payload?.name || payload?.error?.name || null;
    throw err;
  }
  // delivery-stats send log (2026-07-26): best-effort, never blocks a send
  if (payload?.id) appendSendLog({ id: payload.id, to: body.to, subject: body.subject });
  // spend ledger (usage-log.mjs): same best-effort contract
  await recordUsage({ provider: "resend", units: body.to.length });
  return payload; // { id: "..." }
}

/* ---------------- batch sends (added 2026-09-21) ----------------
 * POST /emails/batch: up to 100 emails in ONE request, each with its own `to`,
 * subject, html, text, headers and tags. Added for the newsletter, which sent one
 * request per recipient at 600 ms spacing: 1,000 recipients took ten minutes and
 * 1,000 requests.
 *
 * PERMISSIVE by default. Resend validates a batch as a whole unless the request
 * carries `x-batch-validation: permissive` (the header the official SDK sets
 * for `batchValidation: "permissive"`); then the valid emails go and the
 * response lists the rest as `errors: [{ index, message }]`. Strict mode would
 * let one malformed address stop 99 good ones.
 *
 * IDEMPOTENCY IS PER REQUEST, not per email: one key covers the whole batch.
 * The caller owns the key and must derive it from what is in the batch, and
 * must send a byte-identical payload on a retry, so a retry replays the
 * original response instead of 409ing (see dedupeReason below).
 *
 * No CC, ever: a batch is bulk mail, and MAIL_CC on a bulk send would copy a
 * teammate on every recipient's email. Attachments are not supported by the
 * endpoint.
 *
 * Returns one result per input email, in input order:
 *   { ok: true, id }  or  { ok: false, error }
 * `id` is null when Resend accepted the email but its id cannot be matched to
 * it with certainty (see mapBatchResponse). Throws, like sendEmail, when the
 * REQUEST fails (auth, 429, 5xx, a strict-mode 422), with err.status/err.code.
 */
export const BATCH_MAX = 100;

/**
 * Resend's response to per-input results. The documented contract is that
 * `data[i]` is the email at input index i. In permissive mode the SDK types
 * say only that failures come back in `errors`, not whether `data` keeps a
 * slot for them, so both shapes are read:
 *   data.length === n                 index-aligned (a failed slot may be empty)
 *   data.length === n - errors.length the successes, in input order. This is
 *                                     what Resend returned when probed on
 *                                     2026-09-21 (3 emails, 1 malformed: two
 *                                     ids, errors[{ index: 1 }], status 202),
 *                                     and an identical retry with the same
 *                                     key replayed the same two ids.
 * Anything else is accepted-but-unmatched: those emails WENT, so they are
 * reported ok with id null rather than as failures, because a caller that
 * reads "failed" would send them again.
 */
export function mapBatchResponse(n, payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const failed = new Map(errors.filter(e => Number.isInteger(e?.index)).map(e => [e.index, e.message || "rejected"]));
  const okIdx = [];
  for (let i = 0; i < n; i++) if (!failed.has(i)) okIdx.push(i);
  const out = new Array(n);
  for (const [i, message] of failed) if (i >= 0 && i < n) out[i] = { ok: false, error: message };
  if (data.length === n) {
    for (const i of okIdx) out[i] = { ok: true, id: data[i]?.id || null };
  } else if (data.length === okIdx.length) {
    okIdx.forEach((i, k) => { out[i] = { ok: true, id: data[k]?.id || null }; });
  } else {
    for (const i of okIdx) out[i] = { ok: true, id: null };
  }
  return out;
}

export async function sendBatch(emails, { idempotencyKey, permissive = true } = {}) {
  if (!Array.isArray(emails) || !emails.length) throw new Error("sendBatch: no emails");
  if (emails.length > BATCH_MAX) throw new Error(`sendBatch: ${emails.length} emails, the endpoint takes ${BATCH_MAX} at most`);
  const { key: KEY, from: FROM } = mailEnv({ needFrom: true });
  const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = String(idempotencyKey).slice(0, 256);
  if (permissive) headers["x-batch-validation"] = "permissive";
  const body = emails.map(e => {
    const m = { from: FROM, to: Array.isArray(e.to) ? e.to : [e.to], subject: safeHeader(e.subject), html: e.html };
    if (e.text) m.text = e.text;
    if (REPLY_TO) m.reply_to = REPLY_TO;
    if (e.headers) m.headers = e.headers;
    if (e.tags?.length) m.tags = e.tags;
    return m;
  });
  const res = await fetch(`${RESEND_URL}/batch`, { method: "POST", headers, body: JSON.stringify(body) });
  const raw = await res.text();
  let payload; try { payload = JSON.parse(raw); } catch { payload = raw; }
  if (!res.ok) {
    const msg = payload?.message || payload?.error?.message || raw || res.statusText;
    const err = new Error(`Resend ${res.status}: ${msg}`);
    err.status = res.status;
    err.code = payload?.name || payload?.error?.name || null;
    throw err;
  }
  const results = mapBatchResponse(emails.length, payload);
  const sent = results.map((r, i) => (r.ok ? { id: r.id, to: body[i].to, subject: body[i].subject } : null)).filter(Boolean);
  appendSendLogMany(sent.filter(e => e.id));
  await recordUsage({ provider: "resend", units: sent.reduce((n, e) => n + e.to.length, 0) });
  return results;
}

/* ---------------- periodic report sends (added 2026-08-13) ----------------
 * Every scheduled report worker (pr-sweep, board-sweep, fact-alignment,
 * weekly-activity-report, growth/product/market refreshes) posts a NOAN note
 * keyed to the window it covers and then emails the same report out. Those two
 * keys must agree: the note's externalId and the send's idempotency key both
 * identify "the report for period P", so one re-run of period P produces one
 * note and one email.
 *
 * They drifted apart. The sends keyed on
 *   `<agent>-email:<period>:${GITHUB_RUN_ID || Date.now()}`
 * which is unique per run by construction, so a workflow_dispatch re-run of an
 * already-reported window re-emailed the Growth Team (flagged across #39, #40,
 * #41, #42 in the 2026-08-07 PR sweep).
 *
 * The run-id wasn't arbitrary, though — it was a fix for a real 409 on
 * 2026-07-31, and dropping it naively would reintroduce that. Resend's contract
 * is that one key covers one payload: a repeat with the SAME payload replays the
 * original response, and a repeat with a DIFFERENT payload is rejected 409
 * `invalid_idempotent_request`. Our report bodies are built from live data and a
 * non-deterministic model call, so a re-run's payload is never byte-identical
 * and always lands in the 409 branch. sendEmail throws on non-2xx, so that 409
 * failed the whole workflow.
 *
 * That 409 is Resend telling us what we want to know — "this period already went
 * out" — so it's handled here as a successful skip rather than an error. Same
 * for `concurrent_idempotent_requests` (a concurrent run is mid-send for this
 * period): skipping is right, since retrying is what would duplicate.
 *
 * Limit worth knowing: Resend keeps idempotency keys for 24 hours. Within that
 * window this is a hard guarantee; a re-run of the same period days later WILL
 * re-send. That covers the failure this fixes (accidental or retried re-runs
 * near the scheduled time) and deliberately leaves the "re-run an old window on
 * purpose" case sending, which is usually what you want.
 *
 * To force a re-send inside the 24h window (e.g. the first report was wrong and
 * you want the corrected one to actually arrive), set REPORT_EMAIL_NONCE to any
 * new value — same escape hatch as SEND_NONCE on the per-task agents.
 */

// The two 409s Resend raises for idempotency, and what each one actually tells
// us. They are NOT equivalent, and the difference matters to a reader of the
// logs: only the first is evidence that a report already went out.
const DEDUPE_REASONS = {
  // This key already sent something with a different payload — i.e. this period
  // was reported. A confirmed prior send.
  invalid_idempotent_request: "already sent for this period",
  // Another request holds this key right now. Almost always a concurrent run
  // that is about to send — but if THAT send ultimately fails, skipping here
  // means no report goes out at all, so this is not a confirmed send and must
  // never be logged as one. Retrying instead of skipping would close that gap;
  // it isn't worth the sleep in a shared helper for a race this rare, but if
  // this reason ever shows up in a real run, revisit that trade.
  concurrent_idempotent_requests: "a concurrent run holds this period's key — NOT a confirmed send",
};

function dedupeReason(err) {
  if (err?.status !== 409) return null;
  if (err.code) return DEDUPE_REASONS[err.code] || null;   // a coded 409 we don't know is a real error
  // No structured code: fall back to the message, but only here, so a future
  // non-idempotency 409 that carries a code can never be swallowed by a string
  // match. Announce it, since a silently-skipped send is the bad outcome.
  if (/idempoten/i.test(err.message || "")) {
    console.warn(`resend: 409 with no error code, matched on message — treating as a dedupe. Message: ${err.message}`);
    return "already sent for this period (matched on message, no error code)";
  }
  return null;
}

/**
 * Send a periodic report email, deduped on the period it covers.
 *
 * Deliberately does NOT accept `cc`: report sends go to a recipient list
 * resolved live from NOAN, and the fleet rule is no CC on
 * agent sends. Don't add it back — if a report needs another recipient, add
 * them to the tag the worker resolves.
 *
 * @param {string} agent   agent slug, e.g. "pr-sweep" — matches the note's externalId prefix
 * @param {string} period  the window identifier, e.g. "2026-08-07" or "2026-07-31 to 2026-08-07".
 *                         MUST be the same value used in the note's externalId.
 * Remaining fields are passed through to sendEmail.
 * @returns {Promise<{sent: boolean, deduped?: boolean, reason?: string, id?: string}>}
 *          `reason` explains a skip and is safe to put straight in a log line.
 */
export async function sendReportEmail({ agent, period, to, subject, html, text, headers, attachments }) {
  if (!agent || !period) throw new Error("sendReportEmail: agent and period are required");
  const nonce = process.env.REPORT_EMAIL_NONCE ? `:${process.env.REPORT_EMAIL_NONCE}` : "";
  const idempotencyKey = `${agent}-email:${period}${nonce}`;
  try {
    const payload = await sendEmail({ to, subject, html, text, headers, attachments, idempotencyKey });
    return { sent: true, id: payload?.id };
  } catch (e) {
    const reason = dedupeReason(e);
    if (reason) return { sent: false, deduped: true, reason };
    throw e;
  }
}

/* ---------------- delivery stats (added 2026-07-26) ----------------
 * Resend reads status per email id, so we log every id this fleet sends and
 * the general agent's email_delivery tool reads it back and asks Resend for
 * each message's last_event.
 *
 * 2026-07-28: the log lives in the shared state backend (a "sent-log" row via
 * state-local.mjs), not a local jsonl — on GitHub runners the local disk is
 * destroyed after every run, which silently emptied the log after the Actions
 * migration. Missing row just means "no sends logged yet" (peekState), never
 * an abort: unlike agent ledgers, an empty send log can't cause a re-send.
 * Append is read-modify-write on one row, so two workers sending in the same
 * instant can drop an entry — acceptable for best-effort stats. */

import { peekState, saveLocalState } from "./state-local.mjs";
import { recordUsage } from "./usage-log.mjs";

const SEND_LOG_STATE = "sent-log";

function loadSendLog() {
  const s = peekState(SEND_LOG_STATE);
  return Array.isArray(s?.entries) ? s.entries : [];
}

function saveSendLog(entries) {
  saveLocalState(SEND_LOG_STATE, { initialized: true, entries });
}

export function appendSendLog(entry) {
  try {
    const keepCut = new Date(Date.now() - 60 * 86400_000).toISOString();
    const entries = loadSendLog().filter(e => e.at >= keepCut);
    entries.push({ at: new Date().toISOString(), ...entry });
    saveSendLog(entries);
  } catch { /* logging must never break a send */ }
}

/** Many entries in ONE read-modify-write: a 100-email batch through
 *  appendSendLog would be 100 round trips to the state backend. */
export function appendSendLogMany(list) {
  if (!list?.length) return;
  try {
    const keepCut = new Date(Date.now() - 60 * 86400_000).toISOString();
    const at = new Date().toISOString();
    const entries = loadSendLog().filter(e => e.at >= keepCut);
    for (const entry of list) entries.push({ at, ...entry });
    saveSendLog(entries);
  } catch { /* logging must never break a send */ }
}

/** Recent send-log entries within `days`, newest last. Prunes the log to 60
 *  days as a side effect so it stays bounded forever. */
export function readSendLog(days = 7) {
  try {
    const all = loadSendLog();
    const keepCut = new Date(Date.now() - 60 * 86400_000).toISOString();
    const kept = all.filter(e => e.at >= keepCut);
    if (kept.length < all.length) {
      try { saveSendLog(kept); } catch {}
    }
    const cut = new Date(Date.now() - days * 86400_000).toISOString();
    return kept.filter(e => e.at >= cut);
  } catch { return []; }
}

/** One email's delivery state from Resend: last_event etc. */
export async function fetchEmailStatus(id) {
  const { key: KEY } = mailEnv({ needFrom: false });
  const res = await fetch(`https://api.resend.com/emails/${id}`, {
    headers: { Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${data?.message || "unknown"}`);
  return {
    id, to: data.to, subject: data.subject, last_event: data.last_event,
    created_at: data.created_at, bounce: data.bounce || null,
  };
}
