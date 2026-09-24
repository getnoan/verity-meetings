/**
 * The booking core (booking/core.mjs + noan-sync.mjs): booking, reschedule, cancel
 * and the sweeper against the in-memory store (which enforces the same no-overlap
 * rule as the Postgres constraint), a fake Google Calendar and a fake NOAN, under a
 * pinned clock. No network, no HTTP.
 */
import assert from "node:assert";
import { createBookingCore, hashToken, MAX_ATTEMPTS } from "../booking/core.mjs";
import { createFakeCalendar } from "../booking/fake-calendar.mjs";
import { createMemoryStore } from "../booking/store-memory.mjs";
import { createNoanCrm } from "../booking/noan-sync.mjs";
import { ics } from "../booking/alerts.mjs";
import { parseScheduleFact } from "./slots.mjs";
import { parseBookingTypes } from "./booking-types.mjs";
import { DEFAULT_TRIGGER_TAGS } from "./trigger-tags.mjs";
import { sanitizeCopy } from "./noan.mjs";
import { FACT as SCHEDULE_FACT } from "./seed-scheduling.mjs";

const ok = (name) => console.log("  ok  ", name);
const HOST = "host@example.com", HOST_ID = "id-host", VERITY = "id-agent";

const TYPES = parseBookingTypes(`
## Demo
link: neal/demo
host: host@example.com
host name: Neal Mann
length minutes: 30
min notice hours: 12
max days out: 30
title: NOAN demo with {guest}
questions:
- Company | company | required
- Phone | phone
- What would you like to see? | long
contact tags: Lead, Demo Booked
on book: task owner host
on cancel: close task
verity brief: customer

## Intro
link: neal/intro
host: host@example.com
length minutes: 45
on book: task tag Deck
on cancel: task tag reengage

## Chat
link: neal/chat
host: host@example.com
length minutes: 30
min notice hours: 0
verity brief: customer

## Quick
link: neal/quick
host: host@example.com
length minutes: 15
on book: task owner verity
`, { triggerTags: DEFAULT_TRIGGER_TAGS });
assert.deepEqual(TYPES.errors, []);

/* ---------------- fake NOAN ---------------- */
function fakeNoan() {
  const db = { contacts: new Map(), tasks: new Map(), memos: [] };
  const tagIds = { lead: "tag-lead", "demo booked": "tag-demo", deck: "tag-deck", reengage: "tag-reengage", "pre-call brief": "tag-brief" };
  let n = 0;
  const api = {
    sanitizeCopy,
    async findOrCreateContactByEmail(email, { name }) {
      for (const c of db.contacts.values()) if (c.email === email) return { contact: c, created: false };
      const c = { id: `c${++n}`, email, name, tags: [], memos: [] };
      db.contacts.set(c.id, c);
      return { contact: c, created: true };
    },
    async noanGet(path) {
      const m = /^\/contacts\/(\w+)$/.exec(path);
      if (m) return { contact: structuredClone(db.contacts.get(m[1])) };
      throw new Error(`fake noanGet ${path}`);
    },
    async noanPatch(path, body) {
      let m;
      if ((m = /^\/contacts\/(\w+)$/.exec(path))) {
        const c = db.contacts.get(m[1]);
        const { tagIds: ids, ...fields } = body;
        Object.assign(c, fields);
        if (ids) c.tags = ids.map(id => ({ id }));
        return {};
      }
      if ((m = /^\/tasks\/(\w+)$/.exec(path))) { Object.assign(db.tasks.get(m[1]), body); return {}; }
      throw new Error(`fake noanPatch ${path}`);
    },
    async noanPost(path, body) {
      if (path !== "/tasks") throw new Error(`fake noanPost ${path}`);
      const t = { id: `t${++n}`, ...body, tags: [], assignees: [], contacts: [] };
      db.tasks.set(t.id, t);
      return { task: { id: t.id } };
    },
    // The real helper reads the board uncached. Modelled rather than stubbed
    // away, because booking's retry path after a timeout IS this lookup.
    async findTaskByExternalIdFresh(externalId) {
      return [...db.tasks.values()].find(t => t.externalId === externalId) || null;
    },
    async noanPut(path, body) {
      const m = /^\/tasks\/(\w+)\/contacts$/.exec(path);
      if (!m) throw new Error(`fake noanPut ${path}`);
      db.tasks.get(m[1]).contacts = body.contactIds.map(id => ({ id }));
      return {};
    },
    async addContactMemo(id, content, title) { db.memos.push({ id, content, title }); db.contacts.get(id).memos.push({ title, content }); },
    async findTagId(name) { return tagIds[name.toLowerCase()] || null; },
    async addTaskTags(task, ...names) { const t = db.tasks.get(task.id); for (const nm of names) t.tags.push({ id: tagIds[nm.toLowerCase()], name: nm }); },
    async assignResolvedOwner(id, { requesterEmail, keep = [] }) { db.tasks.get(id).assignees = [...keep, requesterEmail === HOST ? HOST_ID : "id-fallback"].map(x => ({ id: x })); return {}; },
    async appendTaskNote(id, text) { const t = db.tasks.get(id); t.details += `\n[agent] ${text}`; },
    // A comment does NOT touch details — that is the point of the move, so the
    // fake must not quietly keep appending to them.
    async postTaskComment(id, text) { const t = db.tasks.get(id); (t.comments ||= []).push({ id: `c${t.comments?.length || 0}`, content: text }); },
    async findTaskById(id) { return structuredClone(db.tasks.get(id)); },
    async assignVerity(task) { db.tasks.get(task.id).assignees.push({ id: VERITY }); },
  };
  return { api, db };
}

