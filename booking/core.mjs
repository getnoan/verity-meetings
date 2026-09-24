/**
 * The booking core. Everything the HTTP
 * server does, with every outside system injected so the tests run it whole:
 *
 *   store     booking rows (store-memory.mjs / store-supabase.mjs)
 *   calendar  { freeBusy, createEvent, updateEvent, cancelEvent, findEventByBooking }
 *   crm       { apply(row, type, item, remember) } — the NOAN writes (noan-sync.mjs)
 *   config    () => { avail, types } — Scheduling Agent Config + Booking Types, cached by the caller
 *   onCalendarMissed({ row, type, manageUrl })  Google failed during the request: the
 *             guest gets our own confirmation now, because the manage link exists
 *             only in this request (the row keeps just its hash)
 *   onStuck(row, error)  five failed attempts: park it for a human
 *
 * The booking path, in order: validate the start against the same slot engine
 * the page drew (isOfferedSlot, against a FRESH busy read) → claim the row (the
 * store refuses an overlap) → reconcile the calendar inline so the guest sees
 * the Meet link → answer → NOAN work queued on the row and run after the reply.
 * Anything a request could not finish, the sweeper finishes; five failures
 * park it for a human.
 *
 * Guest-typed text never chooses a route. Which tags and which agent a
 * booking reaches come only from its type in the Booking Types fact.
 */
import { createHash, randomBytes } from "node:crypto";
import { daySlots, monthDays, isOfferedSlot, rangeFor, localDate } from "../agents/slots.mjs";
import { StoreConflict } from "./store-errors.mjs";

export class BookingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g");
export const clean = (s, max) => String(s ?? "").replace(CONTROL, " ").replace(/\r\n?/g, "\n").trim().slice(0, max);

export const MAX_ANSWER = 500;
export const MAX_ANSWERS_TOTAL = 2000;
export const MAX_FUTURE_PER_GUEST = 3;
export const MAX_ATTEMPTS = 5;
/** A pre-call brief needs time to be useful: none for a call under this far away (PRE-CALL-BRIEF-PLAN §7.3).
 *  The default when the brief starts at once; server.mjs lengthens it when it can't (briefLeadFor). */
export const BRIEF_MIN_LEAD_MIN = 60;
/** How long a host's Google Calendar timezone is trusted before it is read again. Short
 *  enough that a host who lands and updates Google sees their page follow within the hour. */
export const HOST_TZ_TTL_MS = 15 * 60_000;
const PARKED_RETRY_MS = 6 * 3600_000;
// A call that never answers must become a failure, not a hang: a pending
// promise holds the booking's lock forever, and the sweeper, which works
// bookings one at a time, would wait behind it for good. Seen live on
// 2026-09-15: NOAN created the contact, its reply never came, nothing was
// recorded. NOAN items get room for the contact lookup, which sweeps every
// contact when the name search misses (~50s at ~800 contacts).
const NOAN_ITEM_DEADLINE_MS = 150_000;
const CALENDAR_DEADLINE_MS = 60_000;

function withDeadline(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} gave no answer in ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
const BUSY_CACHE_MS = 60_000;

export const hashToken = t => createHash("sha256").update(String(t)).digest("hex");
const TOKEN_RX = /^[A-Za-z0-9_-]{20,128}$/;

