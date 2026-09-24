/**
 * Load agents/config.defaults.env into process.env — only keys that are NOT
 * already set — so a worker sees the same non-secret defaults wherever it runs.
 *
 * In GitHub Actions the workflows do this in a step (poller.yml:
 * `grep -Ev '^\s*(#|$)' agents/config.defaults.env >> "$GITHUB_ENV"`), so every
 * Actions worker has VERITY_IDENTITY_IDS, HUMAN_IDENTITIES, PARK_ASSIGNEES_* and
 * the rest. The Render services do not (render.yaml lists only the secrets and a
 * handful of service knobs), so the same worker started by
 * a Render service saw NONE of them: parkForHuman resolved no human
 * ("NO HUMAN RESOLVED … set PARK_ASSIGNEES_ENG"), verityIds() was empty, and a
 * park from Render would have been handed to nobody. Found 2026-09-11 while
 * giving a Render-hosted claim an owner. The file ships in the image (the
 * service's Dockerfile copies agents/), so reading it from disk is the one
 * answer that works in both. A checkout without the file loads nothing.
 *
 * Secrets never live in that file, and an already-set value always wins, so
 * calling this in Actions is a no-op and calling it on Render fills the gaps.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const CONFIG_DEFAULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.defaults.env");

/** Parse KEY=VALUE lines (comments and blanks skipped; no quoting, no
 *  interpolation — the file is written that way on purpose). Pure. */
export function parseConfigDefaults(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Fill process.env from the defaults file. Returns the keys it set. Never
 *  throws: a missing file means "nothing to fill", and the worker's own
 *  assertNoanKey / required() checks report what is actually absent. */
export function loadConfigDefaults({ env = process.env, path = CONFIG_DEFAULTS_PATH, log = () => {} } = {}) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const set = [];
  for (const [k, v] of Object.entries(parseConfigDefaults(text))) {
    if (env[k] === undefined || env[k] === "") { env[k] = v; set.push(k); }
  }
  if (set.length) log(`config defaults: ${set.length} key(s) filled from ${path}`);
  return set;
}
