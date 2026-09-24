/**
 * Google Calendar client for the scheduling agent. Zero-dep, raw fetch.
 *
 * Two auth modes, auto-selected:
 *   1. SERVICE ACCOUNT with domain-wide delegation (google-service-account.json
 *      present): impersonates any user on your Workspace domain — pass `asUser` to act on
 *      that person's calendar. Scopes: calendar.events + freebusy only.
 *   2. Legacy single-user OAuth (google-oauth-client.json + google-token.json):
 *      a teammate's personal refresh token; `asUser` is ignored.
 */

import { readFileSync, existsSync } from "node:fs";
import { isInternalEmail } from "./required-env.mjs";
import { fileURLToPath } from "node:url";
import { createSign } from "node:crypto";
import { zonedToUtc } from "./slots.mjs";

const p = (f) => fileURLToPath(new URL(f, import.meta.url));
const SA = existsSync(p("./google-service-account.json"))
  ? JSON.parse(readFileSync(p("./google-service-account.json"))) : null;
const CLIENT = existsSync(p("./google-oauth-client.json"))
  ? JSON.parse(readFileSync(p("./google-oauth-client.json"))).installed : null;
const TOKEN = existsSync(p("./google-token.json"))
  ? JSON.parse(readFileSync(p("./google-token.json"))) : null;

const SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";
/** Asked for ONLY by userTimeZone, and on its own token: a delegation that does not carry
 *  this scope refuses the whole token request, and booking and scheduling must not go down
 *  because a nice-to-have read is unauthorised. */
const SETTINGS_SCOPE = "https://www.googleapis.com/auth/calendar.settings.readonly";
const DEFAULT_USER = process.env.SCHEDULE_DEFAULT_USER || "";   // env-pinned in the fleet; OSS = derived by bootstrap

const _cache = new Map(); // user|scope -> { token, exp }
// A hung Google call must not hang the caller: the booking server answers a
// guest inside this, and a stuck worker run holds its Actions slot for hours.
const TIMEOUT_MS = 10_000;

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function saToken(asUser, scope = SCOPES) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: SA.client_email, sub: asUser, scope,
    aud: SA.token_uri, iat: now, exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(SA.private_key))}`;
  const r = await fetch(SA.token_uri, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const t = await r.json();
  if (!t.access_token) throw new Error(`SA token for ${asUser} failed: ${JSON.stringify(t).slice(0, 250)}`);
  return t;
}

async function accessToken(asUser, scope = SCOPES) {
  const user = SA ? (asUser || DEFAULT_USER).toLowerCase() : "_single";
  const key = `${user}|${scope}`;
  const hit = _cache.get(key);
  if (hit && Date.now() < hit.exp - 60_000) return hit.token;

  let t;
  if (SA) {
    t = await saToken(user, scope);
  } else {
    if (!CLIENT || !TOKEN) throw new Error("No Google credentials: need google-service-account.json or the OAuth client+token pair.");
    const r = await fetch(CLIENT.token_uri, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: TOKEN.refresh_token, client_id: CLIENT.client_id,
        client_secret: CLIENT.client_secret, grant_type: "refresh_token",
      }),
    });
    t = await r.json();
    if (!t.access_token) throw new Error(`Google token refresh failed: ${JSON.stringify(t).slice(0, 200)}`);
  }
  _cache.set(key, { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 });
  return t.access_token;
}

async function gcal(method, path, body, asUser, scope = SCOPES) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Authorization: `Bearer ${await accessToken(asUser, scope)}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Calendar ${method} ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

/**
 * The timezone `asUser` has set in Google Calendar ("Europe/Berlin"), or null when it
 * can't be read. Never throws, and asks for SETTINGS_SCOPE on its own token: a delegation
 * without that scope refuses the request here and nowhere else, so booking and scheduling
 * keep working on their configured zone.
 * Following this setting is how a host's hours travel with them: Google offers to update
 * it when they land somewhere else.
 */
export async function userTimeZone(asUser) {
  try {
    const r = await gcal("GET", "/users/me/settings/timezone", null, asUser, SETTINGS_SCOPE);
    const tz = r?.value;
    return tz && isTimeZone(tz) ? tz : null;
  } catch { return null; }
}

/** Does the runtime know this zone? Guards a value that came from Google or a fact. */
export function isTimeZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: String(tz) }); return true; } catch { return false; }
}

/** Busy intervals [{start,end}] (ISO strings) on `asUser`'s primary calendar. */
export async function freeBusy(timeMinISO, timeMaxISO, asUser) {
  const data = await gcal("POST", "/freeBusy", {
    timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id: "primary" }],
  }, asUser);
  return data.calendars?.primary?.busy || [];
}

/**
 * Create an event on `asUser`'s primary calendar (they become the organizer).
 * Google emails the invite to attendees (sendUpdates=all). Returns the event.
 */
