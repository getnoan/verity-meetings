/**
 * API spend ledger. Every paid API call in the fleet appends one row
 * to the Supabase `api_usage` table via recordUsage(); spend-worker.mjs reads
 * it back daily and reports to the operator.
 *
 * Design rules (non-negotiable):
 *   - recordUsage NEVER rejects and NEVER throws. A Supabase outage must cost
 *     an agent at most the 10s timeout, never a failure. Missing creds or
 *     USAGE_LOG=0 → silent no-op.
 *   - Append-only: one INSERT per API call, its own table — deliberately NOT
 *     an agent_state row, whose read-modify-write drops concurrent appends
 *     (see the sent-log comment in resend.mjs). Overlapping workflows can't
 *     clobber each other here.
 *   - cost_usd is an ESTIMATE from the PRICING table below. Billed truth comes
 *     from the Anthropic Admin cost_report; spend-worker reconciles the two.
 *     New model id ⇒ add it to PRICING in the same PR (the report warns on
 *     unpriced rows so this can't rot silently).
 *
 * One-time setup: create `public.api_usage` in the Supabase SQL editor with
 * the columns recordUsage() writes below (plus an `at` timestamp defaulting to
 * now()). RLS on, no policies — service-role only.
 */

import path from "node:path";

const TIMEOUT_MS = 10_000;

/* Per-MTok USD for Anthropic; per-unit USD for the rest (unit = char for
 * elevenlabs, scrape/search for firecrawl, recipient for resend). Cache read
 * bills at 0.1× input, cache write at 1.25× input. */
export const PRICING = {
  anthropic: {
    "claude-opus-5":     { in: 5, out: 25 },
    "claude-opus-4-8":   { in: 5, out: 25 },
    "claude-sonnet-5":   { in: 2, out: 10 },
    "claude-sonnet-4-6": { in: 3, out: 15 },
    "claude-haiku-4-5":  { in: 1, out: 5 },
  },
  // ~Creator tier $/char at list. An install on a grant or a flat plan sets
  // ELEVENLABS_USD_PER_CHAR (0 for a grant) and the ledger keeps the
  // characters (units) without inventing dollars; a list-price estimate on
  // a free plan once made up most of a voice surface's "spend" and tripped
  // its daily budget shutoff (2026-09-24).
  elevenlabs: { perUnit: process.env.ELEVENLABS_USD_PER_CHAR !== undefined ? parseFloat(process.env.ELEVENLABS_USD_PER_CHAR) || 0 : 0.00022 },
  firecrawl:  { perUnit: 0.001 },    // ~1 credit per scrape/search
  resend:     { perUnit: 0.0004 },   // flat plan amortized; pure estimate
  // X pay-per-use reads vary by kind ($0.001 owned reads → $0.01 user reads),
  // so x-prospector passes an explicit costUsd on every row; this floor rate
  // only prices rows that somehow arrive without one.
  x:          { perUnit: 0.001 },
  // treg meters each call itself and returns the billed price in the
  // X-Treg-Cost-Micro response header; treg.mjs passes that exact costUsd on
  // every row. This floor only prices rows that somehow arrive without one.
  treg:       { perUnit: 0.001 },
};

/** Anthropic rate for a model id, tolerating dated snapshot ids.
 *
 *  PRICING is keyed by alias (`claude-haiku-4-5`), but callers log whatever id
 *  they passed to the API, and a dated snapshot id is equally valid there —
 *  `claude-haiku-4-5-20251001` is the same model at the same price. Exact
 *  lookup missed it, so 449 of the 650 Haiku rows since 2026-07-01 priced at
 *  $0 and silently undercounted every total that included them. Strip a
 *  trailing -YYYYMMDD and retry: no current alias ends in an 8-digit date, so
 *  this can only ever turn a miss into the right rate. An id that is genuinely
 *  absent still returns undefined and is reported by the unpriced warning. */
export function anthropicRate(model) {
  const table = PRICING.anthropic;
  return table[model] || table[String(model || "").replace(/-\d{8}$/, "")];
}

/** Estimated USD for one call. Unknown provider/model → 0 (row still logged;
 *  spend-worker flags unpriced rows). */