/* ---------------- harness ---------------- */
let clock = Date.parse("2026-09-14T08:00:00Z");      // Monday; Lisbon is UTC+1
const now = () => new Date(clock);
const avail = parseScheduleFact(SCHEDULE_FACT);

function harness({ calendar = createFakeCalendar(), crmOverride = null, deadlines, briefEnabled = false, briefMinLeadMin } = {}) {
  const store = createMemoryStore({ now });
  const noan = fakeNoan();
  const dispatched = [];
  const crm = crmOverride || createNoanCrm({ api: noan.api, verityId: VERITY, timeZone: avail.timeZone, publicUrl: "https://meet.test",
    dispatch: async (d) => { dispatched.push(d); return true; } });
  const alerts = { stuck: [], missed: [] };
  const core = createBookingCore({
    store, calendar, crm, now, publicUrl: "https://meet.test", log: () => {},
    config: async () => ({ avail, types: TYPES.types }),
    onStuck: async (row, msg) => { alerts.stuck.push({ row, msg }); },
    onCalendarMissed: async (x) => { alerts.missed.push(x); },
    deadlines, briefEnabled, ...(briefMinLeadMin ? { briefMinLeadMin } : {}),
  });
  /** Run a core call the way the server does: a BookingError becomes its status. */
  const attempt = async (fn, okStatus = 200) => {
    try { return { status: okStatus, data: await fn() }; }
    catch (e) { if (e.status) return { status: e.status, data: { message: e.message } }; throw e; }
  };
  const book = input => attempt(() => core.book(input), 201);
  return { store, noan, core, calendar, alerts, attempt, book, dispatched };
}

const TUE_0900 = "2026-09-22T08:00:00.000Z", TUE_0930 = "2026-09-22T08:30:00.000Z", TUE_1400 = "2026-09-22T13:00:00.000Z";
const demo = (over = {}) => ({ handle: "neal", slug: "demo", startISO: TUE_0900, name: "Cooper Walters", email: "Cooper@acme.example",
  answers: { 0: "Acme", 1: "+44 7700 900123", 2: "Pipeline — and how agents use facts" }, ...over });
const tokenOf = url => url.split("/manage/")[1];

