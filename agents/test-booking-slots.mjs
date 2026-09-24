/**
 * slots.mjs (NOAN-MEETINGS-PLAN §6) — pure tests, pinned clock, no network.
 * Also proves the email lane still reads the Scheduling Agent Config the way
 * it always did, now through the shared parser.
 */
import assert from "node:assert";
import { parseScheduleFact, daySlots, monthDays, isOfferedSlot, rangeFor, hoursFor, weekdayOf } from "./slots.mjs";
import { computeSlots } from "./google-cal.mjs";
import { FACT as SCHEDULE_FACT } from "./seed-scheduling.mjs";

const ok = (name) => console.log("  ok  ", name);
const lisbon = (iso) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Lisbon" }).format(new Date(iso));

/* ---------- the shared parser reads the live fact's grammar unchanged ---------- */
const avail = parseScheduleFact(SCHEDULE_FACT);
const { weekHours, blockedDates, ...legacy } = avail;
assert.deepEqual(legacy, {
  timeZone: "Europe/Lisbon", workStart: "09:00", workEnd: "17:30", durationMin: 30, bufferMin: 15,
  lookaheadDays: 10, minNoticeHours: 24, maxSlots: 3, maxRounds: 2, meet: true,
});
ok("seed Scheduling Agent Config parses to the values reply-worker always used");
assert.deepEqual(weekHours.Mon, [["09:00", "17:30"]]);
assert.deepEqual(weekHours.Sat, []);
assert.equal(blockedDates.size, 0);
ok("working hours fill Mon–Fri; weekends off; no blocked dates by default");

const custom = parseScheduleFact(`${SCHEDULE_FACT}
hours Fri: 09:00-13:00
hours Wednesday: off
hours Sat: 10:00-12:00, 14:00-15:00
hours Tue: 9-5
blocked dates: 2026-09-24, 2026-02-30, nonsense`);
assert.deepEqual(custom.weekHours.Fri, [["09:00", "13:00"]]);
assert.deepEqual(custom.weekHours.Wed, []);
assert.deepEqual(custom.weekHours.Sat, [["10:00", "12:00"], ["14:00", "15:00"]]);
assert.deepEqual(custom.weekHours.Tue, [["09:00", "17:30"]], "a malformed line leaves the day on working hours");
assert.deepEqual([...custom.blockedDates], ["2026-09-24"], "impossible and junk dates are dropped");
ok("per-weekday hours, several windows, off days, blocked dates; malformed input degrades safely");

/* ---------- daySlots: the booking page grid ---------- */
const DEMO = { lengthMin: 30, stepMin: 30, minNoticeHours: 12, maxDaysOut: 30 };
const EARLY = new Date("2026-09-14T08:00:00Z");           // Mon, well before the dates below
const TUE = "2026-09-22";                                  // Lisbon is UTC+1 in September

let s = daySlots(avail, DEMO, [], TUE, EARLY);
assert.equal(s.length, 17);
assert.equal(lisbon(s[0].startISO), "09:00");
assert.equal(lisbon(s.at(-1).startISO), "17:00");
assert.equal(s[0].startISO, "2026-09-22T08:00:00.000Z");
ok("empty Tuesday: 09:00–17:00 starts every 30 minutes in the host's timezone (17)");

const busy = [{ start: "2026-09-22T10:00:00Z", end: "2026-09-22T11:00:00Z" }]; // 11:00–12:00 Lisbon
s = daySlots(avail, DEMO, busy, TUE, EARLY);
assert.deepEqual(s.map(x => lisbon(x.startISO)).filter(t => t >= "10:00" && t <= "12:30"), ["10:00", "12:30"]);
ok("a busy hour plus the 15-minute buffer removes 10:30, 11:00, 11:30 and 12:00");

s = daySlots(avail, { ...DEMO, bufferMin: 0 }, busy, TUE, EARLY);
assert.deepEqual(s.map(x => lisbon(x.startISO)).filter(t => t >= "10:00" && t <= "12:30"), ["10:00", "10:30", "12:00", "12:30"]);
ok("a type's own buffer overrides the host default");

s = daySlots(avail, { lengthMin: 45 }, [], TUE, EARLY);
assert.deepEqual(s.slice(0, 3).map(x => lisbon(x.startISO)), ["09:00", "09:30", "10:00"]);
assert.equal(lisbon(s.at(-1).startISO), "16:30", "a 45-minute slot must end by 17:30");
ok("45-minute type starts every 30 minutes (not every 45) and still fits the day");

s = daySlots(avail, DEMO, [], TUE, new Date("2026-09-21T22:10:00Z")); // 23:10 Mon Lisbon, 12h notice
assert.equal(lisbon(s[0].startISO), "11:30");
ok("minimum notice: 12 hours from 23:10 → first start 11:30");

assert.deepEqual(daySlots(avail, DEMO, [], "2026-10-30", EARLY), []);
ok("beyond max days out: nothing");
assert.deepEqual(daySlots(avail, DEMO, [], "2026-09-26", EARLY), []);
ok("Saturday with no Saturday hours: nothing");
assert.deepEqual(daySlots(custom, DEMO, [], "2026-09-24", EARLY), []);
ok("blocked date: nothing");
assert.equal(daySlots(custom, DEMO, [], "2026-09-26", EARLY).length, 4 + 2);
ok("Saturday with two windows: 10:00–12:00 and 14:00–15:00");
assert.deepEqual(daySlots(avail, DEMO, [], "2026-02-30", EARLY), []);
assert.deepEqual(daySlots(avail, DEMO, [], "garbage", EARLY), []);
ok("impossible or malformed dates: nothing, no throw");

