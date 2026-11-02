#!/usr/bin/env node
/**
 * The booking pages: a zero-dependency node:http service that renders its own
 * pages and shares the ../agents helpers.
 *
 *   GET  /healthz
 *   GET  /:handle                                  the host's meeting types
 *   GET  /:handle/:slug                            pick a time, answer, book
 *   GET  /:handle/:slug/manage/:token[/reschedule] reschedule or cancel (the Lovable URL shape)
 *   GET  /api/month?handle&slug&month[&token]      every open slot in a host-local month
 *   POST /api/book                                 { handle, slug, startISO, name, email, answers }
 *   POST /api/manage/reschedule                    { token, startISO }
 *   POST /api/manage/cancel                        { token, reason }
 *
 * THE BRAIN IS FACTS. Availability is the Scheduling Agent Config (the same
 * fact the email scheduling lane reads, parsed by agents/slots.mjs); meeting
 * types are the Booking Types fact (agents/booking-types.mjs). Both are re-read
 * every 5 minutes; a failed read keeps the last good copy.
 *
 * ONE INSTANCE. core.mjs serialises each booking's changes with an in-process
 * lock; run a single Render instance. The exclusion constraint still refuses
 * any overlap if that ever changes.
 *
 * Hosts must be teammates: a type's host has to appear in BOOKING_HOSTS, or in
 * HUMAN_IDENTITIES when that is unset, so every booking task lands on a person.
 *
 * Env: BOOKING_ENABLED (absent → pages say booking is paused, APIs 503) ·
 *      BOOKING_PUBLIC_URL · BOOKING_TYPES_BLOCK_SLUG · SCHEDULE_CONFIG_BLOCK_SLUG ·
 *      NOAN_AGENT_API_KEY (a key scoped to bookings) · SUPABASE_URL +
 *      SUPABASE_SERVICE_ROLE_KEY · GOOGLE_SA_JSON or /etc/secrets/google-service-account.json ·
 *      RESEND_API_KEY + MAIL_FROM (fallback confirmations) · BOOKING_HOSTS · BOOKING_FONT_ORIGIN ·
 *      BOOKING_STORE=memory + BOOKING_DRY_RUN=1 (local only: fake calendar, no NOAN writes) · PORT
 */
import { createServer } from "node:http";
import { existsSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBookingCore, BookingError } from "./core.mjs";
import { createMemoryStore } from "./store-memory.mjs";
import { createFakeCalendar } from "./fake-calendar.mjs";
import { renderHost, renderType, renderManage, renderMessage, setIconLinks, APP_CSS, APP_JS, FIELD_JS, FONT_FILES } from "./pages.mjs";
import { readFileSync, readdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 64 * 1024;
const CONFIG_TTL_MS = 5 * 60_000;
const SWEEP_MS = 10 * 60_000;
const LIMITS = { book: [10, 3600_000], manage: [30, 3600_000], read: [300, 600_000] };

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",   // manage links carry a token in the path
  "X-Content-Type-Options": "nosniff",
};

function send(res, status, body, type = "text/html; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), ...SECURITY_HEADERS, ...extra });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), "application/json", { "Cache-Control": "no-store" });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => {
      n += c.length;
      if (n > BODY_LIMIT) { reject(new BookingError(413, "That request is too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new BookingError(400, "That request isn't valid.")); }
    });
    req.on("error", reject);
  });
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

/** Fixed-window counters per IP and bucket; in memory, which is fine for one instance. */
function createLimiter(limits = LIMITS) {
  const hits = new Map();
  return (bucket, ip) => {
    const [max, win] = limits[bucket];
    const key = `${bucket}:${ip}:${Math.floor(Date.now() / win)}`;
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (hits.size > 20_000) hits.clear();
    return n <= max;
  };
}

/** Files borrowed from the site at BOOKING_FONT_ORIGIN, fetched once and held in memory:
 *  its fonts (a site that sends no CORS header for them can still be used) and its company
 *  graph (the field behind the hero). Serving them same-origin also keeps the CSP at 'self'.
 *  Only these paths; a failed fetch isn't cached, so the next request retries. */