/* ================= validation, the happy path, NOAN ================= */
{
  const h = harness();
  const month = await h.core.month("neal", "demo", "2026-09");
  assert(month.slots.some(s => s.startISO === TUE_0900));
  assert.equal((await h.attempt(() => h.core.month("neal", "demo", "Sept"))).status, 400);
  assert.equal((await h.attempt(() => h.core.type("neal", "nope"))).status, 404);
  ok("month returns the grid; a malformed month is a 400; an unknown type is a 404");

  for (const [bad, want] of [
    [demo({ startISO: "2026-09-22T02:00:00Z" }), 409],      // 3am Lisbon
    [demo({ startISO: "2026-09-22T08:15:00Z" }), 409],      // off the grid
    [demo({ startISO: "2026-09-26T09:00:00Z" }), 409],      // Saturday
    [demo({ startISO: "2026-09-10T09:00:00Z" }), 409],      // the past
    [demo({ startISO: "nope" }), 400],
    [demo({ email: "not-an-email" }), 400],
    [demo({ name: "  " }), 400],
    [demo({ answers: { 1: "x" } }), 400],                   // required Company missing
    [demo({ answers: { 0: "Acme", 2: "x".repeat(600) } }), 201],   // a long answer is capped, not refused
  ]) {
    const r = await h.book(bad);
    assert.equal(r.status, want, `${JSON.stringify(bad).slice(0, 90)} → ${r.status} ${JSON.stringify(r.data)}`);
    if (want === 201) await h.core.cancel(tokenOf(r.data.manageUrl));
  }
  ok("a start the page couldn't show is refused (3am, off-grid, weekend, past); bad input is a 400");

  const r = await h.book(demo());
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.startISO, TUE_0900);
  assert.match(r.data.meetingUrl, /^https:\/\/meet\.google\.com\//);
  assert.match(r.data.manageUrl, /^https:\/\/meet\.test\/neal\/demo\/manage\/[\w-]{40,}$/);
  const token = tokenOf(r.data.manageUrl);
  const [row] = await h.store.listConfirmedBetween(HOST, "2026-09-22T00:00:00Z", "2026-09-23T00:00:00Z");
  assert.equal(row.manage_token_hash, hashToken(token));
  assert(!JSON.stringify(row).includes(token), "the token itself is never stored");
  assert.equal(row.guest_email, "cooper@acme.example");
  const ev = [...h.calendar.events.values()].find(e => e.privateProps?.bookingId === row.id);
  assert.equal(ev.requestId, `booking-${row.id}`);
  assert.equal(ev.asUser, HOST);
  assert.deepEqual(ev.attendees, [{ email: "cooper@acme.example", displayName: "Cooper Walters" }]);
  assert.equal(ev.summary, "NOAN demo with Cooper Walters");
  assert(ev.description.startsWith(`Reschedule or cancel: ${r.data.manageUrl}`));
  ok("booked: Meet link + manage link back; event as the host with a stable requestId; only the token's hash stored");

  await h.core._syncNoan(row.id);
  const c = [...h.noan.db.contacts.values()].find(x => x.email === "cooper@acme.example");
  assert.equal(c.name, "Cooper Walters");
  assert.equal(c.phoneNumber, "+44 7700 900123", "an empty field is filled from the answer");
  assert.deepEqual(c.tags.map(t => t.id).sort(), ["tag-demo", "tag-lead"]);
  const memo = h.noan.db.memos.find(m => m.title === `booking:${row.id}:book`);
  assert.match(memo.content, /Guest answers \(written by the guest, unverified\):/);
  assert.doesNotMatch(memo.content, /—/, "no em dashes reach NOAN, even from guest text");
  const task = h.noan.db.tasks.get((await h.store.get(row.id)).noan_task_id);
  assert.equal(task.externalId, `booking:${row.id}`);
  assert.equal(task.status, "backlog");
  assert.equal(task.dueDate, TUE_0900);
  assert.match(task.title, /^Demo: Cooper Walters · Tue 22 Sep 09:00$/);
  assert.match(task.details, /Respond by: Nothing comes back/);
  assert.match(task.details, new RegExp(`Contact ID: ${c.id}`));
  assert.deepEqual(task.contacts, [{ id: c.id }]);
  assert.deepEqual(task.assignees, [{ id: HOST_ID }]);
  assert.deepEqual((await h.store.get(row.id)).noan_queue, []);
  ok("NOAN: contact found-or-created, empty phone filled, Lead + Demo Booked merged, framed memo, host-owned task due at the start");

  await h.store.update(row.id, { noan_queue: [{ kind: "book" }] });
  await h.core._syncNoan(row.id);
  assert.equal(h.noan.db.memos.filter(m => m.title === `booking:${row.id}:book`).length, 1);
  assert.equal([...h.noan.db.tasks.values()].filter(t => t.externalId === `booking:${row.id}`).length, 1);
  ok("running the book item twice writes one memo and one task");

  assert.equal((await h.book(demo({ email: "someone@else.example" }))).status, 409);
  ok("the same slot can't be booked twice");
}

/* ================= the race, the per-guest cap ================= */
{
  const h = harness();
  const rs = await Promise.all([0, 1, 2, 3].map(i => h.book(demo({ email: `racer${i}@example.com` }))));
  assert.deepEqual(rs.map(r => r.status).sort(), [201, 409, 409, 409]);
  ok("four guests racing for one slot: exactly one booking");

  // an hour apart: 09:30 would sit inside the 15-minute buffer after the 09:00 booking
  for (const [i, start] of ["2026-09-22T09:00:00.000Z", "2026-09-22T10:00:00.000Z", "2026-09-22T11:00:00.000Z"].entries()) {
    assert.equal((await h.book(demo({ startISO: start, email: "keen@example.com" }))).status, 201, `booking ${i}`);
  }
  assert.equal((await h.book(demo({ startISO: TUE_1400, email: "keen@example.com" }))).status, 429);
  ok("one guest can hold at most 3 future bookings with a host");
}

