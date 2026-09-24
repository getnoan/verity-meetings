/**
 * Trigger-tag registry — the ONE source of truth for which NOAN task tags a
 * deployed worker actually polls.
 *
 * Before this file, four lists drifted apart: the belt's DEFAULT_TRIGGER_TAGS
 * (general-tools.mjs), the board sweep's BOARD_SWEEP_RUNNER_TAGS
 * (config.defaults.env), reply-worker's EXECUTABLE map, and
 * CUSTOMER_FACING_TAGS. "Site Build" proved the failure mode: its worker went
 * live while the belt still rejected the tag AND the sweep's runner list
 * omitted it — a dead route invisible in both directions.
 *
 * Adding or retiring an agent = one entry here, in the SAME diff as the
 * worker. Tag names must match NOAN tag names EXACTLY — findTagId is
 * case-insensitive but literal, so a near-miss silently resolves to nothing,
 * the task lands untagged, and no agent ever sees it ("follow-up" vs
 * "follow up" was such a miss).
 *
 * customerFacing means "this trigger fires an email into a real customer's
 * inbox". The original four-member set (onboard, reengage, activation, deck)
 * is preserved verbatim from general-tools.mjs; "follow up" stays outside it
 * deliberately (due-date-gated, mostly armed by automation — outside the
 * confirm/park set since 2026-07-25). The tags NEW to the routable list are
 * classified by what their workers actually do.
 */

export const TRIGGER_TAG_REGISTRY = [
  { tag: "follow up",  worker: "worker.mjs",                          customerFacing: false },
  { tag: "onboard",    worker: "onboard-worker.mjs",                  customerFacing: true },
  { tag: "reengage",   worker: "reengage-worker.mjs",                 customerFacing: true },
  { tag: "activation", worker: "activation-worker.mjs",               customerFacing: true },
  { tag: "course offer", worker: "course-worker.mjs (runOfferBeat)",  customerFacing: true },
  { tag: "trial",      worker: "trial-worker.mjs",                    customerFacing: true },
  { tag: "support",    worker: "reply-worker.mjs (scanSupportTasks)", customerFacing: false },
  { tag: "Social",     worker: "social-worker.mjs",                   customerFacing: false },
  { tag: "LinkedIn",   worker: "linkedin-worker.mjs",                 customerFacing: false },
  { tag: "Deck",       worker: "design/deck.py + sdr-deck-worker.mjs", customerFacing: true },
  { tag: "Ad Asset",   worker: "design/design.py",                    customerFacing: false },
  { tag: "Demo Video", worker: "demo-worker.mjs",                     customerFacing: true },
  { tag: "Site Build", worker: "site-builder-worker.mjs",             customerFacing: false, gate: "SITE_BUILDER_ENABLED" },
  // A brief or a script becomes a cut video, hosted and PARKED for a person. Not customer-facing:
  // nothing leaves without a teammate's "send", or the narrow auto-release rule in
  // video-review.mjs. Runs inside its own hosted service, not on the poller.
  { tag: "Cut Video",  worker: "video-worker.mjs",                    customerFacing: false, gate: "VIDEO_ENABLED" },
  // Polled for a teammate's approval COMMENT, not for an agent assignment: the
  // task belongs to the human reviewer. Registered so the belt never claims a
  // question task someone assigns the agent to (before 2026-09-09 that routed a
  // Smartlead-thread reply to an agent with no Smartlead lever). Applied by
  // sdr-reply-worker only; the belt cannot route to it usefully — a task it
  // filed has no sdr-reply: externalId and is left alone.
  { tag: "SDR Reply",  worker: "sdr-reply-worker.mjs (processApprovedSends)", customerFacing: true, gate: "SDR_ENABLED" },
  // A brief from another company's agent. Customer-facing:
  // the work goes back to another company. Registered so the general lane never claims one;
  // any runtime that sees it hands it to partner-brief-worker (the Partner key rule).
  { tag: "Partner Brief", worker: "partner-brief-worker.mjs", customerFacing: true, gate: "PARTNER_BRIEFS_ENABLED" },
  // Filed by the booking service when a guest ticks "Brief me before the call"
  // Customer-facing: the brief lands in the booker's inbox.
  // Dispatched straight to brief-worker by the booking service; registered so the
  // general lane never claims one.
  { tag: "Pre-call Brief", worker: "brief-worker.mjs", customerFacing: true, gate: "BRIEF_ENABLED" },
  // The onboarding second beat. Filed by onboard-worker at intake with a dueDate
  // and claimed by agent-ideas-worker from BACKLOG. Unregistered until 2026-09-20,
  // which is the exact failure this file's header describes: the general lane read
  // "agent-ideas" as untagged, claimed both tasks due that day, and flipped them to
  // in-progress — a status the specialist cannot claim from. Two customer emails sat
  // unsent for hours waiting on a human to move them back. Registering it also gives
  // the general lane the way out it lacked:
  // route_to_specialist resets the task to backlog, so a mis-claim self-heals.
  { tag: "agent-ideas", worker: "agent-ideas-worker.mjs", customerFacing: true, gate: "AGENT_IDEAS_ENABLED" },
];