const SITE_FILES = new Map([
  ...FONT_FILES.map(f => [`fonts/${f}`, { type: "font/woff2", cache: "public, max-age=31536000, immutable" }]),
  ["company-graph.json", { type: "application/json", cache: "public, max-age=86400" }],
]);
function createSiteFileCache({ origin, fetchImpl = fetch }) {
  const hits = new Map();
  return name => {
    if (!SITE_FILES.has(name)) return Promise.resolve(null);
    if (!hits.has(name)) {
      hits.set(name, fetchImpl(`${origin}/assets/${name}`, { signal: AbortSignal.timeout(10_000) })
        .then(async r => (r.ok ? Buffer.from(await r.arrayBuffer()) : null))
        .catch(() => null)
        .then(buf => { if (!buf) hits.delete(name); return buf; }));
    }
    return hits.get(name);
  };
}

/** Share cards (og:image): 1200x630 JPEGs in booking/og/, read once at start. A meeting
 *  type's card is named by its slug and a host page's by its handle; anything with neither
 *  shares default.jpg. No cards at all (a checkout may ship none) → null, and the pages
 *  leave the image tags out rather than point a crawler at a 404. */
const OG_DIR = new URL("./og/", import.meta.url);
export const OG_CARDS = new Map((existsSync(OG_DIR) ? readdirSync(OG_DIR) : []).filter(f => f.endsWith(".jpg"))
  .map(f => [f.slice(0, -4), readFileSync(new URL(f, OG_DIR))]));
export const cardFor = slug => (OG_CARDS.has(slug) ? slug : OG_CARDS.has("default") ? "default" : null);

/** The site's mark, rendered small (booking/icons/). Declared explicitly: a page with no
 *  icon leaves browsers showing whatever they cached for the domain before. Only the files
 *  present are served and linked, so a checkout with no icons simply has none. */
const ICON_DIR = new URL("./icons/", import.meta.url);
export const ICONS = new Map([
  ["/favicon.ico", "favicon-32.png"],            // what a browser asks for unprompted
  ["/assets/favicon-32.png", "favicon-32.png"],
  ["/assets/favicon-192.png", "favicon-192.png"],
  ["/apple-touch-icon.png", "apple-touch-icon.png"],
].filter(([, file]) => existsSync(new URL(file, ICON_DIR)))
  .map(([path, file]) => [path, readFileSync(new URL(file, ICON_DIR))]));
setIconLinks(new Set(ICONS.keys()));