// A type's own hours are ITS HOST's week, not a narrowing of the fact's: the fact belongs
// to whoever owns it, and a second host's day must not be capped by the first host's.
const own = { ...DEMO, weekHours: { Tue: [["13:00", "20:00"]], Wed: [] } };
assert.deepEqual(hoursFor(avail, own, TUE), [["13:00", "20:00"]]);
s = daySlots(avail, own, [], TUE, EARLY);
assert.equal(lisbon(s[0].startISO), "13:00");
assert.equal(lisbon(s.at(-1).startISO), "19:30", "past the fact's 17:30: this host works later");
assert.deepEqual(daySlots(avail, own, [], "2026-09-23", EARLY), [], "a day set off is closed");
assert.deepEqual(hoursFor(avail, DEMO, TUE), [["09:00", "17:30"]], "a type with no hours of its own keeps the fact's week");
ok("a type's own hours are its host's week: earlier, later, or a day off");

/* ---------- DST: Lisbon springs forward on Sun 2026-03-29 ---------- */
const sundays = parseScheduleFact(`${SCHEDULE_FACT}\nhours Sat: 09:00-10:00\nhours Sun: 09:00-10:00`);
const WINTER = new Date("2026-03-01T00:00:00Z");
assert.equal(weekdayOf("2026-03-29", "Europe/Lisbon"), "Sun");
assert.equal(daySlots(sundays, DEMO, [], "2026-03-28", WINTER)[0].startISO, "2026-03-28T09:00:00.000Z");
assert.equal(daySlots(sundays, DEMO, [], "2026-03-29", WINTER)[0].startISO, "2026-03-29T08:00:00.000Z");
ok("09:00 Lisbon is 09:00Z the day before the clocks change and 08:00Z the day after");

/* ---------- isOfferedSlot: the write-time check ---------- */
const offered = daySlots(avail, DEMO, [], TUE, EARLY)[4].startISO;
assert.equal(isOfferedSlot(avail, DEMO, [], offered, EARLY), true);
assert.equal(isOfferedSlot(avail, DEMO, [], "2026-09-22T02:00:00Z", EARLY), false, "3am");
assert.equal(isOfferedSlot(avail, DEMO, [], "2026-09-22T08:15:00Z", EARLY), false, "off the grid");
assert.equal(isOfferedSlot(avail, DEMO, [], "2026-09-26T09:00:00Z", EARLY), false, "Saturday");
assert.equal(isOfferedSlot(avail, DEMO, [], "2026-09-10T09:00:00Z", EARLY), false, "the past");
assert.equal(isOfferedSlot(avail, DEMO, busy, "2026-09-22T10:00:00Z", EARLY), false, "busy");
assert.equal(isOfferedSlot(avail, DEMO, [], "not a date", EARLY), false);
ok("only a start the page could have shown is bookable: not 3am, off-grid, weekends, the past or busy times");

/* ---------- monthDays + rangeFor ---------- */
const sept = monthDays(custom, { ...DEMO, maxDaysOut: 60 }, [], "2026-09", new Date("2026-08-31T00:00:00Z"));
assert.equal(sept.find(d => d.date === "2026-09-24"), undefined, "blocked");
assert.equal(sept.some(d => weekdayOf(d.date, "Europe/Lisbon") === "Wed"), false, "Wednesdays off");
assert.equal(sept.find(d => d.date === "2026-09-25").slots, 8, "Friday 09:00–13:00");
ok("monthDays lists only dates with slots, with per-day counts");

assert.deepEqual(rangeFor(TUE, "Europe/Lisbon"), { timeMinISO: "2026-09-21T23:00:00.000Z", timeMaxISO: "2026-09-22T23:00:00.000Z" });
assert.deepEqual(rangeFor("2026-12", "Europe/Lisbon"), { timeMinISO: "2026-12-01T00:00:00.000Z", timeMaxISO: "2027-01-01T00:00:00.000Z" });
assert.equal(rangeFor("junk", "Europe/Lisbon"), null);
ok("rangeFor gives the host-local day or month as UTC bounds for one freeBusy call");

/* ---------- the email lane reads the same hours ---------- */
const NOW = new Date("2026-07-20T08:00:00Z");
const LEGACY_CFG = { timeZone: "Europe/Lisbon", workStart: "09:00", workEnd: "17:30", durationMin: 30, bufferMin: 15, lookaheadDays: 10, minNoticeHours: 24, maxSlots: 3, meet: true };
assert.deepEqual(computeSlots(avail, [], NOW), computeSlots(LEGACY_CFG, [], NOW));
ok("computeSlots offers the same times from the parsed fact as from the old config shape");

const wedOff = parseScheduleFact(`${SCHEDULE_FACT}\nhours Wed: off\nhours Thu: 14:00-16:00\nblocked dates: 2026-07-24`);
const c = computeSlots({ ...wedOff, maxSlots: 10 }, [], NOW);
const dow = (iso) => new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "Europe/Lisbon" }).format(new Date(iso));
assert.equal(c.some(x => dow(x.startISO) === "Wed"), false, "Wednesday off");
assert.equal(c.some(x => x.startISO.startsWith("2026-07-24")), false, "blocked Friday");
assert(c.filter(x => dow(x.startISO) === "Thu").every(x => lisbon(x.startISO) >= "14:00" && lisbon(x.endISO) <= "16:00"), "Thursday afternoon only");
ok("computeSlots honours per-weekday hours and blocked dates from the shared parser");

console.log("\nslots: all passed");