export function createBookingCore({ store, calendar, crm, config, publicUrl, now = () => new Date(), log = console.log, onStuck = async () => {}, onCalendarMissed = async () => {}, briefEnabled = false, briefMinLeadMin = BRIEF_MIN_LEAD_MIN,
  deadlines: { noanItemMs = NOAN_ITEM_DEADLINE_MS, calendarMs = CALENDAR_DEADLINE_MS } = {} }) {
  const busyCache = new Map();   // host|min|max → { at, busy }
  const tzCache = new Map();     // host → { at, tz }
  // Every change to one booking runs under its lock. The service is ONE process
  // (one Render instance), so this is the whole serialisation story: a guest
  // rescheduling while the booking's NOAN writes are still running can't drop a
  // queued item, and the sweeper can't create a second calendar event while a
  // request is creating the first.
  const locks = new Map();
  function withLock(id, fn) {
    const run = (locks.get(id) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return run;
  }
  const base = String(publicUrl || "").replace(/\/$/, "");

  /**
   * The zone a type's `hours` lines are read in, most specific first:
   *   1. the type's own `timezone:` line (a host who wants their page pinned)
   *   2. the host's Google Calendar zone, so their hours travel with them when they
   *      change it (cached HOST_TZ_TTL_MS; null when the calendar can't tell us)
   *   3. the Scheduling Agent Config's zone
   * Guests always see their own zone on the page; this is only how the host's week
   * is interpreted.
   */
  async function hostTimeZone(host) {
    if (typeof calendar.userTimeZone !== "function") return null;
    const hit = tzCache.get(host);
    if (hit && now().getTime() - hit.at < HOST_TZ_TTL_MS) return hit.tz;
    const tz = await calendar.userTimeZone(host).catch(() => null);
    tzCache.set(host, { at: now().getTime(), tz: tz || null });
    return tz || null;
  }

  /** The zone to show a booking in; a type that is no longer offered falls back to the config's. */
  const tzForRow = async (type, cfg) => (type ? (await availFor(type, cfg)).timeZone : cfg.avail.timeZone);

  /** cfg.avail with the timezone resolved for this type. Everything downstream reads it. */
  async function availFor(type, cfg) {
    const tz = type.timeZone || (await hostTimeZone(type.host)) || cfg.avail.timeZone;
    // A type's own `blocked dates:` replaces the config's, which are the config owner's
    // days off: one host's holiday must not close another host's page.
    const blockedDates = type.blockedDates || cfg.avail.blockedDates;
    if (tz === cfg.avail.timeZone && blockedDates === cfg.avail.blockedDates) return cfg.avail;
    return { ...cfg.avail, timeZone: tz, blockedDates };
  }

  async function findType(handle, slug) {
    const cfg = await config();
    const type = cfg.types.find(t => t.handle === String(handle || "").toLowerCase() && t.slug === String(slug || "").toLowerCase());
    if (!type) throw new BookingError(404, "That booking page doesn't exist.");
    return { cfg, type };
  }

  async function typeForRow(row) {
    const cfg = await config();
    return { cfg, type: cfg.types.find(t => t.host === row.host_email && t.slug === row.type_slug) || null };
  }

  /** Google busy times plus our own confirmed rows (which may not be on the calendar yet). */
  async function busyFor(host, range, { fresh = false, excludeRow = null } = {}) {
    const key = `${host}|${range.timeMinISO}|${range.timeMaxISO}`;
    let google = !fresh && busyCache.get(key);
    if (!google || now() - google.at > BUSY_CACHE_MS) {
      google = { at: now(), busy: await calendar.freeBusy(range.timeMinISO, range.timeMaxISO, host) };
      busyCache.set(key, google);
      if (busyCache.size > 500) busyCache.delete(busyCache.keys().next().value);
    }
    let busy = google.busy.slice();
    // A booking being moved must not block itself: drop its own time from Google's busy list.
    if (excludeRow) busy = subtract(busy, excludeRow.start_at, excludeRow.end_at);
    const ours = await store.listConfirmedBetween(host, range.timeMinISO, range.timeMaxISO);
    for (const r of ours) if (r.id !== excludeRow?.id) busy.push({ start: r.start_at, end: r.end_at });
    return busy;
  }

  function publicType(type, cfg, tz) {
    return {
      name: type.name, handle: type.handle, slug: type.slug, lengthMin: type.lengthMin,
      description: type.description || "", hostName: type.hostName || "", timeZone: tz,
      questions: type.questions.map(({ label, kind, required, input }) => ({ label, kind, required, input })),
      // the "brief me before the call" switch, only while the brief lane is switched on
      brief: briefEnabled && type.brief ? { variant: type.brief, minLeadMin: briefMinLeadMin } : null,
    };
  }

  function view(row, type, cfg, tz) {
    return {
      status: row.status, startISO: row.start_at, endISO: row.end_at, meetingUrl: row.meeting_url,
      guestName: row.guest_name, timeZone: tz,
      type: type ? { name: type.name, handle: type.handle, slug: type.slug, lengthMin: type.lengthMin, hostName: type.hostName || "" } : null,
    };
  }

  const manageUrl = (type, token) => `${base}/${type.handle}/${type.slug}/manage/${token}`;

  async function rowByToken(token) {
    if (!TOKEN_RX.test(String(token || ""))) throw new BookingError(404, "That link isn't valid. Use the link from your confirmation.");
    const row = await store.getByTokenHash(hashToken(token));
    if (!row) throw new BookingError(404, "That link isn't valid. Use the link from your confirmation.");
    return row;
  }

  /* ---------------- calendar reconcile: make Google match the row ---------------- */

  async function syncCalendar(row, type, token = null) {
    if (row.status === "cancelled") {
      if (row.google_event_id) {
        try { await calendar.cancelEvent(row.google_event_id, row.host_email); }
        catch (e) { if (!/→ (404|410)/.test(e.message)) throw e; }   // already gone is done
      }
      return store.update(row.id, { calendar_synced_at: now().toISOString() });
    }
    const cfg = await config();
    const tz = type ? await tzForRow(type, cfg) : cfg.avail.timeZone;   // the host's zone labels their own event
    const when = { start: { dateTime: row.start_at, timeZone: tz }, end: { dateTime: row.end_at, timeZone: tz } };
    if (row.google_event_id) {
      await calendar.updateEvent(row.google_event_id, when, row.host_email);
      return store.update(row.id, { calendar_synced_at: now().toISOString() });
    }
    // A retry after a create whose reply was lost must find that event, not make a second one.
    let ev = await calendar.findEventByBooking(row.id, row.host_email);
    if (!ev) {
      const lines = [];
      if (token && type) lines.push(`Reschedule or cancel: ${manageUrl(type, token)}`, "");
      for (const a of row.answers || []) lines.push(`${a.label}: ${a.value}`);
      ev = await calendar.createEvent({
        summary: renderSummary(type, row), description: lines.join("\n"),
        startISO: row.start_at, endISO: row.end_at, timeZone: tz, asUser: row.host_email,
        attendees: [{ email: row.guest_email, displayName: row.guest_name }],
        meet: true, requestId: `booking-${row.id}`, privateProps: { bookingId: row.id },
      });
    }
    const meet = ev.hangoutLink || ev.conferenceData?.entryPoints?.find(p => p.entryPointType === "video")?.uri || null;
    return store.update(row.id, { google_event_id: ev.id, meeting_url: meet, calendar_synced_at: now().toISOString() });
  }

  /** Run the NOAN work queued on a booking, oldest first. Each item is read
   *  fresh under the lock and leaves the queue only once applied, so an item
   *  appended meanwhile (a reschedule) is never lost. */
  async function syncNoan(id) {
    for (;;) {
      const done = await withLock(id, async () => {
        const cur = await store.get(id);
        if (!cur?.noan_queue?.length) return true;
        const { type } = await typeForRow(cur);
        const [item, ...rest] = cur.noan_queue;
        // remember() stores an id (contact, task) the moment it exists, so a later
        // failure in the same item can't make the retry create it a second time.
        const remember = p => store.update(id, p);
        const patch = await withDeadline(crm.apply(cur, type, item, remember), noanItemMs, `NOAN ${item.kind}`);
        await store.update(id, { ...(patch || {}), noan_queue: rest, noan_synced_at: now().toISOString(), last_error: null });
        return false;
      });
      if (done) return store.get(id);
    }
  }

  /** Calendar reconcile under the lock; a failure is recorded, never thrown at the guest. */
  async function settle(id, type, token) {
    return withLock(id, async () => {
      const cur = await store.get(id);
      if (cur.calendar_synced_at) return cur;
      try { return await withDeadline(syncCalendar(cur, type, token), calendarMs, "Google Calendar"); }
      catch (e) { return noteFailure(cur, `calendar: ${e.message}`); }
    });
  }

  async function noteFailure(row, message) {
    log(`booking ${row.id}: ${message}`);
    const next = await store.update(row.id, { attempts: (row.attempts || 0) + 1, last_error: message.slice(0, 500) });
    if (next && next.attempts === MAX_ATTEMPTS) {
      await onStuck(next, message).catch(e => log(`booking ${row.id}: stuck handler failed: ${e.message}`));
    }
    return next;
  }

  function runNoanLater(id) {
    syncNoan(id).catch(async e => noteFailure(await store.get(id), `noan: ${e.message}`));
  }

  return {
    /** The host's page: every type under a handle. */
    async host(handle) {
      const cfg = await config();
      const types = cfg.types.filter(t => t.handle === String(handle || "").toLowerCase());
      if (!types.length) throw new BookingError(404, "That booking page doesn't exist.");
      const zones = await Promise.all(types.map(t => availFor(t, cfg)));
      return { handle: types[0].handle, hostName: types.find(t => t.hostName)?.hostName || "",
        types: types.map((t, i) => publicType(t, cfg, zones[i].timeZone)) };
    },

    async type(handle, slug) {
      const { cfg, type } = await findType(handle, slug);
      return publicType(type, cfg, (await availFor(type, cfg)).timeZone);
    },

    /** Every slot in a host-local month, so the page can group them by the GUEST's own dates. */
    async month(handle, slug, month, { token } = {}) {
      const { cfg, type } = await findType(handle, slug);
      const avail = await availFor(type, cfg);
      const range = /^\d{4}-\d{2}$/.test(String(month || "")) && rangeFor(month, avail.timeZone);
      if (!range) throw new BookingError(400, "Month must look like 2026-09.");
      const excludeRow = token ? await rowByToken(token) : null;
      const busy = await busyFor(type.host, range, { excludeRow });
      const slots = monthDays(avail, type, busy, month, now())
        .flatMap(d => daySlots(avail, type, busy, d.date, now()));
      return { timeZone: avail.timeZone, slots };
    },

    /** Every start on one host-local date. */
    async slots(handle, slug, date, { token } = {}) {
      const { cfg, type } = await findType(handle, slug);
      const avail = await availFor(type, cfg);
      const range = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) && rangeFor(date, avail.timeZone);
      if (!range) throw new BookingError(400, "Date must look like 2026-09-22.");
      const excludeRow = token ? await rowByToken(token) : null;
      const busy = await busyFor(type.host, range, { excludeRow });
      return { timeZone: avail.timeZone, slots: daySlots(avail, type, busy, date, now()) };
    },

    async book(input) {
      const { cfg, type } = await findType(input.handle, input.slug);
      const name = clean(input.name, 120);
      const email = clean(input.email, 254).toLowerCase();
      if (!name) throw new BookingError(400, "Add your name.");
      if (!EMAIL_RX.test(email)) throw new BookingError(400, "That email address doesn't look right.");
      const answers = readAnswers(type, input.answers);

      const t = Date.parse(input.startISO);
      if (!Number.isFinite(t)) throw new BookingError(400, "Pick a time first.");
      const startISO = new Date(t).toISOString();
      if (await store.countFutureConfirmed(type.host, email, now().toISOString()) >= MAX_FUTURE_PER_GUEST) {
        throw new BookingError(429, "You already have several meetings booked. Reschedule one from its confirmation instead.");
      }
      const avail = await availFor(type, cfg);
      const range = rangeFor(localDate(new Date(t), avail.timeZone), avail.timeZone);
      const busy = await busyFor(type.host, range, { fresh: true });
      if (!isOfferedSlot(avail, type, busy, startISO, now())) {
        throw new BookingError(409, "That time is no longer available. Pick another.");
      }

      // The tick only counts where the type offers a brief, the lane is on, and there's time for it.
      const brief = input.brief === true && briefEnabled && !!type.brief && t - now().getTime() >= briefMinLeadMin * 60e3;
      const token = randomBytes(32).toString("base64url");
      let row;
      try {
        row = await store.insert({
          type_slug: type.slug, host_email: type.host, guest_name: name, guest_email: email, answers,
          start_at: startISO, end_at: new Date(t + type.lengthMin * 60e3).toISOString(),
          status: "confirmed", manage_token_hash: hashToken(token), source: clean(input.source, 80) || "page",
          noan_queue: [{ kind: "book" }, ...(brief ? [{ kind: "brief", variant: type.brief }] : [])],
        });
      } catch (e) {
        if (e instanceof StoreConflict) throw new BookingError(409, "That time was just taken. Pick another.");
        throw e;
      }
      busyCache.clear();
      row = await settle(row.id, type, token);
      if (!row.calendar_synced_at) {
        await onCalendarMissed({ row, type, manageUrl: manageUrl(type, token) })
          .catch(e => log(`booking ${row.id}: fallback confirmation failed: ${e.message}`));
      }
      runNoanLater(row.id);
      return { ...view(row, type, cfg, avail.timeZone), manageUrl: manageUrl(type, token), brief: brief ? "requested" : input.brief === true ? "skipped" : null };
    },

    async manage(token) {
      const row = await rowByToken(token);
      const { cfg, type } = await typeForRow(row);
      return view(row, type, cfg, await tzForRow(type, cfg));
    },

    async reschedule(token, startInput) {
      const row = await rowByToken(token);
      if (row.status !== "confirmed") throw new BookingError(409, "This meeting was cancelled, so it can't be moved. Book a new time instead.");
      const { cfg, type } = await typeForRow(row);
      if (!type) throw new BookingError(409, "This meeting type is no longer offered. Cancel it and book again.");
      const t = Date.parse(startInput);
      if (!Number.isFinite(t)) throw new BookingError(400, "Pick a time first.");
      const startISO = new Date(t).toISOString();
      const avail = await availFor(type, cfg);
      if (startISO === row.start_at) return view(row, type, cfg, avail.timeZone);
      const range = rangeFor(localDate(new Date(t), avail.timeZone), avail.timeZone);
      const busy = await busyFor(type.host, range, { fresh: true, excludeRow: row });
      if (!isOfferedSlot(avail, type, busy, startISO, now())) {
        throw new BookingError(409, "That time is no longer available. Pick another.");
      }
      let next = await withLock(row.id, async () => {
        const cur = await store.get(row.id);
        if (cur.status !== "confirmed" || cur.start_at !== row.start_at) return null;
        try {
          return await store.update(row.id, {
            start_at: startISO, end_at: new Date(t + type.lengthMin * 60e3).toISOString(),
            calendar_synced_at: null, attempts: 0,
            noan_queue: [...(cur.noan_queue || []), { kind: "reschedule", from: cur.start_at, to: startISO }],
          }, { expectStatus: "confirmed" });
        } catch (e) {
          if (e instanceof StoreConflict) throw new BookingError(409, "That time was just taken. Pick another.");
          throw e;
        }
      });
      if (!next) throw new BookingError(409, "This meeting changed while you were choosing. Reload and try again.");
      busyCache.clear();
      next = await settle(row.id, type, token);
      if (!next.calendar_synced_at) {
        await onCalendarMissed({ row: next, type, manageUrl: manageUrl(type, token) })
          .catch(e => log(`booking ${row.id}: fallback confirmation failed: ${e.message}`));
      }
      runNoanLater(row.id);
      return view(next, type, cfg, await tzForRow(type, cfg));
    },

    async cancel(token, reason) {
      const row = await rowByToken(token);
      const { cfg, type } = await typeForRow(row);
      if (row.status === "cancelled") return view(row, type, cfg, await tzForRow(type, cfg));
      let next = await withLock(row.id, async () => {
        const cur = await store.get(row.id);
        if (cur.status !== "confirmed") return null;
        return store.update(row.id, {
          status: "cancelled", calendar_synced_at: null, attempts: 0,
          noan_queue: [...(cur.noan_queue || []), { kind: "cancel", reason: clean(reason, 500) }],
        }, { expectStatus: "confirmed" });
      });
      if (!next) return view(await store.get(row.id), type, cfg, await tzForRow(type, cfg));
      busyCache.clear();
      next = await settle(row.id, type);
      runNoanLater(row.id);
      return view(next, type, cfg, await tzForRow(type, cfg));
    },

    /** Finish what requests could not: calendar reconcile, then the NOAN queue. */
    async sweep({ limit = 25 } = {}) {
      const rows = await store.listPending(limit);
      let done = 0, failed = 0;
      for (const row of rows) {
        // Parked for a human after MAX_ATTEMPTS: from then on, one retry every 6 hours,
        // so fixing the cause heals the booking without anyone touching it.
        if ((row.attempts || 0) >= MAX_ATTEMPTS && now() - Date.parse(row.updated_at) < PARKED_RETRY_MS) continue;
        const { type } = await typeForRow(row);
        try {
          if (!row.calendar_synced_at) {
            await withLock(row.id, async () => {
              const cur = await store.get(row.id);
              if (!cur.calendar_synced_at) await withDeadline(syncCalendar(cur, type), calendarMs, "Google Calendar");
            });
          }
          await syncNoan(row.id);
          done++;
        } catch (e) {
          failed++;
          await noteFailure(await store.get(row.id), e.message);
        }
      }
      return { checked: rows.length, done, failed };
    },

    /** Test seam: wait for NOAN work kicked off after a reply. */
    _syncNoan: syncNoan,
  };
}