/** Build the HTTP handler around a booking core. Exported so the tests can run it on a port. */
export function createBookingServer({ core, env = process.env, limiter = createLimiter(), fontFetch }) {
  const siteFile = createSiteFileCache({ origin: env.BOOKING_FONT_ORIGIN || "", ...(fontFetch ? { fetchImpl: fontFetch } : {}) });   // no origin = 404s = CSS font fallback, by design
  const enabled = () => env.BOOKING_ENABLED === "1" || env.BOOKING_ENABLED === "true";
  const origin = env.BOOKING_PUBLIC_URL || "";
  const msg = (title, text, opts = {}) => renderMessage(title, text, { ...opts, share: { origin } });

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://booking.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method === "HEAD" ? "GET" : req.method;   // node sends no body on HEAD; unfurlers probe with it
    const route = `${method} ${path}`;
    const ip = clientIp(req);
    const isApi = path.startsWith("/api/");
    try {
      if (route === "GET /healthz") return send(res, 200, "ok", "text/plain");
      if (route === "GET /assets/app.css") return send(res, 200, APP_CSS, "text/css; charset=utf-8", { "Cache-Control": "public, max-age=31536000, immutable" });
      if (route === "GET /assets/app.js") return send(res, 200, APP_JS, "text/javascript; charset=utf-8", { "Cache-Control": "public, max-age=31536000, immutable" });
      if (route === "GET /assets/field.js") return send(res, 200, FIELD_JS, "text/javascript; charset=utf-8", { "Cache-Control": "public, max-age=31536000, immutable" });
      if (method === "GET" && path.startsWith("/assets/og/") && path.endsWith(".jpg")) {
        const buf = OG_CARDS.get(path.slice("/assets/og/".length, -4));
        if (!buf) return send(res, 404, "Not found", "text/plain");
        return send(res, 200, buf, "image/jpeg", { "Cache-Control": "public, max-age=86400" });
      }
      if (method === "GET" && (path.startsWith("/assets/fonts/") || path === "/assets/company-graph.json")) {
        const name = path.slice("/assets/".length);
        const buf = await siteFile(name);
        if (!buf) return send(res, 404, "Not found", "text/plain");
        return send(res, 200, buf, SITE_FILES.get(name).type, { "Cache-Control": SITE_FILES.get(name).cache });
      }
      if (method === "GET" && ICONS.has(path)) {
        return send(res, 200, ICONS.get(path), "image/png", { "Cache-Control": "public, max-age=86400" });
      }
      if (route === "GET /robots.txt") return send(res, 200, "User-agent: *\nDisallow: /\n", "text/plain");
      if (!enabled()) {
        if (isApi) return json(res, 503, { message: "Booking is paused right now. Try again later." });
        return send(res, 503, msg("Booking is paused", "Booking is paused right now. Try again later."));
      }

      if (isApi) {
        if (route === "GET /api/month") {
          if (!limiter("read", ip)) return json(res, 429, { message: "Too many requests. Wait a minute and try again." });
          const p = url.searchParams;
          return json(res, 200, await core.month(p.get("handle"), p.get("slug"), p.get("month"), { token: p.get("token") || null }));
        }
        if (route === "POST /api/book") {
          if (!limiter("book", ip)) return json(res, 429, { message: "Too many bookings from here. Try again in an hour." });
          const body = await readBody(req);
          // Honeypot: a person never sees this field.
          if (body.website_url) return json(res, 400, { message: "That request isn't valid." });
          return json(res, 201, await core.book(body));
        }
        if (route === "POST /api/manage/reschedule" || route === "POST /api/manage/cancel") {
          if (!limiter("manage", ip)) return json(res, 429, { message: "Too many changes. Try again in an hour." });
          const body = await readBody(req);
          return json(res, 200, route.endsWith("reschedule")
            ? await core.reschedule(body.token, body.startISO)
            : await core.cancel(body.token, body.reason));
        }
        return json(res, 404, { message: "Not found." });
      }

      if (method !== "GET") return send(res, 405, "Method not allowed", "text/plain");
      if (!limiter("read", ip)) return send(res, 429, msg("Slow down", "Too many requests. Wait a minute and try again."));
      const parts = path.split("/").filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return "\u0000"; } });
      if (parts.length === 0) {
        if (env.BOOKING_HOME_URL) { res.writeHead(302, { Location: env.BOOKING_HOME_URL }); return res.end(); }
        return send(res, 404, msg("Nothing here", "Use the booking link you were sent."));
      }
      if (parts.length === 1) return send(res, 200, renderHost(await core.host(parts[0]), { origin, path, card: cardFor(parts[0]) }));
      if (parts.length === 2) return send(res, 200, renderType(await core.type(parts[0], parts[1]), { origin, path, card: cardFor(parts[1]) }));
      if ((parts.length === 4 || (parts.length === 5 && parts[4] === "reschedule")) && parts[2] === "manage") {
        const view = await core.manage(parts[3]);
        return send(res, 200, renderManage(view, parts[3], { origin, card: cardFor(parts[1]) }), "text/html; charset=utf-8", { "Cache-Control": "no-store" });
      }
      return send(res, 404, msg("Page not found", "Check the link you were sent."));
    } catch (e) {
      const status = e instanceof BookingError ? e.status : 503;
      if (!(e instanceof BookingError)) console.error(`booking: ${route} → ${e.stack || e.message}`);
      const message = e instanceof BookingError ? e.message : "Something went wrong on our side. Nothing was booked; try again in a moment.";
      try {
        if (isApi) return json(res, status, { message });
        return send(res, status, msg(status === 404 ? "Page not found" : "Something went wrong", message));
      } catch { /* socket gone */ }
    }
  });
}

/* ---------------- wiring for a real run ---------------- */

