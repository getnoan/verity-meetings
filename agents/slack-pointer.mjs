/**
 * Which Slack thread a task came from.
 *
 * A task born in Slack carries `Slack: <channel>/<thread_ts>` in its details,
 * and every thread-aware behaviour reads it: the general worker's asks,
 * completion reports and needs-human parks all go back to the thread instead
 * of an inbox.
 *
 * The gap this closes: a task the general agent DELEGATED out of a Slack
 * conversation never got that line, so the specialist emailed its question
 * while the requester sat in the thread waiting. Two Slack origins exist and
 * neither carried it through:
 *
 *   slack-worker      @<agent> mention → a real board task. Writes the line. ✓
 *   slack-agent       the in-thread companion → a SYNTHETIC task whose details
 *                     are the requester's verbatim words. No line, and the
 *                     tool belt was handed no thread context at all.
 *
 * Split out of general-worker.mjs so it can be tested and shared: that file
 * polls on import.
 */

/** `Slack: C123/1699999999.000100` — anywhere in the details, own line. */
export const SLACK_PTR_RX = /^Slack:\s*([A-Z0-9]+)\/(\d+\.\d+)/m;

/** The companion's synthetic task id. Its ts IS the thread's. */
const COMPANION_EXT_RX = /^slack:companion:([A-Z0-9]+):(\d+\.\d+)$/;

/** The line to write into a delegated task's details. */
export function formatSlackPointer(ptr) {
  if (!ptr?.channel || !ptr?.ts) return null;
  return `Slack: ${ptr.channel}/${ptr.ts}`;
}

/**
 * The thread a task belongs to, or null.
 *
 * Order matters. The details line wins, then the COMPANION externalId —
 * and nothing else. Deliberately NOT derived from slack-worker's
 * `slack:<channel>:<ts>` externalId: that ts is the mention MESSAGE's, not
 * the thread's, so a mention posted as a reply would resolve to a thread
 * that does not exist. A wrong thread is worse than an email.
 */
export function slackPointerFrom(task) {
  const m = String(task?.details || "").match(SLACK_PTR_RX);
  if (m) return { channel: m[1], ts: m[2] };
  const e = String(task?.externalId || "").match(COMPANION_EXT_RX);
  if (e) return { channel: e[1], ts: e[2] };
  return null;
}

/** Can this process reach Slack at all? Through the hosted relay (the pair of relay variables) or, on an install that
 *  still carries one, a bot token. Every "skip Slack when it is not set up" check asks this, so a workflow that drops
 *  the bot token for the relay keeps its thread replies, parks and receipts. */
export const slackConfigured = (env = process.env) => Boolean(env.SLACK_BOT_TOKEN || (env.VERITY_SLACK_RELAY_URL && env.VERITY_SLACK_RELAY_TOKEN));
