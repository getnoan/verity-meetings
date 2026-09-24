#!/usr/bin/env node
/**
 * An agent's own task comment, marked so the agent can recognise it later.
 *
 * The Node half of design/agent_comment.py. Both compile the same strings from
 * agents/agent-comment-marker.json — see that file for why a marker exists at
 * all and why recognition is by SHAPE rather than by a valid signature.
 *
 * Pure: no network, no state. Signing needs AGENT_COMMENT_SECRET; recognition
 * needs nothing, which is the point.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { agentName } from "./required-env.mjs";

const SPEC = JSON.parse(readFileSync(new URL("./agent-comment-marker.json", import.meta.url), "utf8"));
const SIG_RX = new RegExp(SPEC.signature_pattern);
const SECRET_ENV = SPEC.sign.secret_env;

/** The signing secret, or "" when unset. Never logged. */
export function commentSecret() {
  return (process.env[SECRET_ENV] || "").trim();
}

/** The body with any signature line and trailing whitespace stripped — what
 *  gets signed, and what a reader should treat as the comment's actual text. */
export function stripSignature(text) {
  return String(text ?? "").replace(SIG_RX, "").replace(/\s+$/, "");
}

function digest(taskId, body, secret) {
  return createHmac(SPEC.sign.algorithm, secret)
    .update(`${taskId}\n${body}`)
    .digest("hex")
    .slice(0, SPEC.sign.digest_chars);
}

/** Does this text carry the agent-comment marker?
 *
 *  Shape only, deliberately: a missing or rotated secret must not turn the
 *  agent's own comments back into teammate instructions. Verification is
 *  verifyAgentComment below, and it reports rather than gates. */
export function hasAgentMarker(text) {
  return SIG_RX.test(String(text ?? ""));
}

/** { marked, valid, reason } — `valid` is meaningful only when `marked`.
 *  A marked comment that does not verify is still the agent's own as far as
 *  classification is concerned; the caller's job is to say so loudly. */
export function verifyAgentComment(text, taskId) {
  const s = String(text ?? "");
  const m = SIG_RX.exec(s);
  if (!m) return { marked: false, valid: false, reason: "no marker" };
  const secret = commentSecret();
  const got = /:v1:([0-9a-f]{16}|unsigned)⟧/.exec(m[0])[1];
  if (got === SPEC.unsigned_sig) {
    return { marked: true, valid: false, reason: `written without ${SECRET_ENV} — marked but unsigned` };
  }
  if (!secret) return { marked: true, valid: false, reason: `${SECRET_ENV} is not set — cannot verify` };
  const want = digest(taskId, stripSignature(s), secret);
  return got === want
    ? { marked: true, valid: true, reason: "" }
    : { marked: true, valid: false, reason: "signature does not match this body and task" };
}

/** The full comment text to post: a visible label, the body, and — when a
 *  secret is configured — the signature line.
 *
 *  Unsigned is allowed ONLY because a deployment whose key is genuinely the
 *  agent's own identity is already recognisable by creator.id; postTaskComment
 *  refuses the case where neither holds. */
export function buildAgentComment(body, taskId, { name = agentName() } = {}) {
  const text = `${name}${SPEC.label_suffix}\n${String(body ?? "").trim()}`;
  const secret = commentSecret();
  // ALWAYS a signature line. Emitting none when unsigned would make the comment
  // unrecognisable, which is the dangerous direction — see the marker JSON.
  const sig = secret ? digest(taskId, text, secret) : SPEC.unsigned_sig;
  return `${text}\n${SPEC.signature_template.replace("{sig}", sig)}`;
}

/** Characters buildAgentComment adds around a body: the label line and, when
 *  signing, the signature line. The writing side subtracts this before it
 *  trims, so the marker is never what gets cut. */
export function markerOverhead(name = agentName()) {
  const label = `${name}${SPEC.label_suffix}\n`.length;
  // The signed form is the longer one; budget for it either way.
  const sig = 1 + SPEC.signature_template.replace("{sig}", "f".repeat(SPEC.sign.digest_chars)).length;
  return label + sig;
}

export const MARKER_SPEC = SPEC;
