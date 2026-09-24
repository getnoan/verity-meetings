/**
 * Configuration that must be supplied, never guessed.
 *
 * These helpers exist because the alternative — `process.env.X || "someone@example.com"`
 * — shipped our own addresses into the open-source agent pack, where they would
 * have routed a stranger's customer mail to our inboxes and put our teammates on
 * their agents' authorisation list. The export's secret scan caught it on
 * 2026-09-14, before publication.
 *
 * The rule now: an address or an authorisation list has NO default in code. The
 * fleet's own values live in agents/config.defaults.env, which is on the export's
 * FORBIDDEN list and can never ship. Downstream, an unset value fails loudly at
 * startup or fails closed — it never silently picks someone.
 */

/** Fail loudly, at startup, naming what is missing and why it has no default. */
export function requireEnv(name, why) {
  const v = (process.env[name] || "").trim();
  if (!v) {
    console.error(`fatal: ${name} is not set, and it has no default.`);
    if (why) console.error(`  ${why}`);
    console.error(`  Set it in the environment (or .env) and run again.`);
    console.error(`  There is deliberately no fallback here: a wrong address sends somebody's mail to the wrong place.`);
    process.exit(1);
  }
  return v;
}

/** An unset list means NOBODY, never a built-in roster. Fails closed. */
export function envList(name) {
  return (process.env[name] || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** An unset address means "not configured", never a fallback recipient. */
export function envAddress(name) {
  const v = (process.env[name] || "").trim();
  return v || null;
}

/* ---- Who the agents are, and who counts as a teammate ----
 *
 * Same rule as the addresses above: nothing about OUR company is a default in
 * code, because these files ship in the public agent pack and a downstream
 * copy would otherwise sign as our agent, treat our staff as its teammates, or
 * link to our site. Our own values live in agents/config.defaults.env (not
 * exported); a downstream copy sets its own or gets a neutral behaviour. */

/** The domain whose addresses are teammates ("example.com"). Unset means only
 *  the COMMANDERS list steers — there is no built-in domain. */
export function teammateDomain() {
  return (process.env.TEAMMATE_DOMAIN || "").trim().toLowerCase().replace(/^@/, "") || null;
}

/** A commander, or anyone at the teammate domain. */
export function isTeammateEmail(email, commanders = new Set()) {
  const e = String(email || "").toLowerCase().trim();
  if (!e.includes("@")) return false;
  const d = teammateDomain();
  return commanders.has(e) || (!!d && e.endsWith(`@${d}`));
}

/** Internal = at the teammate domain. With no domain configured, nobody is
 *  internal, so every attendee reads as external — the safe direction for
 *  "is there an outside party in this meeting". */
export function isInternalEmail(email) {
  const d = teammateDomain();
  return !!d && String(email || "").toLowerCase().trim().endsWith(`@${d}`);
}

/** The agent's name, as it signs mail and stamps notes. AGENT_NAME, else a
 *  neutral "Agent" — never a name that belongs to someone else's fleet. */
export function agentName() {
  return (process.env.AGENT_NAME || "").trim() || "Agent";
}

/** The agent's NOAN identity ids. AGENT_IDENTITY_IDS / AGENT_IDENTITY_ID are
 *  the names the pack documents; the VERITY_* pair is read for the fleet's own
 *  workflows and services that still set it. */
export function agentIdentityIds() {
  const raw = process.env.AGENT_IDENTITY_IDS || process.env.AGENT_IDENTITY_ID
    || process.env.VERITY_IDENTITY_IDS || process.env.VERITY_IDENTITY_ID || "";
  return raw.split(",").map(x => x.trim()).filter(Boolean);
}

/** The canonical (writing) identity — the one assignVerity puts on a task. */
export function agentIdentityId() {
  return (process.env.AGENT_IDENTITY_ID || process.env.VERITY_IDENTITY_ID || "").trim() || agentIdentityIds()[0] || null;
}

/** Hyperlinks an outbound reply may contain. AGENT_ALLOWED_LINKS is a
 *  comma-separated list; unset means no links at all. */
export function allowedLinks() {
  return (process.env.AGENT_ALLOWED_LINKS || "").split(",").map(x => x.trim()).filter(Boolean);
}

/** The prompt line that states the link rule. */
export function linkRule() {
  const l = allowedLinks();
  if (!l.length) return "- Do not include any hyperlink; none is configured for you.";
  return l.length === 1
    ? `- The ONLY hyperlink allowed is ${l[0]}. Do not invent URLs.`
    : `- The ONLY hyperlinks allowed are ${l.join(", ")}. Do not invent URLs.`;
}

/** How prose refers to the agent. AGENT_PRONOUNS "she/her", "he/him" or
 *  anything else (they/them, the default and the neutral reading). */
export function pronouns() {
  const v = (process.env.AGENT_PRONOUNS || "").trim().toLowerCase();
  if (v.startsWith("she")) return { subj: "she", obj: "her", poss: "her" };
  if (v.startsWith("he")) return { subj: "he", obj: "him", poss: "his" };
  return { subj: "they", obj: "them", poss: "their" };
}
