/**
 * Slot engine shared by the booking pages and the email scheduling lane
 * Pure: no network, no clock unless you pass one.
 *
 * "When is the host free" has ONE definition, read from the Scheduling Agent
 * Config fact by parseScheduleFact(). The email lane (google-cal.mjs
 * computeSlots) offers three spread-out times from it; the booking pages
 * (daySlots / monthDays) draw the full grid from it. A booking type can narrow
 * the fact's week with its own `hours <Day>:` lines, which stand for that type's host.
 *
 * Every date string here is a wall-clock "YYYY-MM-DD" in the HOST's timezone;
 * every instant is an ISO string in UTC.
 */

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_RX = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RX = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;

/** UTC Date for wall-clock y-m(0-based)-d hh:mm in an IANA timezone (DST-aware).
 *  Reads the offset via formatToParts so the result never depends on the
 *  machine's own TZ (the old toLocaleString round-trip parsed in machine-local
 *  time and ran an hour late on runners whose TZ observed DST). */
export function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m, d, hh, mm);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return new Date(guess - (shown - guess));
}

/** "YYYY-MM-DD" of an instant, as the wall clock in `tz` shows it. */
export function localDate(date, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(date);
}

/** "Mon".."Sun" for a host-local date string. Noon avoids any DST edge. */
export function weekdayOf(dateISO, tz) {
  const [y, m, d] = splitDay(dateISO);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz })
    .format(zonedToUtc(y, m - 1, d, 12, 0, tz));
}

function splitDay(dateISO) {
  const m = DAY_RX.exec(String(dateISO || ""));
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null; // 2026-02-30
  return [y, mo, d];
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Parse "09:00-13:00, 14:00-17:30" (or "off") into [[start,end],...]; null if malformed. */
export function parseWindows(text) {
  const t = String(text || "").trim();
  if (/^(off|closed|none)$/i.test(t)) return [];
  const out = [];
  for (const part of t.split(",")) {
    const m = /^\s*(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s*$/.exec(part);
    if (!m || !HHMM_RX.test(m[1]) || !HHMM_RX.test(m[2])) return null;
    if (minutesOf(m[2]) <= minutesOf(m[1])) return null;
    out.push([m[1], m[2]]);
  }
  return out;
}

/** `hours Mon: ...` lines → { Mon: [[s,e]], ... } for the days that have one. */
function parseWeekHourLines(text, onError = () => {}) {
  const out = {};
  for (const m of String(text || "").matchAll(/^\s*hours\s+(mon|tue|wed|thu|fri|sat|sun)\w*\s*:\s*(.+)$/gim)) {
    const day = m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase();
    const w = parseWindows(m[2]);
    if (w === null) onError(`hours ${day}: "${m[2].trim()}" is not HH:MM-HH:MM or "off"`);
    else out[day] = w;
  }
  return out;
}

export const SCHEDULE_DEFAULTS = Object.freeze({
  timeZone: process.env.SCHEDULE_TIMEZONE || "UTC", workStart: "09:00", workEnd: "17:30",
  durationMin: 30, bufferMin: 15, lookaheadDays: 10, minNoticeHours: 24,
  maxSlots: 3, meet: true, maxRounds: 2,
});

/**
 * The Scheduling Agent Config fact → the availability config both lanes use.
 * Lenient on purpose (unknown keys ignored, missing keys default) — the fact is
 * edited by hand in the NOAN UI. The original keys parse exactly as
 * reply-worker.mjs always parsed them; two are new and optional:
 *
 *   hours Fri: 09:00-13:00          per-weekday hours (several windows with ",", or "off")
 *   blocked dates: 2026-12-24, 2026-12-25
 *
 * weekHours always holds all seven days: the `working hours` line fills
 * Mon–Fri, weekends are off, and any `hours <Day>:` line replaces its day.
 */
export function parseScheduleFact(text, defaults = SCHEDULE_DEFAULTS) {
  text = String(text || "");
  const grab = (rx) => (text.match(rx) || [])[1];
  const hours = grab(/working hours:\s*(\d{2}:\d{2}-\d{2}:\d{2})/i);
  const cfg = {
    timeZone:       grab(/timezone:\s*([\w/_-]+)/i) || defaults.timeZone,
    workStart:      hours ? hours.split("-")[0] : defaults.workStart,
    workEnd:        hours ? hours.split("-")[1] : defaults.workEnd,
    durationMin:    parseInt(grab(/meeting length minutes:\s*(\d+)/i) || defaults.durationMin, 10),
    bufferMin:      parseInt(grab(/buffer minutes:\s*(\d+)/i) || defaults.bufferMin, 10),
    lookaheadDays:  parseInt(grab(/lookahead days:\s*(\d+)/i) || defaults.lookaheadDays, 10),
    minNoticeHours: parseInt(grab(/min notice hours:\s*(\d+)/i) || defaults.minNoticeHours, 10),
    maxSlots:       parseInt(grab(/max slots offered:\s*(\d+)/i) || defaults.maxSlots, 10),
    maxRounds:      parseInt(grab(/max reoffer rounds:\s*(\d+)/i) || defaults.maxRounds, 10),
    meet:           !/google meet:\s*no/i.test(text),
  };
  const weekHours = {};
  for (const day of WEEKDAYS) {
    weekHours[day] = day === "Sat" || day === "Sun" ? [] : [[cfg.workStart, cfg.workEnd]];
  }
  Object.assign(weekHours, parseWeekHourLines(text));
  cfg.weekHours = weekHours;
  const blocked = grab(/blocked dates:\s*([^\n]+)/i) || "";
  cfg.blockedDates = new Set(blocked.split(/[,\s]+/).filter(d => splitDay(d)));
  return cfg;
}

/** The windows a host can be booked in on one date, after a type narrows them. */
export function hoursFor(avail, type, dateISO) {
  if (!splitDay(dateISO) || avail.blockedDates?.has(dateISO)) return [];
  const day = weekdayOf(dateISO, avail.timeZone);
  const host = avail.weekHours?.[day] ?? [];
  const own = type?.weekHours?.[day];
  // A type's own `hours` lines ARE its host's week for that day (an empty list closes it);
  // the fact's week is the fallback. They used to be clipped to the fact's hours, which was
  // right while one person owned both: since booking pages have more than one host
  // (2026-09-16), the fact's week belongs to whoever owns the fact, and one person's
  // working day must not cap another's.
  return own || host;
}


/**
 * Every bookable start on one host-local date.
 *
 *   avail  parseScheduleFact() output (timeZone, weekHours, blockedDates, bufferMin, minNoticeHours)
 *   type   { lengthMin, stepMin?, bufferMin?, minNoticeHours?, maxDaysOut?, weekHours? }
 *   busy   [{ start, end }] ISO — Google busy times plus confirmed bookings
 *
 * Returns [{ startISO, endISO }] ascending. Buffers widen each busy interval;
 * a slot must also start at least the notice period from `now` and end within
 * maxDaysOut days of it.
 */
export function daySlots(avail, type, busy, dateISO, now = new Date()) {
  const day = splitDay(dateISO);
  if (!day) return [];
  const [y, m, d] = day;
  const tz = avail.timeZone;
  const len = type.lengthMin * 60e3;
  const step = (type.stepMin || Math.min(type.lengthMin, 30)) * 60e3;
  const buf = (type.bufferMin ?? avail.bufferMin ?? 0) * 60e3;
  const notBefore = now.getTime() + (type.minNoticeHours ?? avail.minNoticeHours ?? 0) * 3600e3;
  const notAfter = now.getTime() + (type.maxDaysOut ?? 60) * 86400e3;
  const busyMs = (busy || [])
    .map(b => [Date.parse(b.start) - buf, Date.parse(b.end) + buf])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));
  const seen = new Set();
  const out = [];
  for (const [ws, we] of hoursFor(avail, type, dateISO)) {
    const [sh, sm] = ws.split(":").map(Number);
    const [eh, em] = we.split(":").map(Number);
    const end = zonedToUtc(y, m - 1, d, eh, em, tz).getTime();
    for (let t = zonedToUtc(y, m - 1, d, sh, sm, tz).getTime(); t + len <= end; t += step) {
      if (t < notBefore) continue;
      if (t + len > notAfter) break;
      if (busyMs.some(([bs, be]) => t < be && t + len > bs)) continue;
      const startISO = new Date(t).toISOString();
      if (seen.has(startISO)) continue;
      seen.add(startISO);
      out.push({ startISO, endISO: new Date(t + len).toISOString() });
    }
  }
  return out.sort((a, b) => (a.startISO < b.startISO ? -1 : 1));
}