/** Config from the two facts, re-read every 5 minutes, last good copy kept on failure. */
export function createFactConfig({ noanGet, parseScheduleFact, parseBookingTypes, triggerTags, allowedHosts, env = process.env, log = console.log }) {
  let cache = null, at = 0;
  const text = async slug => ((await noanGet(`/facts?block_slug=${encodeURIComponent(slug)}`)).items || []).map(f => f.content).join("\n");
  return async function config() {
    if (cache && Date.now() - at < CONFIG_TTL_MS) return cache;
    try {
      const [sched, types] = await Promise.all([text(env.SCHEDULE_CONFIG_BLOCK_SLUG), text(env.BOOKING_TYPES_BLOCK_SLUG)]);
      const parsed = parseBookingTypes(types, { triggerTags });
      const ok = parsed.types.filter(t => allowedHosts.has(t.host));
      for (const t of parsed.types) if (!allowedHosts.has(t.host)) log(`booking: type "${t.name}" skipped: host ${t.host} is not a teammate (BOOKING_HOSTS / HUMAN_IDENTITIES)`);
      for (const e of parsed.errors) log(`booking: Booking Types fact: ${e}`);
      cache = { avail: parseScheduleFact(sched), types: ok }; at = Date.now();
    } catch (e) {
      log(`booking: config read failed: ${e.message}${cache ? " (keeping the last good copy)" : ""}`);
      if (!cache) throw e;
      at = Date.now() - CONFIG_TTL_MS + 30_000;   // retry in 30s
    }
    return cache;
  };
}

/** How far ahead a call must be for the page to offer a brief. With GH_DISPATCH_PAT the
 *  brief workflow starts within a minute, so an hour is plenty. Without it the brief waits
 *  for the workflow's hourly backstop (and GitHub's scheduled runs start late), so a call
 *  under three hours away could be booked with the switch on and get nothing.
 *  BOOKING_BRIEF_MIN_LEAD_MIN overrides both. */
export function briefLeadFor(env) {
  const set = Number(env.BOOKING_BRIEF_MIN_LEAD_MIN);
  if (Number.isFinite(set) && set > 0) return set;
  return env.GH_DISPATCH_PAT ? 60 : 180;
}

/** repository_dispatch, the way slack-worker hands a task to the general agent: the brief
 *  workflow starts now instead of at its cron. Without GH_DISPATCH_PAT it returns false. */
export function githubDispatch(env, fetchImpl = fetch) {
  return async ({ event_type, client_payload }) => {
    if (!env.GH_DISPATCH_PAT) return false;
    const repo = env.GH_REPO;
    if (!repo) return false;
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${env.GH_DISPATCH_PAT}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "verity-booking" },
      body: JSON.stringify({ event_type, client_payload }),
    });
    if (!r.ok) throw new Error(`GitHub dispatch → ${r.status}`);
    return true;
  };
}

