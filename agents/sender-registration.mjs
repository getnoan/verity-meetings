/**
 * sender-registration.mjs: is the address an email came from the one on the sender's NOAN record?
 *
 * The reply worker answers whoever writes. When a known customer writes from a second address
 * (a personal gmail beside the work address they signed up with), nothing used to notice:
 * the address was not a contact, so a fresh untagged contact was created and the customer was
 * treated as a stranger. In one live case the customer also asked for the email course from the
 * second address, was routed to the support reply instead, and was told "you're enrolled" when
 * nothing had been set up.
 *
 * Three decisions live here, all pure except the one database read:
 *
 *   nameMatchUserContact()  an unknown sender whose name matches a Free/Subscriber contact on a
 *                           different address is probably that person. The reply worker then
 *                           creates NO contact (a duplicate would count one account twice) and
 *                           asks them to write from the address they signed up with.
 *   needsNotice()           given which addresses sign in (the `logins` Set from the
 *                           account-lookup lane: the app's identities table, read-only, our
 *                           fleet only), an untagged contact whose address is not a login gets
 *                           the "not on record" line once; a login does not. Without the lane
 *                           (the open-source pack) `logins` is null and nothing is ever said.
 *   claimsAccountAction()   a drafted reply that says it enrolled, upgraded or signed someone up.
 *                           Neither reply agent has a tool that can do any of those, so such a
 *                           sentence is always false and the draft goes to a human instead.
 *
 * NEVER name the address on file in anything sent. The sender has not proven who they are; the
 * line asks them to use "the address you signed up with" and the human gets the match in a memo.
 */

import { isUserContact } from "./trigger-tags.mjs";

/** How long one sender is told once, before it is said again. */
export const NOTICE_EVERY_DAYS = 30;
/** A second redirect inside this window means they want this address: a human decides. */
export const REDIRECT_WINDOW_DAYS = 14;

/** "Dr. Jane  Doe" and "jane doe" match; one-word names never do (too many collisions). */
export function normName(name) {
  const n = String(name || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s'-]/g, " ").replace(/\s+/g, " ").trim();
  return n.split(" ").length >= 2 ? n : "";
}

/** The Free/Subscriber contact this unknown sender probably is, or null.
 *  Same normalised full name, a different address, and a user tag on the existing record:
 *  a lead or an investor sharing a name is not evidence of a subscriber's second address. */
export function nameMatchUserContact(contacts, senderEmail, displayName) {
  const want = normName(displayName);
  if (!want) return null;
  const email = String(senderEmail || "").toLowerCase();
  return (contacts || []).find(c =>
    normName(c?.name) === want &&
    String(c?.email || "").toLowerCase() !== email &&
    isUserContact(c)) || null;
}

/** Should this sender be told their address is not on record?
 *  Only an UNTAGGED contact (a tagged one is a known relationship: an investor, a lead, a
 *  partner), whose address is not a NOAN login, and not told within NOTICE_EVERY_DAYS. */
export function needsNotice({ contact, senderEmail, logins, lastNoticeAt, now = Date.now() }) {
  if (!logins) return false;                                   // unknown: never guess
  if ((contact?.tags || []).length) return false;
  if (logins.has(String(senderEmail || "").toLowerCase())) return false;
  if (lastNoticeAt && now - Date.parse(lastNoticeAt) < NOTICE_EVERY_DAYS * 86400_000) return false;
  return true;
}

export const noticeText = (company) =>
  `One thing: I don't have this email address on record. If you have a ${company} account, ` +
  `please write to me from the address you signed up with, so I can see your account.`;

const escRx = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A closing paragraph: short, and carrying the agent's name ("<name>", "Best,\n<name>"). */
function isSignoff(paragraph, agentName) {
  const t = String(paragraph || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return !!agentName && t.length > 0 && t.length <= 60 && new RegExp(`\\b${escRx(agentName)}\\b`, "i").test(t);
}

/** The notice added to a drafted reply as its own paragraph: before the sign-off when the draft
 *  ends with one (the reply Playbook closes every message by signing as the agent), else last.
 *  Below the signature it reads as a second message. */
export function withNotice({ html, text }, company, agentName) {
  const line = noticeText(company);
  let outText = text;
  if (text) {
    const paras = text.trimEnd().split(/\n{2,}/);
    if (paras.length > 1 && isSignoff(paras.at(-1), agentName)) paras.splice(-1, 0, line);
    else paras.push(line);
    outText = paras.join("\n\n");
  }
  let outHtml = html;
  if (html) {
    const ps = [...html.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/gi)];
    const last = ps.at(-1);
    outHtml = ps.length > 1 && isSignoff(last[0], agentName)
      ? `${html.slice(0, last.index)}<p>${line}</p>\n${html.slice(last.index)}`
      : `${html}\n<p>${line}</p>`;
  }
  return { html: outHtml, text: outText };
}

/** The whole reply to a probable second address. Deterministic: no model, nothing to ground. */
export function redirectReply({ agentName, company }) {
  const text =
    `Thanks for getting in touch. I don't have this email address on record. ` +
    `If you have a ${company} account, please write to me from the address you signed up with ` +
    `and I'll pick it up from there.\n\n${agentName}`;
  return { text, html: text.split("\n\n").map(p => `<p>${p}</p>`).join("\n") };
}

/** The reply to a course request from an address with no Free/Subscriber record. */
export function courseAccountReply({ agentName, company }) {
  const text =
    `Thanks for asking about the email course. It runs on the email address you signed up to ` +
    `${company} with, and I can't see a ${company} subscription on this one. Please email me from ` +
    `the address you signed up with and tell me what you'd like to learn, and the first lesson ` +
    `will follow within minutes.\n\n${agentName}`;
  return { text, html: text.split("\n\n").map(p => `<p>${p}</p>`).join("\n") };
}

/** Is a redirect to this sender a repeat inside REDIRECT_WINDOW_DAYS? */
export function redirectedRecently(lastAt, now = Date.now()) {
  return !!lastAt && now - Date.parse(lastAt) < REDIRECT_WINDOW_DAYS * 86400_000;
}

const ACCOUNT_ACTION_RX = new RegExp([
  String.raw`\b(?:i(?:'ve| have)|we(?:'ve| have))\s+(?:now\s+|just\s+)?(?:enrolled|signed|added|subscribed|registered|upgraded|downgraded|moved|switched|refunded|credited)\s+you\b`,
  String.raw`\b(?:i(?:'ve| have)|we(?:'ve| have))\s+(?:now\s+|just\s+)?(?:enrolled|registered|subscribed)\b`,
  String.raw`\byou(?:'re| are)\s+(?:now\s+|all\s+)?(?:enrolled|signed up|registered|subscribed|upgraded)\b`,
  String.raw`\b(?:signed you up|confirmed (?:your )?enrol+ment|enrol+ment (?:is )?confirmed)\b`,
].join("|"), "i");

/** True when a draft claims an enrollment or account change the agent cannot make.
 *  Deliberately narrow: "you can enroll by…" and "the course is for subscribers" pass. */
export function claimsAccountAction(text) {
  return ACCOUNT_ACTION_RX.test(String(text || "").replace(/[‘’]/g, "'"));
}