/** Host-local dates in "YYYY-MM" that have at least one slot, with their counts. */
export function monthDays(avail, type, busy, monthISO, now = new Date()) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthISO || ""));
  if (!m) return [];
  const [y, mo] = [+m[1], +m[2]];
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= days; d++) {
    const date = `${m[1]}-${m[2]}-${String(d).padStart(2, "0")}`;
    const n = daySlots(avail, type, busy, date, now).length;
    if (n) out.push({ date, slots: n });
  }
  return out;
}

/** Is `startISO` exactly one of the starts daySlots would offer right now?
 *  The booking server's write-time check: a guest can only book what the
 *  page could have shown them. */
export function isOfferedSlot(avail, type, busy, startISO, now = new Date()) {
  const t = Date.parse(startISO);
  if (!Number.isFinite(t)) return false;
  const iso = new Date(t).toISOString();
  return daySlots(avail, type, busy, localDate(new Date(t), avail.timeZone), now)
    .some(s => s.startISO === iso);
}

/** UTC bounds of a host-local date or month, for one freeBusy call. */
export function rangeFor(dateOrMonthISO, tz) {
  const s = String(dateOrMonthISO || "");
  const day = splitDay(s);
  if (day) {
    const [y, m, d] = day;
    return { timeMinISO: zonedToUtc(y, m - 1, d, 0, 0, tz).toISOString(),
             timeMaxISO: zonedToUtc(y, m - 1, d + 1, 0, 0, tz).toISOString() };
  }
  const mm = /^(\d{4})-(\d{2})$/.exec(s);
  if (!mm) return null;
  const [y, m] = [+mm[1], +mm[2]];
  return { timeMinISO: zonedToUtc(y, m - 1, 1, 0, 0, tz).toISOString(),
           timeMaxISO: zonedToUtc(y, m, 1, 0, 0, tz).toISOString() };
}