/* ================= manage: reschedule, cancel ================= */
{
  const h = harness();
  const b = await h.book(demo());
  const token = tokenOf(b.data.manageUrl);
  const [row] = await h.store.listConfirmedBetween(HOST, TUE_0900, TUE_1400);
  await h.core._syncNoan(row.id);

  for (const bad of ["xxxxxxxxxx,guest_email.eq.cooper@acme.example", "short", "a".repeat(43)]) {
    assert.equal((await h.attempt(() => h.core.cancel(bad))).status, 404, bad);
  }
  assert.equal((await h.core.manage(token)).status, "confirmed", "none of those cancelled anything");
  ok("filter-injection and wrong tokens are 404s that change nothing");

  let m = await h.core.month("neal", "demo", "2026-09", { token });
  assert(m.slots.some(s => s.startISO === TUE_0900), "while moving, the booking's own time is offered back");
  assert(!(await h.core.month("neal", "demo", "2026-09")).slots.some(s => s.startISO === TUE_0900));
  assert.equal((await h.attempt(() => h.core.reschedule(token, "2026-09-22T08:15:00Z"))).status, 409);
  const moved = await h.core.reschedule(token, TUE_1400);
  assert.equal(moved.startISO, TUE_1400);
  assert.equal(h.calendar.events.get((await h.store.get(row.id)).google_event_id).start.dateTime, TUE_1400);
  await h.core._syncNoan(row.id);
  const task = h.noan.db.tasks.get((await h.store.get(row.id)).noan_task_id);
  assert.equal(task.dueDate, TUE_1400);
  assert.match(task.title, /Tue 22 Sep 14:00$/);
  // The reschedule is recorded as a COMMENT now, not appended to the brief.
  assert.match((task.comments || []).map(c => c.content).join("\n"), /moved this meeting from Tue 22 Sep 2026, 09:00 \(Europe\/Lisbon\) to Tue 22 Sep 2026, 14:00/);
  assert.doesNotMatch(String(task.details || ""), /moved this meeting from/, "the task's own description is left alone");
  assert(h.noan.db.memos.some(x => x.title === `booking:${row.id}:reschedule:${TUE_1400}`));
  ok("reschedule: off-grid refused; moves the row, the event, the task's due date and title; memo + note");

  const cancelled = await h.core.cancel(token, "Something came up.");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(h.calendar.events.size, 0, "the Google event is cancelled");
  await h.core._syncNoan(row.id);
  assert.equal(task.status, "done"); assert.equal(task.completed, true);
  assert.match((task.comments || []).map(c => c.content).join("\n"), /cancelled this meeting\. Their reason \(unverified\): Something came up\.$/m, "one full stop, even when the guest typed one");
  assert.equal((await h.core.cancel(token)).status, "cancelled", "cancelling twice is fine");
  assert.equal((await h.attempt(() => h.core.reschedule(token, TUE_0930))).status, 409);
  assert.equal((await h.book(demo({ email: "next@example.com", startISO: TUE_1400 }))).status, 201, "the freed slot is bookable again");
  ok("cancel: event removed, task closed with the reason, idempotent, freed slot bookable, a cancelled meeting can't be moved");
}

/* ================= routes to agents ================= */
{
  const h = harness();
  const intro = await h.book({ handle: "neal", slug: "intro", startISO: TUE_0900, name: "Ada", email: "ada@example.com", answers: {} });
  const quick = await h.book({ handle: "neal", slug: "quick", startISO: TUE_1400, name: "Bo", email: "bo@example.com", answers: {} });
  assert.equal(intro.status, 201); assert.equal(quick.status, 201);
  for (const r of await h.store.listConfirmedBetween(HOST, TUE_0900, "2026-09-23T00:00:00Z")) await h.core._syncNoan(r.id);
  const tasks = [...h.noan.db.tasks.values()];
  const introTask = tasks.find(t => t.title.startsWith("Intro"));
  const quickTask = tasks.find(t => t.title.startsWith("Quick"));
  assert.deepEqual(introTask.tags.map(t => t.name), ["Deck"]);
  assert.deepEqual(introTask.assignees.map(a => a.id), [VERITY, HOST_ID]);
  assert.doesNotMatch(introTask.details, /Respond by/, "an agent-routed task is the agent's to work");
  assert.deepEqual(quickTask.tags, []);
  assert.deepEqual(quickTask.assignees.map(a => a.id), [VERITY, HOST_ID]);
  ok("on book: `task tag Deck` → tagged + agent + host; `task owner verity` → agent + host, untagged (the general agent)");

  await h.core.cancel(tokenOf(intro.data.manageUrl));
  for (const r of await h.store.listPending(10)) await h.core._syncNoan(r.id);
  assert.deepEqual(introTask.tags.map(t => t.name), ["Deck", "reengage"]);
  assert.notEqual(introTask.status, "done");
  ok("on cancel: `task tag reengage` hands the task to that agent instead of closing it");
}

