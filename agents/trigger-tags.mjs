/**
 * Trigger-tag registry: the one source of truth for which NOAN task tags a
 * deployed worker polls. The belt's allowed tags, the board sweep's runner
 * list, and CUSTOMER_FACING_TAGS all derive from it.
 *
 * Adding or retiring an agent is one entry here, in the same diff as the
 * worker. Tag names must match NOAN tag names exactly. findTagId is
 * case-insensitive but literal, so a near-miss ("follow-up" vs "follow up")
 * resolves to nothing and the task lands untagged where no agent sees it.
 *
 * customerFacing means "this trigger fires an email into a real customer's
 * inbox". "follow up" stays outside that set on purpose: it is due-date-gated,
 * mostly armed by automation, and outside the confirm/park set.
 */

export const TRIGGER_TAG_REGISTRY = [
  { tag: "follow up",  worker: "worker.mjs",                          customerFacing: false },
  { tag: "onboard",    worker: "onboard-worker.mjs",                  customerFacing: true },
  { tag: "reengage",   worker: "reengage-worker.mjs",                 customerFacing: true },
  { tag: "activation", worker: "activation-worker.mjs",               customerFacing: true },
  { tag: "course offer", worker: "course-worker.mjs (runOfferBeat)",  customerFacing: true },
  // No "trial" entry: no trial worker runs, so a route to it would be a dead one.
  { tag: "support",    worker: "reply-worker.mjs (scanSupportTasks)", customerFacing: false },
  { tag: "Social",     worker: "social-worker.mjs",                   customerFacing: false },
  { tag: "LinkedIn",   worker: "linkedin-worker.mjs",                 customerFacing: false },
  { tag: "Marketing",  worker: "marketing-worker.mjs",                customerFacing: false, gate: "MARKETING_ENABLED" },
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
  // question task someone assigns the agent to, since the belt has no Smartlead
  // lever. Applied by sdr-reply-worker only. The belt cannot route to it usefully: a
  // task it filed has no sdr-reply: externalId and is left alone.
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
  // and claimed by agent-ideas-worker from BACKLOG. Must stay registered: otherwise the
  // general lane reads it as untagged, claims it and moves it to in-progress, a status the
  // specialist cannot claim from. route_to_specialist resets the task to backlog, so a
  // mis-claim self-heals.
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

/** Whether a registered trigger's enable switch is on, as far as THIS process can see:
 *  "on" (no gate, or the gate reads "1"), "off" (the gate variable is present and is anything
 *  else), or "unknown" (gated, and the variable is not in this environment at all).
 *
 *  "unknown" is deliberately not "off": a run without the gate variables (a local run, a
 *  workflow that does not pass GATE_VARS) must not refuse every gated route. "off" is what lets
 *  a caller refuse a route whose specialist is switched off instead of promising work nobody does. */
export function gateState(entry, env = process.env) {
  if (!entry?.gate) return "on";
  const v = env[entry.gate];
  // Empty counts as absent: `${{ vars.X }}` renders "" when the repo variable is not defined (a
  // fork, a fresh install), and reading that as "off" would refuse the route on a guess.
  if (v === undefined || String(v).trim() === "") return "unknown";
  return String(v).trim() === "1" ? "on" : "off";
}

/** Every enable switch the registry names. A workflow that routes to, or audits, these triggers
 *  must pass each one in its env, or a switched-off specialist reads as "unknown" there. */
export const GATE_VARS = [...new Set(TRIGGER_TAG_REGISTRY.map(e => e.gate).filter(Boolean))];

/* ---------------- pipeline records ----------------
 * Some tasks on the board are STATE, not work. The company website's site-preview
 * magnet (site-preview.functions.ts captureLead) opens one task per preview,
 * and every step of that flow — build, expand, claim kit, concierge claim — is
 * a stamp line in the task's details, read back by site-preview-fulfil-worker
 * and by the page itself. The investor-portal flow uses the same machinery.
 * Nobody is owed anything on such a task until a stamp line says so, and its
 * resting state is no status and no assignee.
 *
 * "Assigned, no trigger tag" is the general lane's own trigger, so an assigned
 * record would be claimed and routed to Site Build, which nobody asked for.
 * "Site Preview" is deliberately NOT a registry entry (no worker polls it), so
 * this predicate is the one shared answer to "is this a job?", used by the belt
 * (never claim), the route and retag tools (never apply a trigger tag), and the
 * board sweep (never a dropped assignment, never an "open with no status" defect).
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
 * fact. ONE parser for every surface (voice-agent, general-worker).
 *
 * The NOAN UI markdown-escapes underscores, so the live fact can read
 * "TRIGGER\_TAGS:" and the match must accept it. Values get the same
 * treatment: a tag wrapped in backticks or bold markers is still that tag.
 *
 * NARROW-ONLY: the line can disable a route with no deploy, but it can never
 * invent one. A named tag with no registry entry (no deployed worker) is
 * ignored with a warning, because routing to it would create tasks nothing
 * ever picks up. No line, or a line with no valid
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

  // Narrowing is legitimate, but never silently: log every registered worker the
  // line leaves out, or it becomes undelegatable with nothing saying why.
  // sync-general-trigger-tags.mjs brings the fact back in line.
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
 * ONE list for every worker that asks this: the onboarding intake, the agent-ideas guard, the
 * course's still-a-customer check, and the course-start ask in reply-worker. Never hardcode
 * "subscriber" in one of them.
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
 *  Never gate on raw volume: a launch surge is hundreds of real signups whose records are
 *  minutes old, and a raw count would block them and every later run. A backfill is old
 *  records suddenly acquiring a tag. Age tells them apart; volume does not.
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
  "trial":           "cancels queued follow-ups (the trial-conversion sweep it once armed is retired)",
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