/** The routable default — what the belt validates against and the prompts list. */
export const DEFAULT_TRIGGER_TAGS = TRIGGER_TAG_REGISTRY.map(e => e.tag);

/** Lowercased names of triggers that email a customer (drives messaging, the
 *  inferred-step parking rule, and the recurring-goal restriction). */
export const CUSTOMER_FACING_TAGS = new Set(
  TRIGGER_TAG_REGISTRY.filter(e => e.customerFacing).map(e => e.tag.toLowerCase()));

/** Registry entry for a tag name (case-insensitive), or null. */
export function registryEntry(tagName) {
  const t = String(tagName || "").trim().toLowerCase();
  return TRIGGER_TAG_REGISTRY.find(e => e.tag.toLowerCase() === t) || null;
}

/* ---------------- pipeline records ----------------
 * Some tasks on the board are STATE, not work. The company website's site-preview
 * magnet (site-preview.functions.ts captureLead) opens one task per preview,
 * and every step of that flow — build, expand, claim kit, concierge claim — is
 * a stamp line in the task's details, read back by site-preview-fulfil-worker
 * and by the page itself. The investor-portal flow rides the same machinery.
 * Nobody is owed anything on such a task until a stamp line says so, and its
 * designed resting state is no status and no assignee.
 *
 * Until 2026-09-11 the site also ASSIGNED the agent to each one, for no consumer
 * at all — and "assigned, no trigger tag" is the general lane's own trigger.
 * It claimed all six open preview tasks within a minute of creation and the
 * model routed every one to Site Build: the rebuild product, which nobody had
 * asked for. "Site Preview" is deliberately NOT a
 * registry entry — no worker polls it — so this predicate is the one shared
 * answer to "is this a job?", used by the belt (never claim), the route and
 * retag tools (never apply a trigger tag), and the board sweep (never a
 * dropped assignment, never an "open with no status" defect).
 *
 * A PARKED record (needs-human) is a person's work again — a concierge claim
 * waiting on a person. The predicate still says "record"; a caller that must
 * treat parks as work checks the tag itself, as the sweep does.
 *
 * "Site Claim" (the tag the site adds on the concierge fork) is likewise NOT a
 * registry entry: it is a stamp on a record, handled by the fulfil worker
 * (site-preview-fulfil-worker.mjs handToOwner — park to the site owner plus
 * an email), never a route the belt may pick. Registering it would put it in
 * route_to_specialist's menu, and a routed "Site Claim" is the rebuild mistake
 * in a new hat. */
export const PIPELINE_RECORD_PREFIXES = ["site-preview:", "investor-portal:"];
export const PIPELINE_RECORD_TAGS = ["Site Preview"];

/** Why this task is a pipeline record, or null when it is ordinary work. */
export function pipelineRecordReason(task) {
  const ext = String(task?.externalId || "");
  const prefix = PIPELINE_RECORD_PREFIXES.find(p => ext.startsWith(p));
  if (prefix) return `a ${prefix.slice(0, -1)} pipeline record (the task is the flow's state, not a job)`;
  const names = (task?.tags || []).map(t => String(t?.name || "").trim().toLowerCase());
  const tag = PIPELINE_RECORD_TAGS.find(t => names.includes(t.toLowerCase()));
  if (tag) return `tagged "${tag}": a pipeline record (the task is the flow's state, not a job)`;
  return null;
}

/** True for a task the preview pipeline owns — never claimed, routed or reported as work. */
export function isPipelineRecord(task) {
  return pipelineRecordReason(task) !== null;
}

/**
 * Parse the fact-tunable "TRIGGER_TAGS:" line from the General Agent Config
 * fact. ONE parser for every surface (voice-agent, general-worker previously
 * carried their own copies).
 *
 * The NOAN UI markdown-escapes underscores, so the live fact can read
 * "TRIGGER\_TAGS:" — a literal match missed it and the documented no-deploy
 * tuning surface silently never took effect (found 2026-08-11). Values get
 * the same treatment: a tag wrapped in backticks or bold markers is still
 * that tag.
 *
 * NARROW-ONLY (decided 2026-09-01): the line can disable a route with no
 * deploy, but it can never invent one — a named tag with no registry entry
 * (i.e. no deployed worker) is ignored with a warning, because routing to it
 * would create tasks nothing ever picks up. No line, or a line with no valid
 * tags, falls back to the full registry.
 */