/* ================= failures: calendar, the lost reply, stuck, the race with a reschedule ================= */
{
  const cal = createFakeCalendar();
  const realCreate = cal.createEvent;
  let mode = "fail";
  cal.createEvent = async (e) => {
    if (mode === "fail") throw new Error("Google Calendar POST → 503");
    if (mode === "lost") { await realCreate(e); throw new Error("socket hang up"); }
    return realCreate(e);
  };
  const h = harness({ calendar: cal });
  const r = await h.book(demo());
  assert.equal(r.status, 201, "a Google outage doesn't lose the booking");
  assert.equal(r.data.meetingUrl, null);
  assert.equal(h.alerts.missed.length, 1);
  assert.equal(h.alerts.missed[0].manageUrl, r.data.manageUrl, "the fallback confirmation carries the manage link");
  const id = h.alerts.missed[0].row.id;
  mode = "lost";
  await h.core.sweep();
  assert.equal(cal.events.size, 1, "the create landed even though its reply was lost");
  mode = "ok";
  await h.core.sweep();
  assert.equal(cal.events.size, 1, "the retry found that event instead of creating a second");
  assert((await h.store.get(id)).calendar_synced_at);
  assert.match((await h.store.get(id)).meeting_url, /^https:\/\/meet/);
  assert.equal(ics(await h.store.get(id), "Demo").split("\r\n").find(l => l.startsWith("DTSTART")), "DTSTART:20260922T080000Z");
  ok("calendar down at booking: booked anyway, fallback email with the manage link; sweeper creates the event exactly once");
}
{
  let fail = true;
  const noan = fakeNoan();
  const real = createNoanCrm({ api: noan.api, verityId: VERITY, timeZone: avail.timeZone });
  const h = harness({ crmOverride: { apply: (...a) => (fail ? Promise.reject(new Error("NOAN 502")) : real.apply(...a)) } });
  assert.equal((await h.book(demo())).status, 201);
  const [row] = await h.store.listConfirmedBetween(HOST, TUE_0900, TUE_1400);
  await new Promise(r => setTimeout(r, 20));   // the after-reply attempt
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await h.core.sweep();
  assert.equal(h.alerts.stuck.length, 1, "parked once, not on every later failure");
  assert.equal((await h.store.get(row.id)).attempts, MAX_ATTEMPTS);
  fail = false;
  await h.core.sweep();
  assert.equal((await h.store.get(row.id)).noan_queue.length, 1, "a parked booking waits 6 hours between retries");
  clock += 7 * 3600_000;
  await h.core.sweep();
  assert.deepEqual((await h.store.get(row.id)).noan_queue, [], "once the cause is fixed it heals on its own");
  clock -= 7 * 3600_000;
  ok("NOAN down: five failures park it once for a human; retries every 6 hours; heals when NOAN is back");
}

