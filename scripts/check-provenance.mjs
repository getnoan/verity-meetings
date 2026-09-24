#!/usr/bin/env node
/**
 * Provenance check — CI only; there is nothing here to run by hand.
 *
 * This repo is a GENERATED export of an upstream repo. Every export deletes the
 * whole tree except .git and re-stages it from upstream sources, so only the
 * downstream-owned files below survive (they are restored from this repo's own
 * HEAD). An edit to anything else — including a brand-new file the export has
 * never heard of — is silently reverted the next time the export runs.
 *
 * The generated files here (INSTALL.md, ci.yml, schema.sql, the seeds) are rewritten
 * from upstream on every export; README, LICENSE and SECURITY are yours.
 *
 * Export branches are exempt: they ARE the upstream sources arriving, so they
 * are expected to touch everything.
 */

import { execFileSync } from "node:child_process";

const DOWNSTREAM_OWNED = new Set(["README.md","LICENSE","SECURITY.md"]);
const EXPORT_BRANCH_PREFIX = "export/";
/* A fork is not an export target. Someone following the README adds a workflow,
 * a worker and a seed script in their own copy; none is downstream-owned HERE,
 * and "port the change upstream" does not apply to them. So the check is a
 * no-op anywhere but the canonical repository. */
const CANONICAL_REPO = "getnoan/verity-meetings";
if (CANONICAL_REPO && process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== CANONICAL_REPO) {
  console.log(`provenance: this is ${process.env.GITHUB_REPOSITORY}, not ${CANONICAL_REPO} — a fork keeps whatever it adds; nothing to check.`);
  process.exit(0);
}

const eventName = process.env.GITHUB_EVENT_NAME || "";
const headRef = process.env.PR_HEAD_REF || "";

if (eventName !== "pull_request") {
  console.log("provenance: not a pull_request event (" + (eventName || "no event") + ") — nothing to check.");
  process.exit(0);
}

/* A pull_request event with no branch name means the workflow didn't pass
 * github.head_ref. Skipping would be indistinguishable from a clean pass,
 * which is the one outcome a check like this must never fake. */
if (!headRef) {
  console.error("provenance: pull_request event but PR_HEAD_REF is empty — the workflow must pass github.head_ref.");
  console.error("Refusing to report an unchecked PR as clean.");
  process.exit(1);
}

if (headRef.startsWith(EXPORT_BRANCH_PREFIX)) {
  console.log("provenance: '" + headRef + "' is an export branch — it carries the upstream sources by definition. Skipping.");
  process.exit(0);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/* On a pull_request event HEAD is refs/pull/N/merge, so HEAD^1 IS the base tip
 * and `git diff HEAD^1 HEAD` is exactly this PR's diff. The workflow checks
 * out with fetch-depth: 2 so that parent already exists; deepen rather than
 * assume it, so a shallow clone fails loudly here instead of obscurely below. */
// stdio ignored: on a shallow clone this probe FAILING is the normal path, and
// git's "fatal: Needed a single revision" on stderr reads like a broken check.
try { execFileSync("git", ["rev-parse", "--verify", "HEAD^1"], { stdio: "ignore" }); }
catch { git(["fetch", "--quiet", "--deepen=1", "origin"]); }

const changed = git(["diff", "--name-only", "HEAD^1", "HEAD"])
  .split("\n").map(l => l.trim()).filter(Boolean);

const reverted = changed.filter(f => !DOWNSTREAM_OWNED.has(f));

if (!reverted.length) {
  console.log("provenance: ✓ " + changed.length + " changed file(s), all downstream-owned.");
  process.exit(0);
}

console.error("provenance: this PR edits files that the next export will revert.");
console.error("");
for (const f of reverted) console.error("  " + f);
console.error("");
console.error("Only these files are downstream-owned and survive an export:");
for (const f of DOWNSTREAM_OWNED) console.error("  " + f);
console.error("");
console.error("Everything else here — including any new file — is re-staged from the upstream");
console.error("repo on every export, which deletes the whole tree except .git.");
console.error("");
console.error("To land this change for real, pick one:");
console.error("  1. Port the change upstream. It arrives back here on the next");
console.error("     " + EXPORT_BRANCH_PREFIX + "* PR.");
console.error("  2. If the file SHOULD be downstream-owned, add it to DOWNSTREAM_OWNED in");
console.error("     scripts/export-meetings.mjs upstream, then re-open this PR.");
process.exit(1);