async function main() {
  const env = process.env;
  const dryRun = env.BOOKING_DRY_RUN === "1";
  // A dry run with no fact slugs reads the seed texts instead: the pages run with no NOAN key at all.
  // Decided BEFORE the shared defaults load, since config.defaults.env carries the slug.
  const local = dryRun && !env.BOOKING_TYPES_BLOCK_SLUG;
  const { loadConfigDefaults } = await import("../agents/config-defaults.mjs");
  loadConfigDefaults({ env });

  // Google credentials must be on disk before google-cal.mjs loads (it reads them at import).
  const SA_DEST = join(HERE, "..", "agents", "google-service-account.json");
  if (!dryRun && !existsSync(SA_DEST)) {
    if (existsSync("/etc/secrets/google-service-account.json")) copyFileSync("/etc/secrets/google-service-account.json", SA_DEST);
    else if (env.GOOGLE_SA_JSON) writeFileSync(SA_DEST, env.GOOGLE_SA_JSON, { mode: 0o600 });
  }

  const missing = ["BOOKING_PUBLIC_URL", ...(local ? [] : ["BOOKING_TYPES_BLOCK_SLUG", "SCHEDULE_CONFIG_BLOCK_SLUG"]),
    ...(dryRun ? [] : ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])].filter(k => !env[k]);
  if (missing.length) { console.error(`booking: missing required env: ${missing.join(", ")}`); process.exit(1); }
  if (!dryRun && !existsSync(SA_DEST)) { console.error("booking: no Google credentials (GOOGLE_SA_JSON or the secret file)"); process.exit(1); }

  const noan = await import("../agents/noan.mjs");
  if (!local) noan.assertNoanKey();
  const { parseScheduleFact } = await import("../agents/slots.mjs");
  const { parseBookingTypes } = await import("../agents/booking-types.mjs");
  const { DEFAULT_TRIGGER_TAGS } = await import("../agents/trigger-tags.mjs");
  const { createNoanCrm } = await import("./noan-sync.mjs");

  const allowedHosts = new Set((env.BOOKING_HOSTS ||
    String(env.HUMAN_IDENTITIES || "").split(",").map(p => p.split("=")[0]).join(","))
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
  if (!allowedHosts.size) { console.error("booking: no hosts allowed: set BOOKING_HOSTS (or HUMAN_IDENTITIES)"); process.exit(1); }

  const config = local
    ? await (async () => {
      const { FACT: sched } = await import("../agents/seed-scheduling.mjs");
      const { FACT: types } = await import("../agents/seed-booking.mjs");
      const fixed = { avail: parseScheduleFact(sched), types: parseBookingTypes(types, { triggerTags: DEFAULT_TRIGGER_TAGS }).types };
      console.warn("booking: LOCAL config from the seed texts (no NOAN reads)");
      return async () => fixed;
    })()
    : createFactConfig({ noanGet: noan.noanGet, parseScheduleFact, parseBookingTypes, triggerTags: DEFAULT_TRIGGER_TAGS, allowedHosts, env });
  const cfg = await config();   // fail fast on a bad key or slug

  let calendar, crm;
  if (dryRun) {
    calendar = createFakeCalendar();
    crm = { apply: async (row, type, item) => { console.log(`booking DRY_RUN: NOAN ${item.kind} for ${row.guest_email} (${type?.name || row.type_slug})`); return {}; } };
  } else {
    const g = await import("../agents/google-cal.mjs");
    calendar = {
      freeBusy: g.freeBusy, createEvent: g.createEvent, updateEvent: g.updateEvent, cancelEvent: g.cancelEvent,
      userTimeZone: g.userTimeZone,   // the host's own Google Calendar zone: their hours travel with them

      findEventByBooking: (id, host) => g.findEventByPrivate("bookingId", id, host),
    };
    crm = createNoanCrm({ timeZone: cfg.avail.timeZone, publicUrl: env.BOOKING_PUBLIC_URL, dispatch: githubDispatch(env) });
  }
  const store = env.BOOKING_STORE === "memory"
    ? (console.warn("booking: IN-MEMORY store: bookings are lost on restart. Local runs only."), createMemoryStore())
    : (await import("./store-supabase.mjs")).createSupabaseStore();
  if (store.probe) {
    try { await store.probe(); }
    catch (e) { console.error(`booking: the booking store is unreadable — is the booking_bookings table created (schema.sql)? ${e.message}`); process.exit(1); }
  }

  const { onStuck, onCalendarMissed } = await import("./alerts.mjs").then(m => m.createAlerts({ noan, dryRun, env }));
  const briefEnabled = env.BOOKING_BRIEF_ENABLED === "1";
  const core = createBookingCore({ store, calendar, crm, config, publicUrl: env.BOOKING_PUBLIC_URL, onStuck, onCalendarMissed, briefEnabled, briefMinLeadMin: briefLeadFor(env) });

  const port = Number(env.PORT || 8080);
  createBookingServer({ core, env }).listen(port, () => {
    console.log(`booking: listening on :${port} · ${cfg.types.length} type(s) · store=${store.kind}${dryRun ? " · DRY RUN" : ""}${env.BOOKING_ENABLED ? "" : " · PAUSED (set BOOKING_ENABLED=1)"}`);
  });
  const sweep = () => core.sweep()
    .then(r => (r.done || r.failed) && console.log(`booking: sweep checked=${r.checked} done=${r.done} failed=${r.failed}`))
    .catch(e => console.error(`booking: sweep failed: ${e.message}`));
  setTimeout(sweep, 30_000).unref();
  setInterval(sweep, SWEEP_MS).unref();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(`booking: failed to start: ${e.stack || e.message}`); process.exit(1); });
}