{
  // An abandoned create must not become a second task.
  //
  // withDeadline in core.mjs is a Promise.race: an item that gives no answer in
  // time leaves the NOAN write STILL RUNNING, so the task can land while the
  // remember() that records its id never does. The queue then retries against a
  // row that still shows no task. On 2026-09-17 that filed two open tasks for
  // the same guest, 41 seconds apart (booking:17ffd50e). The row's own
  // noan_task_id cannot close that window; only reading the board can.
  const noan = fakeNoan();
  const real = createNoanCrm({ api: noan.api, verityId: VERITY, timeZone: avail.timeZone });
  let swallow = true;
  const h = harness({ crmOverride: { apply: async (row, type, item, remember) => {
    // Faithful to the trap: the create RUNS, the id it produced is never
    // persisted, and the item then errors so the queue retries it. Dropping
    // only the noan_task_id write is what a Promise.race losing the race does
    // to this code path.
    const dropped = p => ("noan_task_id" in p ? Promise.resolve() : remember(p));
    const out = await real.apply(row, type, item, swallow ? dropped : remember);
    if (swallow) throw new Error("NOAN gave no answer in 20s");
    return out;
  } } });
  assert.equal((await h.book(demo())).status, 201);
  await new Promise(r => setTimeout(r, 20));
  await h.core.sweep();                                    // the create lands; the item is retried
  const afterFirst = [...noan.db.tasks.values()].filter(t => String(t.externalId || "").startsWith("booking:"));
  assert.equal(afterFirst.length, 1, "the abandoned attempt did file one task");
  const row = (await h.store.listConfirmedBetween(HOST, TUE_0900, TUE_1400))[0];
  assert.ok(!(await h.store.get(row.id)).noan_task_id, "and its id was lost, which is the whole trap");
  swallow = false;
  clock += 7 * 3600_000;
  await h.core.sweep();
  clock -= 7 * 3600_000;
  const afterRetry = [...noan.db.tasks.values()].filter(t => String(t.externalId || "").startsWith("booking:"));
  assert.equal(afterRetry.length, 1, "the retry found it instead of filing a second");
  assert.equal((await h.store.get(row.id)).noan_task_id, afterFirst[0].id, "and recorded the id that was lost");
  ok("a create abandoned by a timeout is found on the retry, not filed twice");
}
{
  let release;
  const gate = new Promise(r => { release = r; });
  const noan = fakeNoan();
  const real = createNoanCrm({ api: noan.api, verityId: VERITY, timeZone: avail.timeZone });
  const h = harness({ crmOverride: { apply: async (row, type, item, remember) => { if (item.kind === "book") await gate; return real.apply(row, type, item, remember); } } });
  const b = await h.book(demo());
  const moving = h.core.reschedule(tokenOf(b.data.manageUrl), TUE_1400);
  await new Promise(r => setTimeout(r, 30));
  release();
  assert.equal((await moving).startISO, TUE_1400);
  const [row] = await h.store.listConfirmedBetween(HOST, TUE_1400, "2026-09-23T00:00:00Z");
  await h.core._syncNoan(row.id);
  assert.deepEqual((await h.store.get(row.id)).noan_queue, []);
  assert(noan.db.memos.some(m => m.title.includes(":reschedule:")), "the reschedule queued mid-sync was applied, not dropped");
  assert.equal(noan.db.tasks.size, 1);
  ok("a reschedule during the booking's NOAN writes is serialised behind them and nothing is lost");
}

{
  // Live 2026-09-15: NOAN created the contact and never answered. A hang must become a
  // recorded failure that frees the booking and lets the sweeper move on to the next one.
  const noan = fakeNoan();
  const real = createNoanCrm({ api: noan.api, verityId: VERITY, timeZone: avail.timeZone });
  let hang = true;
  const h = harness({
    deadlines: { noanItemMs: 50, calendarMs: 50 },
    crmOverride: { apply: (row, type, item, remember) => (hang && row.guest_email === "stuck@example.com" ? new Promise(() => {}) : real.apply(row, type, item, remember)) },
  });
  assert.equal((await h.book(demo({ email: "stuck@example.com" }))).status, 201);
  assert.equal((await h.book(demo({ email: "fine@example.com", startISO: TUE_1400 }))).status, 201);
  await new Promise(r => setTimeout(r, 120));
  const [stuck, fine] = await h.store.listConfirmedBetween(HOST, TUE_0900, "2026-09-23T00:00:00Z");
  assert.equal((await h.store.get(stuck.id)).attempts, 1, "the hang was recorded as a failure");
  assert.match((await h.store.get(stuck.id)).last_error, /NOAN book gave no answer/);
  const sweep = await h.core.sweep();
  assert.equal(sweep.failed, 1, "the sweeper gave up on the hung one");
  assert.deepEqual((await h.store.get(fine.id)).noan_queue, [], "and still finished the next booking");
  hang = false;
  await h.core.sweep();
  assert.deepEqual((await h.store.get(stuck.id)).noan_queue, [], "once NOAN answers, the retry completes it");
  const hung = createFakeCalendar();
  hung.createEvent = () => new Promise(() => {});
  const h2 = harness({ calendar: hung, deadlines: { noanItemMs: 50, calendarMs: 50 } });
  const r2 = await h2.book(demo());
  assert.equal(r2.status, 201, "a hung Google call still answers the guest");
  assert.equal(h2.alerts.missed.length, 1, "with our own confirmation");
  ok("a call that never answers becomes a recorded failure: the lock frees, the sweeper moves on, the retry completes it");
}

