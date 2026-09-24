/**
 * How a human answers the agent — the same four sentences everywhere it asks.
 *
 * Every agent tells you what it did; most did not
 * tell you how to reply. The scheduled reports had this right first (the
 * "Acting on this report" footer in report-handles.mjs), and the deck, demo
 * and general lanes wrote their own good versions. The rest — SDR
 * escalations, the routed-to-a-specialist note, an agent-ideas park — ended
 * mid-sentence, leaving the reader to know the convention or guess.
 *
 * That matters most for the agents we are about to open-source: someone
 * running fact-alignment alone never sees this repo, only the email in front
 * of them, so the instruction has to travel WITH the artefact.
 *
 * Five shapes, and no more. The same five name the response in the agent's
 * capabilities fact, so the menu and the email say the same thing:
 *
 *   email       any email it sends — a reply becomes a task assigned to it
 *   report      a scheduled report — a reply naming handles ("do A1")
 *   comment     a task it is on or parked — a comment steers or releases it
 *   reassign    a parked task — putting the agent back on it is the hand-back
 *   human       nothing comes back; a person owns it end to end
 *   reportEmail the TASK a scheduled report files — the answer path is the
 *               report's email, and "this email" is the wrong words on a task
 *
 * The sixth is the task-surface twin of `report` and exists because the
 * original five are written for an EMAIL: "Reply to this email" is nonsense
 * in a task body, which is half of why the tasks stayed silent while the
 * emails did not.
 *
 * LANE_RESPONSE below is for the handful of lanes whose hand-back is
 * genuinely their own — a course RESUME, a PR push, a CI fix nobody hands
 * back at all. They live HERE rather than inline in each worker so this file
 * stays the one place the fleet's answer vocabulary is written down, and so
 * test-respond-by.mjs can check them against the capabilities fact.
 */
import { agentName, pronouns } from "./required-env.mjs";

/* The agent's name and pronouns are read at access time (getters), so the
 * same sentences serve any fleet: AGENT_NAME and AGENT_PRONOUNS (e.g.
 * "she/her"; unset reads they/them). Object.keys/values still enumerate them. */
export const RESPOND_BY = {
  get email() { return `Reply to this email and ${agentName()} picks it up as a task — your words first, this message quoted underneath as context.`; },
  get report() { return `Reply to this email naming items ("do A1", or "go ahead" for every [Specific] item) and ${agentName()} picks it up as a task.`; },
  get comment() { return `Comment on the task to steer ${pronouns().obj}: "@${agentName()} <what changed>", or the word the task names ("send", "retry") where it offers one.`; },
  get reassign() { return `Re-assign ${agentName()} on the task once you have fixed what it names — that is the hand-back, and ${pronouns().subj} picks it up on ${pronouns().poss} next poll.`; },
  get human() { return `Nothing comes back to ${agentName()} on this one — a person owns it end to end.`; },
  get reportEmail() { return `Reply to the report email this task points at and ${agentName()} picks it up as a task; name items ("do A1") where the report numbers them.`; },
};

/** Lanes whose hand-back is their own sentence, not one of the shapes. Each
 *  must agree with that lane's line in the agent's capabilities fact — the
 *  reader should not get two different answers depending on where they look,
 *  and test-respond-by.mjs asserts they do not. */
export const LANE_RESPONSE = {
  /* An approval, not a repair. The `reassign` shape says "once you have fixed
   * what it names", which is the wrong sentence on a task whose whole content
   * is a draft waiting for a yes. */
  /* Same getter arrangement as RESPOND_BY: name and pronouns at access time. */
  get "approval"() { return `Re-assign ${agentName()} on this task and ${pronouns().subj} acts on the draft above as it stands — that is the approval. Leave it unassigned to hold it, or close it to drop it.`; },
  get "pr-review"() { return `Nothing comes back to ${agentName()} here — this verdict is a PR review. Push a fix and ${pronouns().subj} reviews again on the next push; apply the override-review-gate label if a human is taking the call.`; },
  get "course"() { return `Fix what this task names, then start the course again by telling ${agentName()} (or the customer) RESUME — that is the hand-back, not a re-assign.`; },
  get "ci-alert"() { return `Nothing comes back to ${agentName()} — fix what this task names and close it yourself. A repeat failure appends a run line here rather than filing a second task.`; },
};

/** One line for a lane whose answer path is its own. Unknown lanes throw, for
 *  the same reason an unknown shape does. */
export function respondLineFor(lane) {
  if (!(lane in LANE_RESPONSE)) throw new Error(`respondLineFor: unknown lane "${lane}" — the lanes are ${Object.keys(LANE_RESPONSE).join(", ")}`);
  return `Respond by: ${LANE_RESPONSE[lane]}`;
}

/** One line, prefixed, joining the shapes given. Unknown shapes throw rather
 *  than printing a blank: a missing instruction is the bug this file fixes. */
export function respondLine(...kinds) {
  const parts = kinds.filter(Boolean).map((k) => {
    if (!(k in RESPOND_BY)) throw new Error(`respondLine: unknown shape "${k}" — the shapes are ${Object.keys(RESPOND_BY).join(", ")}`);
    return RESPOND_BY[k];
  });
  if (!parts.length) throw new Error("respondLine: name at least one shape");
  return `Respond by: ${parts.join(" ")}`;
}