export function estimateCost({ provider, model, usage, units }) {
  const p = PRICING[provider];
  if (!p) return 0;
  if (provider === "anthropic") {
    const rate = anthropicRate(model);
    if (!rate || !usage) return 0;
    const inTok = usage.input_tokens || 0;
    const outTok = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    return (rate.in * inTok + rate.out * outTok + rate.in * 0.1 * cacheRead + rate.in * 1.25 * cacheWrite) / 1e6;
  }
  return (p.perUnit || 0) * (Number(units) || 0);
}

/* Agent label defaults to the entry-point filename so the 13 inline clients
 * need zero label plumbing: reengage-worker.mjs → "reengage". Sub-agents that
 * run under another worker's process inherit its label, which is the correct
 * attribution (the workflow process IS the agent). */
const ENTRY_ALIASES = { worker: "followup" };

function entryAgent() {
  try {
    const base = path.basename(process.argv[1] || "", ".mjs").replace(/-worker$/, "");
    if (!base) return "unknown";
    return ENTRY_ALIASES[base] || base;
  } catch { return "unknown"; }
}

let ctx = {};

/** Module-level label override — the demo pipeline sets
 *  { agent: "demo", action: "demo-video" } once at the top of each script.
 *
 *  `action` is a LABEL, not an identity: the spend report keys its per-line
 *  breakdown on `agent/action`, so a per-session or per-person value there
 *  makes every session its own line ("voice-home/<session-uuid>" once topped a
 *  day's spend with 16 such lines behind it). A per-run handle
 *  goes in `runId`, which lands in the row's `run_id` column — the same
 *  column CI fills with GITHUB_RUN_ID — where it is queryable without ever
 *  being a label. */
export function setUsageContext(next = {}) {
  ctx = { ...next };
}

/**
 * Append one row to api_usage. Fire-and-await-safe: resolves in all cases.
 *   usage   Anthropic usage object (input_tokens, output_tokens, cache_*)
 *   units   provider-native quantity for non-token providers
 *   costUsd override; omitted → estimateCost()
 */
export async function recordUsage({ agent, action, provider, model, usage, units, costUsd, at } = {}) {
  try {
    if (process.env.USAGE_LOG === "0") return;
    const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key || !provider) return;

    const row = {
      agent: agent || ctx.agent || entryAgent(),
      action: action || ctx.action || "",
      provider,
      model: model || null,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      cache_read_tokens: usage?.cache_read_input_tokens ?? null,
      cache_write_tokens: usage?.cache_creation_input_tokens ?? null,
      units: units ?? null,
      cost_usd: costUsd ?? estimateCost({ provider, model, usage, units }),
      run_id: ctx.runId || process.env.GITHUB_RUN_ID || null,
    };
    if (at) row.at = at;

    const res = await fetch(`${base}/rest/v1/api_usage`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify([row]),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`usage-log: Supabase ${res.status}: ${(await res.text().catch(() => "")).slice(0, 150)}`);
    }
  } catch (e) {
    console.error(`usage-log: skipped (${e?.message?.slice(0, 120) || e})`);
  }
}

/**
 * All rows with since <= at < until (ISO strings), oldest first. Paginates in
 * 1000-row pages. THROWS on error — only spend-worker calls this, and a failed
 * report should alert, not silently report zero spend.
 */
/** What a ledger row costs at TODAY's rates. Stored cost_usd is an estimate
 *  frozen at write time; a metered provider whose rate is set by env
 *  (ELEVENLABS_USD_PER_CHAR: 0 on a grant) is re-priced from its units, so a
 *  daily budget never locks a surface over an estimate the rate has since
 *  corrected (2026-09-24: a day of list-priced renders kept a surface shut
 *  after the rate went to zero). Everything else keeps its stored cost. */
export function rowCost(row) {
  if (row?.provider === "elevenlabs" && row.units != null) return (parseFloat(row.units) || 0) * PRICING.elevenlabs.perUnit;
  return parseFloat(row?.cost_usd) || 0;
}

export async function readUsage({ since, until } = {}) {
  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("usage-log: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required");

  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const q = new URLSearchParams({ order: "at.asc", limit: "1000", offset: String(offset) });
    if (since) q.append("at", `gte.${since}`);
    if (until) q.append("at", `lt.${until}`);
    const res = await fetch(`${base}/rest/v1/api_usage?${q}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`usage-log read: Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}