/* ================= "brief me before the call" ================= */
{
  const h = harness({ briefEnabled: true });
  assert.deepEqual((await h.core.type("neal", "demo")).brief, { variant: "customer", minLeadMin: 60 });
  assert.equal((await h.core.type("neal", "intro")).brief, null, "a type without `verity brief:` shows no switch");
  const r = await h.book(demo({ brief: true }));
  assert.equal(r.status, 201); assert.equal(r.data.brief, "requested");
  const [row] = await h.store.listConfirmedBetween(HOST, TUE_0900, TUE_1400);
  assert.deepEqual((await h.store.get(row.id)).noan_queue, [{ kind: "book" }, { kind: "brief", variant: "customer" }]);
  await h.core._syncNoan(row.id);
  const brief = [...h.noan.db.tasks.values()].find(t => t.externalId === `brief:${row.id}`);
  assert(brief, "a brief task was filed");
  assert.match(brief.title, /^Pre-call brief: Cooper Walters · Tue 22 Sep 09:00$/);
  assert.deepEqual(brief.tags.map(t => t.name), ["Pre-call Brief"]);
  assert.deepEqual(brief.assignees.map(a => a.id), [VERITY, HOST_ID], "the agent works it, the host sees it");
  assert.match(brief.details, /Variant: customer/); assert.match(brief.details, new RegExp(`Booking ID: ${row.id}`));
  assert.match(brief.details, /Guest answers \(written by the guest, unverified\):/);
  assert(brief.details.indexOf("Source: brief:") < brief.details.indexOf("Guest answers ("),
    "the reference lines sit above the guest's answers, so a long answer can't cut them or pass for one");
  assert.equal(brief.contacts.length, 1);
  assert.deepEqual(h.dispatched, [{ event_type: "pre-call-brief", client_payload: { taskId: brief.id, bookingId: row.id } }]);
  const bookingTask = [...h.noan.db.tasks.values()].find(t => t.externalId === `booking:${row.id}`);
  assert(bookingTask, "the booking task is still filed first");
  ok("a ticked switch queues a brief: task tagged Pre-call Brief for the agent + host, contact linked, dispatched to run now");

  // the tick is ignored where it can't be honoured
  const soon = await h.book(demo({ brief: true, email: "soon@example.com", startISO: "2026-09-14T21:00:00.000Z" }));
  assert.equal(soon.status, 409, "sanity: 22:00 is outside hours");
  clock = Date.parse("2026-09-22T09:20:00Z");     // 40 minutes before an 11:00 Lisbon slot
  const tight = await h.book({ handle: "neal", slug: "chat", startISO: "2026-09-22T10:00:00.000Z", name: "Tia", email: "tight@example.com", answers: {}, brief: true });
  clock = Date.parse("2026-09-14T08:00:00Z");
  assert.equal(tight.status, 201, JSON.stringify(tight.data));
  assert.equal(tight.data.brief, "skipped", "under an hour to the call: booked, no brief");
  const noBriefType = await h.book({ handle: "neal", slug: "quick", startISO: TUE_1400, name: "Bo", email: "bo@example.com", answers: {}, brief: true });
  assert.equal(noBriefType.data.brief, "skipped");
  const off = harness({ briefEnabled: false });
  assert.equal((await off.core.type("neal", "demo")).brief, null, "lane off: no switch on the page");
  const offBook = await off.book(demo({ brief: true }));
  assert.equal(offBook.data.brief, "skipped");
  const [offRow] = await off.store.listConfirmedBetween(HOST, TUE_0900, TUE_1400);
  assert.deepEqual((await off.store.get(offRow.id)).noan_queue, [{ kind: "book" }]);
  ok("no brief when the call is under an hour away, the type doesn't offer one, or the lane is off");

  // no dispatch token: the brief waits for the hourly backstop, so the page asks for three hours
  const slow = harness({ briefEnabled: true, briefMinLeadMin: 180 });
  assert.deepEqual((await slow.core.type("neal", "demo")).brief, { variant: "customer", minLeadMin: 180 });
  clock = Date.parse("2026-09-22T08:00:00Z");     // two hours before an 11:00 Lisbon slot
  const twoHours = await slow.book({ handle: "neal", slug: "chat", startISO: "2026-09-22T10:00:00.000Z", name: "Tia", email: "tia2@example.com", answers: {}, brief: true });
  clock = Date.parse("2026-09-14T08:00:00Z");
  assert.equal(twoHours.status, 201); assert.equal(twoHours.data.brief, "skipped", "two hours out, three required: booked, no brief");
  ok("a longer lead time is honoured on the page and at booking");

  // cancelled before the brief item ran: no brief task
  const h2 = harness({ briefEnabled: true, crmOverride: null });
  const b2 = await h2.book(demo({ brief: true }));
  const [row2] = await h2.store.listConfirmedBetween(HOST, TUE_0900, TUE_1400);
  await h2.store.update(row2.id, { status: "cancelled" });
  await h2.core._syncNoan(row2.id);
  assert.equal([...h2.noan.db.tasks.values()].filter(t => t.externalId === `brief:${row2.id}`).length, 0);
  assert.equal(b2.status, 201);
  ok("a booking cancelled before its brief item runs files no brief");
}

