/**
 * The Booking Types fact → validated booking types.
 * Pure: the caller fetches the fact and passes the text.
 *
 * One `## <Name>` section per type, `key: value` lines, parsed leniently like
 * the Scheduling Agent Config (unknown keys are warnings, not failures). Text
 * above the first `##` is notes for humans. A type that fails validation is
 * SKIPPED and reported — never half-served — while the others still load.
 *
 *   ## Demo
 *   link: alex/demo
 *   host: alex@example.com
 *   host name: Alex Founder
 *   length minutes: 30
 *   questions:
 *   - Company | company | required
 *   contact tags: Lead, Demo Booked
 *   on book: task owner host
 *   on cancel: close task
 *
 * Routing comes ONLY from this fact, never from anything a guest types: the
 * tags a booking applies and the agent it hands to are fixed per type.
 */

import { parseWindows, WEEKDAYS } from "./slots.mjs";

const SLUG_RX = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Question kinds. `field` names the NOAN contact field (API casing) an answer may fill
 *  (only when the contact's field is empty); the rest go in the memo only. */
export const QUESTION_KINDS = {
  text:     { input: "text" },
  long:     { input: "textarea" },
  company:  { input: "text" },
  title:    { input: "text" },
  website:  { input: "url", field: "website" },
  phone:    { input: "tel", field: "phoneNumber" },
  linkedin: { input: "url" },
  location: { input: "text" },
};
export const MAX_QUESTIONS = 10;

const LIMITS = {
  "length minutes":   ["lengthMin", 5, 480],
  "step minutes":     ["stepMin", 5, 240],
  "buffer minutes":   ["bufferMin", 0, 240],
  "min notice hours": ["minNoticeHours", 0, 720],
  "max days out":     ["maxDaysOut", 1, 365],
};
const TEXT_KEYS = { title: 200, description: 1000, "host name": 80 };
/** `timezone: Europe/Berlin` pins the zone this type's `hours` lines are read in. Without
 *  it the host's Google Calendar zone is used (so their hours travel with them), and
 *  without that the Scheduling Agent Config's zone. */
const isTz = tz => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };
/** `verity brief:` offers the guest a "brief me before the call" switch:
 *  customer = the agent researches their company, investor = their fund. The guest's tick is a
 *  bounded boolean that can only start this one, fact-named action: a deliberate exception to
 *  "guest input never routes". */
export const BRIEF_VARIANTS = ["customer", "investor", "account"];
/** What a person writes in the fact → the variant. "account" is the customer-success brief:
 *  the booker already uses NOAN, so it suggests what they are not using yet. */
export const BRIEF_ALIASES = { "customer success": "account", "existing customer": "account", success: "account" };
const KNOWN = new Set(["link", "host", "questions", "contact tags", "on book", "on cancel", "verity brief", "timezone", "blocked dates",
  ...Object.keys(LIMITS), ...Object.keys(TEXT_KEYS)]);

/**
 * @param {string} text the fact content
 * @param {{ triggerTags?: string[] }} opts  tags `on book: task tag <X>` may name
 *        (pass DEFAULT_TRIGGER_TAGS from trigger-tags.mjs); canonical casing is kept
 * @returns {{ types: object[], errors: string[], warnings: string[] }}
 */