/** Answers keyed by question index → [{label, kind, value}], required ones enforced, lengths capped. */
function readAnswers(type, raw) {
  const given = raw && typeof raw === "object" ? raw : {};
  const out = [];
  let total = 0;
  type.questions.forEach((q, i) => {
    const value = clean(given[i] ?? given[String(i)], MAX_ANSWER);
    if (!value) {
      if (q.required) throw new BookingError(400, `Answer "${q.label}".`);
      return;
    }
    total += value.length;
    if (total > MAX_ANSWERS_TOTAL) throw new BookingError(400, "Your answers are too long. Shorten them and try again.");
    out.push({ label: q.label, kind: q.kind, value });
  });
  return out;
}

function renderSummary(type, row) {
  if (!type) return `Meeting with ${row.guest_name}`;
  return type.title.replace(/\{type\}/g, type.name).replace(/\{guest\}/g, row.guest_name)
    .replace(/\{host\}/g, type.hostName || "").replace(/\s+/g, " ").trim();
}

/** Busy intervals minus [s, e): a booking being moved stops blocking its own old time. */
function subtract(busy, s, e) {
  const S = Date.parse(s), E = Date.parse(e);
  const out = [];
  for (const b of busy) {
    const bs = Date.parse(b.start), be = Date.parse(b.end);
    if (be <= S || bs >= E) { out.push(b); continue; }
    if (bs < S) out.push({ start: b.start, end: new Date(S).toISOString() });
    if (be > E) out.push({ start: new Date(E).toISOString(), end: b.end });
  }
  return out;
}