/* ========= a host's zone: their own hours, travelling with their calendar ========= */
{
  // Google says Berlin; the config fact says Lisbon. The type has no `timezone:` line,
  // so the host's calendar wins and their hours are read in Berlin.
  const berlin = harness({ calendar: createFakeCalendar({ zones: { [HOST]: "Europe/Berlin" } }) });
  assert.equal((await berlin.core.type("neal", "demo")).timeZone, "Europe/Berlin");
  assert.equal((await berlin.core.month("neal", "demo", "2026-09")).timeZone, "Europe/Berlin");
  const lisbonDay = await harness().core.slots("neal", "demo", "2026-09-22");
  const berlinDay = await berlin.core.slots("neal", "demo", "2026-09-22");
  assert(lisbonDay.slots.length && berlinDay.slots.length);
  assert.equal(Date.parse(berlinDay.slots[0].startISO) - Date.parse(lisbonDay.slots[0].startISO), -3600e3,
    "the same working day starts an hour earlier in UTC when the host is an hour ahead");
  ok("with no `timezone:` line, the host's Google Calendar zone reads their hours");

  const pinned = parseBookingTypes(`
## Demo
link: neal/demo
host: host@example.com
length minutes: 30
timezone: America/New_York
`, { triggerTags: DEFAULT_TRIGGER_TAGS });
  assert.deepEqual(pinned.errors, []);
  assert.equal(pinned.types[0].timeZone, "America/New_York");
  const bad = parseBookingTypes(`
## Demo
link: neal/demo
host: host@example.com
timezone: Mars/Olympus
`, { triggerTags: DEFAULT_TRIGGER_TAGS });
  assert.match(bad.errors.join(" "), /timezone "Mars\/Olympus" is not an IANA zone/);
  ok("a `timezone:` line pins the zone, and a zone that isn't real is an error, not a guess");

  // a calendar that cannot answer (no scope, an outage) leaves the configured zone
  const mute = harness({ calendar: { ...createFakeCalendar(), userTimeZone: async () => { throw new Error("403"); } } });
  assert.equal((await mute.core.type("neal", "demo")).timeZone, avail.timeZone);
  const old = harness({ calendar: { ...createFakeCalendar(), userTimeZone: undefined } });
  assert.equal((await old.core.type("neal", "demo")).timeZone, avail.timeZone);
  ok("a calendar that can't say, or doesn't offer to, falls back to the configured zone");

  // read once per host, then held: a page view must not cost a calendar call each time
  let asked = 0;
  const counted = harness({ calendar: { ...createFakeCalendar(), userTimeZone: async () => { asked++; return "Europe/Berlin"; } } });
  await counted.core.type("neal", "demo"); await counted.core.type("neal", "chat"); await counted.core.host("neal");
  assert.equal(asked, 1, "one read per host, cached");
  ok("the host's zone is read once and cached");
}

{
  // days off: the config fact's list is the config owner's, so a type may carry its own
  const own = parseBookingTypes(`
## Demo
link: neal/demo
host: host@example.com
length minutes: 30
blocked dates: 2026-09-22, 2026-09-23
`, { triggerTags: DEFAULT_TRIGGER_TAGS });
  assert.deepEqual(own.errors, []);
  assert.deepEqual([...own.types[0].blockedDates], ["2026-09-22", "2026-09-23"]);
  const cleared = parseBookingTypes(`
## Demo
link: neal/demo
host: host@example.com
length minutes: 30
blocked dates: none
`, { triggerTags: DEFAULT_TRIGGER_TAGS });
  assert.equal(cleared.types[0].blockedDates.size, 0);
  const wrong = parseBookingTypes(`
## Demo
link: neal/demo
host: host@example.com
length minutes: 30
blocked dates: christmas
`, { triggerTags: DEFAULT_TRIGGER_TAGS });
  assert.match(wrong.errors.join(" "), /blocked dates: "christmas" is not YYYY-MM-DD/);

  const h = harness();
  const closed = createBookingCore({
    store: h.store, calendar: createFakeCalendar(), crm: { apply: async () => ({}) }, now, publicUrl: "https://meet.test", log: () => {},
    config: async () => ({ avail, types: own.types }),
  });
  assert.equal((await closed.slots("neal", "demo", "2026-09-22")).slots.length, 0, "their own day off closes the page");
  assert((await closed.slots("neal", "demo", "2026-09-24")).slots.length > 0, "the next day is open");
  ok("a type's own `blocked dates:` closes that host's days, not the config owner's");
}

console.log("\nbooking core: all passed");