export function parseBookingTypes(text, { triggerTags = [] } = {}) {
  const types = [], errors = [], warnings = [];
  const sections = String(text || "").split(/^##[ \t]+/m).slice(1);
  const links = new Set();
  for (const section of sections) {
    const [head, ...lines] = section.split("\n");
    const name = head.trim();
    const errs = [];
    const t = { name, questions: [], contactTags: [], onBook: { kind: "owner", who: "host" }, onCancel: { kind: "close" }, weekHours: null, brief: null, timeZone: null, blockedDates: null };
    let inQuestions = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue; // blank lines and # comments
      if (line.startsWith("-")) {
        if (!inQuestions) { warnings.push(`${name}: stray list line "${line.slice(0, 40)}" ignored`); continue; }
        const q = parseQuestion(line.slice(1), errs);
        if (q) t.questions.push(q);
        continue;
      }
      const m = /^([a-z][a-z ]*?)\s*:\s*(.*)$/i.exec(line);
      if (!m) { warnings.push(`${name}: line "${line.slice(0, 40)}" ignored`); continue; }
      const key = m[1].toLowerCase(), val = m[2].trim();
      inQuestions = key === "questions";
      const hours = /^hours (mon|tue|wed|thu|fri|sat|sun)\w*$/.exec(key);
      if (hours) {
        const day = WEEKDAYS.find(d => d.toLowerCase() === hours[1]);
        const w = parseWindows(val);
        if (w === null) errs.push(`hours ${day}: "${val}" is not HH:MM-HH:MM or "off"`);
        else (t.weekHours ||= {})[day] = w;
        continue;
      }
      if (!KNOWN.has(key)) { warnings.push(`${name}: unknown key "${key}" ignored`); continue; }
      if (key === "link") {
        const [handle, slug, extra] = val.toLowerCase().split("/");
        if (extra !== undefined || !SLUG_RX.test(handle || "") || !SLUG_RX.test(slug || "")) errs.push(`link "${val}" must be <host>/<slug> in lowercase letters, digits and dashes`);
        else { t.handle = handle; t.slug = slug; }
      } else if (key === "host") {
        if (!EMAIL_RX.test(val)) errs.push(`host "${val}" is not an email address`);
        else t.host = val.toLowerCase();
      } else if (key in LIMITS) {
        const [prop, lo, hi] = LIMITS[key];
        const n = Number(val);
        if (!Number.isInteger(n) || n < lo || n > hi) errs.push(`${key} must be a whole number from ${lo} to ${hi}`);
        else t[prop] = n;
      } else if (key in TEXT_KEYS) {
        t[key === "host name" ? "hostName" : key] = val.slice(0, TEXT_KEYS[key]);
      } else if (key === "blocked dates") {
        // this host's days off, instead of the Scheduling Agent Config's (which are the
        // config owner's). "none" clears them; a calendar's own all-day events still block.
        const days = val.toLowerCase() === "none" ? [] : val.split(/[,\s]+/).filter(Boolean);
        const bad = days.filter(d => !/^\d{4}-\d{2}-\d{2}$/.test(d));
        if (bad.length) errs.push(`blocked dates: "${bad.join(", ")}" is not YYYY-MM-DD`);
        else t.blockedDates = new Set(days);
      } else if (key === "timezone") {
        if (!isTz(val)) errs.push(`timezone "${val}" is not an IANA zone like Europe/Berlin`);
        else t.timeZone = val;
      } else if (key === "verity brief") {
        const v = val.toLowerCase();
        if (v === "off" || v === "no" || v === "") t.brief = null;
        else if (BRIEF_VARIANTS.includes(BRIEF_ALIASES[v] || v)) t.brief = BRIEF_ALIASES[v] || v;
        else errs.push(`verity brief "${val}" should be customer, investor, account (customer success) or off`);
      } else if (key === "contact tags") {
        t.contactTags = [...new Set(val.split(",").map(s => s.trim()).filter(Boolean))];
      } else if (key === "on book") {
        const r = parseRoute(val, { triggerTags, allowOwner: true });
        if (r.error) errs.push(`on book: ${r.error}`); else t.onBook = r;
      } else if (key === "on cancel") {
        const r = parseRoute(val, { triggerTags, allowOwner: false });
        if (r.error) errs.push(`on cancel: ${r.error}`); else t.onCancel = r;
      }
    }
    if (!name) errs.push("a ## heading needs a name");
    if (!t.slug) errs.push("link is required");
    if (!t.host) errs.push("host is required");
    if (!t.lengthMin) errs.push("length minutes is required");
    if (t.questions.length > MAX_QUESTIONS) errs.push(`at most ${MAX_QUESTIONS} questions`);
    const link = t.slug && `${t.handle}/${t.slug}`;
    if (link && links.has(link)) errs.push(`link ${link} is already used by an earlier type`);
    if (errs.length) { errors.push(`${name || "(unnamed)"}: ${errs.join("; ")}`); continue; }
    links.add(link);
    t.stepMin ??= Math.min(t.lengthMin, 30);
    t.title ||= "{type} with {guest}";
    types.push(t);
  }
  return { types, errors, warnings };
}

function parseQuestion(text, errs) {
  const [label, kindRaw = "text", ...flags] = text.split("|").map(s => s.trim());
  const kind = kindRaw.toLowerCase();
  if (!label) { errs.push("a question needs a label"); return null; }
  if (!QUESTION_KINDS[kind]) { errs.push(`question "${label}": kind "${kindRaw}" is not one of ${Object.keys(QUESTION_KINDS).join(", ")}`); return null; }
  const required = flags.some(f => /^required$/i.test(f));
  return { label: label.slice(0, 80), kind, required, input: QUESTION_KINDS[kind].input, field: QUESTION_KINDS[kind].field || null };
}

/** `task owner host|agent`, `task tag <Trigger Tag>`, `no task` (book);
 *  `task owner verity` is the older spelling of `task owner agent`, still read, still "verity" inside;
 *  `close task`, `keep task`, `task tag <Trigger Tag>` (cancel). */
function parseRoute(val, { triggerTags, allowOwner }) {
  const v = val.trim();
  let m;
  if (allowOwner && (m = /^task owner (host|verity|agent)$/i.exec(v))) return { kind: "owner", who: m[1].toLowerCase() === "host" ? "host" : "verity" };
  if (allowOwner && /^no task$/i.test(v)) return { kind: "none" };
  if (!allowOwner && /^close task$/i.test(v)) return { kind: "close" };
  if (!allowOwner && /^keep task$/i.test(v)) return { kind: "keep" };
  if ((m = /^task tag (.+)$/i.exec(v))) {
    const tag = triggerTags.find(t => t.toLowerCase() === m[1].trim().toLowerCase());
    if (!tag) return { error: `"${m[1].trim()}" is not an agent trigger tag (${triggerTags.join(", ") || "none loaded"})` };
    return { kind: "tag", tag };
  }
  return { error: allowOwner
    ? `"${v}" should be "task owner host", "task owner agent", "task tag <tag>" or "no task"`
    : `"${v}" should be "close task", "keep task" or "task tag <tag>"` };
}

/** Fill a type's title template: {type}, {guest}, {host}. */
export function renderTitle(type, { guest = "", host = "" } = {}) {
  return type.title
    .replace(/\{type\}/g, type.name)
    .replace(/\{guest\}/g, guest)
    .replace(/\{host\}/g, host)
    .replace(/\s+/g, " ").trim();
}