export async function createEvent({ summary, description, startISO, endISO, attendees, meet = true, timeZone, asUser, taskId, requestId, privateProps }) {
  const body = {
    summary,
    description,
    start: { dateTime: startISO, timeZone },
    end:   { dateTime: endISO,   timeZone },
    attendees: (attendees || []).map(a => (typeof a === "string" ? { email: a } : a)),
  };
  // Agent-created events carry a marker so cancel can be code-restricted to its own events.
  // privateProps adds more (the booking server stamps bookingId for reconciliation).
  const priv = { ...(privateProps || {}), ...(taskId ? { verityTask: String(taskId) } : {}) };
  if (Object.keys(priv).length) body.extendedProperties = { private: priv };
  if (meet) {
    // Pass a stable requestId (e.g. `booking-<id>`) and a retried create reuses
    // the same Meet conference instead of minting a second one.
    body.conferenceData = {
      createRequest: { requestId: requestId || `verity-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } },
    };
  }
  return gcal("POST", `/calendars/primary/events?sendUpdates=all${meet ? "&conferenceDataVersion=1" : ""}`, body, asUser);
}

/** One event by id from `asUser`'s primary calendar (full resource: organizer, attendees, extendedProperties). */
export async function getEvent(eventId, asUser) {
  return gcal("GET", `/calendars/primary/events/${encodeURIComponent(eventId)}`, null, asUser);
}

/** Patch fields on an existing event. Google emails attendees the update (sendUpdates=all). */
export async function updateEvent(eventId, patch, asUser) {
  return gcal("PATCH", `/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, patch, asUser);
}

/** The live event on `asUser`'s primary calendar stamped with private property
 *  key=value (createEvent's privateProps), or null. The booking server looks its
 *  own event up this way before creating one, so a create whose reply was lost
 *  is found on retry instead of being made twice. */
export async function findEventByPrivate(key, value, asUser) {
  const q = new URLSearchParams({ privateExtendedProperty: `${key}=${value}`, maxResults: "1", showDeleted: "false" });
  const data = await gcal("GET", `/calendars/primary/events?${q}`, null, asUser);
  return (data.items || []).find(e => e.status !== "cancelled") || null;
}

/** Cancel an event. Google emails attendees the cancellation (sendUpdates=all). */
export async function cancelEvent(eventId, asUser) {
  return gcal("DELETE", `/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, null, asUser);
}

/* ---------------- slot computation (deterministic) ---------------- */

function fmtSlot(date, minutes, tz) {
  const s = new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz,
  }).format(date);
  const end = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz,
  }).format(new Date(date.getTime() + minutes * 60000));
  return `${s}–${end}`;
}

/**
 * Compute up to maxSlots free slots, spread across distinct days.
 * cfg: { timeZone, workStart:"09:00", workEnd:"17:30", durationMin, bufferMin,
 *        lookaheadDays, minNoticeHours, maxSlots }
 * busy: [{start,end}] ISO
 * constraints (all optional, from a prospect's stated preferences):
 *   notBefore/notAfter: Date bounds on the slot; dayStart/dayEnd: "HH:MM"
 *   time-of-day window (clamped INSIDE working hours, never outside them);
 *   weekdays: ["Mon",...] allowed days; excludeStarts: startISOs already offered;
 *   windows: [{startISO,endISO}] — the prospect's stated availability; when
 *   present a slot must sit fully inside one of them (still clamped inside
 *   working hours — no overlap means no slots, and the caller hands off).
 */
export function computeSlots(cfg, busy, now = new Date(), constraints = {}) {
  const windows = (constraints.windows || [])
    .map(w => [new Date(w.startISO).getTime(), new Date(w.endISO).getTime()])
    .filter(([ws, we]) => !isNaN(ws) && !isNaN(we) && we > ws);
  const inWindow = (start, end) => !windows.length || windows.some(([ws, we]) => start >= ws && end <= we);
  const dur = cfg.durationMin * 60000;
  const buf = cfg.bufferMin * 60000;
  let notBefore = new Date(now.getTime() + cfg.minNoticeHours * 3600e3);
  if (constraints.notBefore instanceof Date && constraints.notBefore > notBefore) notBefore = constraints.notBefore;
  const notAfter = constraints.notAfter instanceof Date ? constraints.notAfter : null;
  const allowedDows = constraints.weekdays?.length ? new Set(constraints.weekdays) : null;
  const exclude = new Set(constraints.excludeStarts || []);
  const busyMs = busy.map(b => [new Date(b.start).getTime() - buf, new Date(b.end).getTime() + buf]);

  const free = (start, end) => !busyMs.some(([bs, be]) => start < be && end > bs);

  // a future notBefore ("the week after next") pushes the scan window out with it
  const startOff = Math.max(0, Math.floor((notBefore.getTime() - now.getTime()) / 86400e3));
  const lastOff = Math.min(60, startOff + cfg.lookaheadDays + 7);
  const slots = [];
  const perDay = {};
  for (let dayOff = 0; dayOff <= lastOff && slots.length < cfg.maxSlots * 3; dayOff++) {
    const day = new Date(now.getTime() + dayOff * 86400e3);
    const dow = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: cfg.timeZone }).format(day);
    if (allowedDows && !allowedDows.has(dow)) continue;
    const dateISO = new Intl.DateTimeFormat("en-CA", { timeZone: cfg.timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(day);
    const [y, m, d] = dateISO.split("-").map(Number);
    const dayKey = `${y}-${m}-${d}`;
    if (cfg.blockedDates?.has(dateISO)) continue;
    // The day's working window: per-weekday hours when the config fact has
    // them (parseScheduleFact in slots.mjs; first window only — this lane
    // offers a few spread-out times, not a grid), else working hours Mon–Fri.
    const win = cfg.weekHours
      ? (cfg.weekHours[dow] || [])[0]
      : (dow === "Sat" || dow === "Sun" ? null : [cfg.workStart, cfg.workEnd]);
    if (!win) continue;
    const dayStart = constraints.dayStart && constraints.dayStart > win[0] ? constraints.dayStart : win[0];
    const dayEnd   = constraints.dayEnd   && constraints.dayEnd   < win[1] ? constraints.dayEnd   : win[1];
    const [wsH, wsM] = dayStart.split(":").map(Number);
    const [weH, weM] = dayEnd.split(":").map(Number);
    for (let t = zonedToUtc(y, m - 1, d, wsH, wsM, cfg.timeZone).getTime(),
             end = zonedToUtc(y, m - 1, d, weH, weM, cfg.timeZone).getTime();
         t + dur <= end; t += 30 * 60000) {
      const st = new Date(t);
      if (st < notBefore) continue;
      if (notAfter && t + dur > notAfter.getTime()) break;
      if (exclude.has(st.toISOString())) continue;
      if (!inWindow(t, t + dur)) continue;
      if ((perDay[dayKey] || 0) >= 1 && slots.length < cfg.maxSlots) {
        // prefer spreading across days: only one slot per day until each day has one
      }
      if (!free(t, t + dur)) continue;
      if ((perDay[dayKey] || 0) >= 2) break; // at most 2 candidates per day
      slots.push({ startISO: st.toISOString(), endISO: new Date(t + dur).toISOString(), human: fmtSlot(st, cfg.durationMin, cfg.timeZone) });
      perDay[dayKey] = (perDay[dayKey] || 0) + 1;
    }
  }

  // spread: first slot from each distinct day, then second-choices
  const byDay = {};
  for (const s of slots) {
    const k = s.startISO.slice(0, 10);
    (byDay[k] = byDay[k] || []).push(s);
  }
  const spread = [];
  for (const k of Object.keys(byDay)) if (spread.length < cfg.maxSlots) spread.push(byDay[k][0]);
  for (const k of Object.keys(byDay)) if (spread.length < cfg.maxSlots && byDay[k][1]) spread.push(byDay[k][1]);
  return spread.slice(0, cfg.maxSlots);
}

/** Events on `asUser`'s primary calendar in a window — attendee emails
 *  included. Added for the meeting recorder (MEETING-NOTES-PLAN §5): the
 *  event covering "now" identifies who a recording is with. */
export async function listEvents(timeMinISO, timeMaxISO, asUser) {
  const q = new URLSearchParams({
    timeMin: timeMinISO, timeMax: timeMaxISO,
    singleEvents: "true", orderBy: "startTime", maxResults: "20",
  });
  const data = await gcal("GET", `/calendars/primary/events?${q}`, null, asUser);
  return (data.items || []).filter(e => e.status !== "cancelled").map(e => ({
    id: e.id,
    summary: e.summary || "(untitled)",
    startISO: e.start?.dateTime || e.start?.date,
    endISO: e.end?.dateTime || e.end?.date,
    // the Meet link (call presence joins by it) — hangoutLink is the modern
    // field; older events carry it only in conferenceData entry points
    hangoutLink: e.hangoutLink || (e.conferenceData?.entryPoints || []).find(p => p.entryPointType === "video")?.uri || null,
    attendees: (e.attendees || []).filter(a => !a.resource).map(a => ({
      email: (a.email || "").toLowerCase(),
      name: a.displayName || null,
      self: !!a.self,
    })),
  }));
}

/** The event covering `now` (or starting within `slackMin` minutes) that has
 *  at least one attendee outside your own domain — the meeting the host is likely in. */
export async function eventCoveringNow({ slackMin = 10, asUser } = {}) {
  const now = new Date();
  const events = await listEvents(
    new Date(now.getTime() - 60 * 60000).toISOString(),
    new Date(now.getTime() + slackMin * 60000).toISOString(), asUser);
  return events.find(e => {
    const start = new Date(e.startISO), end = new Date(e.endISO);
    const covering = start <= new Date(now.getTime() + slackMin * 60000) && end > now;
    const external = e.attendees.some(a => a.email && !isInternalEmail(a.email));
    return covering && external;
  }) || null;
}

/** Is [startISO, startISO+durationMin] free on `asUser`'s calendar right now? */
export async function slotStillFree(startISO, durationMin, bufferMin = 0, asUser) {
  const start = new Date(startISO);
  const end = new Date(start.getTime() + durationMin * 60000);
  const busy = await freeBusy(
    new Date(start.getTime() - bufferMin * 60000).toISOString(),
    new Date(end.getTime() + bufferMin * 60000).toISOString(), asUser);
  return busy.length === 0;
}