export function parseTriggerTags(configText, { log = () => {} } = {}) {
  const m = String(configText || "").match(/^[ \t]*TRIGGER\\?_TAGS[ \t]*:[ \t]*(.+)$/mi);
  if (!m) return DEFAULT_TRIGGER_TAGS;
  const named = m[1].split(",").map(s => s.replace(/[`*\\]/g, "").trim()).filter(Boolean);
  const known = named.filter(t => registryEntry(t));
  const dropped = named.filter(t => !registryEntry(t));
  if (dropped.length) {
    log(`TRIGGER_TAGS line names tags with no deployed worker — ignored: ${dropped.join(", ")} (the fact can narrow the registry, never extend it)`);
  }
  if (!known.length) return DEFAULT_TRIGGER_TAGS;

  // Narrowing is legitimate, but a SILENT narrowing is how a registered worker
  // becomes undelegatable with nothing in any log saying so: "agent-ideas" was
  // registered in code on 2026-09-20 while the live fact still listed the
  // twelve tags of 2026-09-01, so route_to_specialist rejected it and the one
  // agent that could have unstuck the task had no way to say why. Name what the
  // line is leaving out; sync-general-trigger-tags.mjs is the fix.
  const missing = DEFAULT_TRIGGER_TAGS.filter(
    t => !known.some(k => k.toLowerCase() === t.toLowerCase()));
  if (missing.length) {
    log(`TRIGGER_TAGS line narrows the registry — these registered workers are NOT delegatable: ${missing.join(", ")} (run sync-general-trigger-tags.mjs if that is unintended)`);
  }
  return known.map(t => registryEntry(t).tag);
}

/**
 * The contact tags that mean "this is one of our users", so the onboarding sequence runs.
 * Subscriber = an active subscription. Free = an account with no subscription. Both are real
 * users and both get onboarded; what differs is what they pay, which Stripe knows and no tag does.
 *
 * ONE list, because four workers ask the same question and each used to hardcode "subscriber":
 * the onboarding intake, the agent-ideas guard, the course's still-a-customer check, and the
 * course-start ask in reply-worker. A tag added to the model reached none of them.
 *
 * Deliberately NOT the plan tags (Starter, Team, Enterprise, Legacy Pricing). Those say what
 * someone pays for, not whether they are a user, and nothing should gate an email on them.
 */
export const USER_TAGS = String(process.env.USER_TAGS || "Subscriber,Free")
  .split(",").map(s => s.trim()).filter(Boolean);

/** Does this contact carry any USER_TAGS tag? Tolerates tags as objects or bare strings. */
export function isUserContact(contact) {
  const names = new Set((contact?.tags || []).map(t => String(t?.name ?? t).trim().toLowerCase()));
  return USER_TAGS.some(t => names.has(t.toLowerCase()));
}


/** How many BACKFILL-SHAPED contacts in one intake run stop looking like an accident. */
export const SURGE_LIMIT = parseInt(process.env.ONBOARD_SURGE_LIMIT || "25", 10);

/** How old a contact record has to be before its sudden eligibility looks like a backfill
 *  rather than a signup. Someone who signed up minutes ago has a record minutes old. */
export const SURGE_MIN_AGE_HOURS = parseInt(process.env.ONBOARD_SURGE_MIN_AGE_HOURS || "48", 10);

/** The subset of newly eligible contacts whose RECORDS are old.
 *
 *  Volume alone was the wrong signal and would have bitten hardest on the best day: a launch can
 *  put hundreds of real signups through in hours, every one of them deserving a welcome, and a
 *  raw count over the limit would have stopped the lot — then stopped every later run too, since
 *  the unsent pool only grows. A launch surge is hundreds of records MINUTES old. A backfill is
 *  contacts who have been here for months suddenly acquiring a tag. Age tells them apart; volume
 *  does not.
 *
 *  A record with no usable createdAt counts as OLD. The guard's posture is to fail toward sending
 *  nothing, and every contact the API returns carries one, so this should never decide anything. */
export function backfillShaped(contacts, { now = Date.now(), minAgeHours = SURGE_MIN_AGE_HOURS } = {}) {
  const cutoff = now - minAgeHours * 3600_000;
  return (contacts || []).filter(c => {
    const t = Date.parse(c?.createdAt || "");
    return !Number.isFinite(t) || t < cutoff;
  });
}

/** Does this run look like a backfill? Pass the count from backfillShaped, not the raw total. */
export function looksLikeBackfill(backfillCount, limit = SURGE_LIMIT) {
  return limit > 0 && backfillCount > limit;
}

/**
 * Contact tags that ARM OR DISARM automations the moment they change — so a
 * model must never apply one on its own judgement. Values say what the tag
 * does, for the refusal message and the tool result. Keyed lowercase.
 */
export const AUTOMATION_BEARING_CONTACT_TAGS = {
  "subscriber":      "arms the autonomous onboarding welcome and support/course/activation eligibility, and cancels queued follow-ups",
  "free":            "arms the autonomous onboarding welcome and the agent-ideas and course beats, exactly as Subscriber does — the free tier is a user, not a prospect",
  "trial":           "enters them in the trial-conversion sweep (code-guarded emails) and cancels queued follow-ups",
  "investor":        "grants investor voice-surface access and standing digests (with an active passcode)",
  "target investor": "admits them to the investor OTP gate",
  "demo booked":     "marks them awaiting a demo; a sales demo memo then retags Demo Done and queues a deck",
  "demo done":       "feeds the deck and follow-up pipeline",
  "churned":         "makes them a target for the nightly re-engagement agent",
};

/** What an automation-bearing contact tag arms (lowercased lookup), or null. */
export function automationBearingContactTag(name) {
  return AUTOMATION_BEARING_CONTACT_TAGS[String(name || "").trim().toLowerCase()] || null;
}
