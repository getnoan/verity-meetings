/**
 * The NOAN half of a booking: the
 * contact, its memo and tags, and the task that hands the meeting to a person
 * or an agent. Driven by the queue on the booking row, one item at a time:
 *
 *   book        find-or-create the contact, fill EMPTY fields from answers,
 *               merge the type's contact tags, `booking:<id>:book` memo, the task
 *   reschedule  memo, then the task's due date and title move with a note
 *   cancel      memo, then the type's `on cancel:` route (close, keep, hand to a trigger tag)
 *   brief       the guest ticked "brief me before the call": a task for the Pre-call Brief
 *               agent, then a dispatch so it runs now, not at the next poll
 *
 * Every item is safe to run twice. Memos carry a title and are skipped when a
 * memo with that title is already on the contact; the task id is remembered on
 * the row, so a retry never files a second task.
 *
 * Guest answers are untrusted input to agents that read memos and task details
 * later. They go in under a fixed frame, and nothing here routes on them.
 */
import * as live from "../agents/noan.mjs";
import { QUESTION_KINDS } from "../agents/booking-types.mjs";
import { respondLine } from "../agents/respond-by.mjs";
import { agentIdentityId } from "../agents/required-env.mjs";

const UNTRUSTED = "Guest answers (written by the guest, unverified):";
const DETAILS_MAX = 2000;

export const BRIEF_TAG = "Pre-call Brief";

export function createNoanCrm({ api = live, verityId = agentIdentityId(), timeZone = "Europe/Lisbon", publicUrl = "", log = console.log, dispatch = async () => false } = {}) {
  const tz = () => timeZone;

  // Fixed English names: Intl's short month varies by ICU build ("Sep" vs "Sept"),
  // and these strings land in task titles people search and agents read.
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const parts = iso => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: tz(), weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
    return { dow: p.weekday, d: +p.day, mon: MONTHS[+p.month - 1], y: p.year, hm: `${p.hour}:${p.minute}` };
  };
  const when = (iso, withEnd = null) => {
    const p = parts(iso);
    const day = `${p.dow} ${p.d} ${p.mon} ${p.y}`;
    return withEnd ? `${day}, ${p.hm} to ${parts(withEnd).hm} (${tz()})` : `${day}, ${p.hm} (${tz()})`;
  };
  const short = iso => { const p = parts(iso); return `${p.dow} ${p.d} ${p.mon} ${p.hm}`; };

  const typeName = (type, row) => type?.name || row.type_slug;
  const pageUrl = (type) => (type && publicUrl ? `${publicUrl.replace(/\/$/, "")}/${type.handle}/${type.slug}` : "");

  function answerLines(row) {
    if (!(row.answers || []).length) return [];
    return [UNTRUSTED, ...row.answers.map(a => `- ${a.label}: ${a.value}`)];
  }

  async function contactDetail(id) {
    const res = await api.noanGet(`/contacts/${id}`);
    return res?.contact || res || {};
  }

  const hasMemo = (c, title) => [...(c.memos || []), ...(c.notes || [])]
    .some(m => (m?.title || "").trim().toLowerCase() === title.toLowerCase());

  async function memoOnce(contactId, c, title, lines) {
    if (hasMemo(c, title)) return false;
    await api.addContactMemo(contactId, api.sanitizeCopy(lines.join("\n")), title);
    return true;
  }

  function taskTitle(type, row) {
    return api.sanitizeCopy(`${typeName(type, row)}: ${row.guest_name} · ${short(row.start_at)}`).slice(0, 200);
  }

  function taskDetails(type, row, contactId) {
    const head = [
      `${typeName(type, row)} with ${row.guest_name} (${row.guest_email})`,
      `When: ${when(row.start_at, row.end_at)}`,
      row.meeting_url ? `Meet: ${row.meeting_url}` : null,
      `Booked through NOAN Meetings${pageUrl(type) ? ` (${pageUrl(type)})` : ""}.`,
    ].filter(Boolean);
    // The host owns the meeting; when an agent is routed in, it works the task itself.
    const hostOwned = (type?.onBook || { kind: "owner", who: "host" }).kind === "owner" && (type?.onBook?.who || "host") === "host";
    const tail = [...(hostOwned ? [respondLine("human")] : []), `Contact ID: ${contactId}`, `Source: booking:${row.id}`];
    let answers = answerLines(row);
    let text = [...head, "", ...answers, "", ...tail].join("\n");
    // The API rejects details over 2048: trim the guest's answers, never the routing lines.
    while (text.length > DETAILS_MAX && answers.length > 1) {
      answers = answers.slice(0, -1);
      text = [...head, "", ...answers, "- (more answers in the contact memo)", "", ...tail].join("\n");
    }
    return api.sanitizeCopy(text).slice(0, DETAILS_MAX);
  }

  async function createTask(type, row, contactId, remember) {
    const route = type?.onBook || { kind: "owner", who: "host" };
    // The row's noan_task_id is the primary guard and it is enough on the happy
    // path. It is NOT enough after a timeout: withDeadline in core.mjs is a
    // Promise.race, so an item that gave no answer in time leaves this create
    // still running, and the remember() below may never land. The queue then
    // retries against a row that still shows no task. That is how booking
    // 17ffd50e ended up with two open tasks for the same guest, 41 seconds
    // apart, on 2026-09-17.
    //
    // So on a retry ONLY - attempts > 0 - look the externalId up first. The
    // scan pages the whole board (NOAN has no externalId filter: the query is
    // silently ignored and the entire board comes back), which is why the happy
    // path does not pay for it. fresh: true because this runs in a long-lived
    // server.
    const externalId = `booking:${row.id}`;
    if ((row.attempts || 0) > 0) {
      const already = await api.findTaskByExternalIdFresh(externalId);
      if (already) {
        // Found the one an abandoned attempt created. Record the id that was
        // lost and stop: tags, contacts and assignees were all set on that pass,
        // and re-running them would PUT over whatever a human has changed since.
        await remember({ noan_task_id: already.id });
        log(`booking ${row.id}: task ${already.id} was already filed by an earlier attempt`);
        return;
      }
    }
    const created = await api.noanPost("/tasks", {
      title: taskTitle(type, row), details: taskDetails(type, row, contactId),
      status: "backlog", dueDate: row.start_at, externalId,
    });
    const taskId = created?.task?.id || created?.id;
    if (!taskId) throw new Error("task create returned no id");
    await remember({ noan_task_id: taskId });
    // Fresh task: the contact set is empty, so the PUT loses nothing.
    await api.noanPut(`/tasks/${taskId}/contacts`, { contactIds: [contactId] });
    const withVerity = route.kind === "tag" || (route.kind === "owner" && route.who === "verity");
    if (route.kind === "tag") await api.addTaskTags({ id: taskId, tags: [] }, route.tag);
    // The host is always on it; the agent too when it is meant to pick it up.
    await api.assignResolvedOwner(taskId, {
      requesterEmail: row.host_email, lane: "sales", agent: "booking",
      keep: withVerity && verityId ? [verityId] : [], log,
    });
    return taskId;
  }

  async function mergeContact(contactId, c, type, row) {
    const upd = {};
    for (const a of row.answers || []) {
      const field = QUESTION_KINDS[a.kind]?.field;
      if (field && !c[field] && !(field in upd)) upd[field] = a.value;   // fill, never overwrite
    }
    const want = type?.contactTags || [];
    if (want.length) {
      const have = (c.tags || []).map(t => t.id).filter(Boolean);
      const ids = [...have];
      for (const name of want) {
        const id = await api.findTagId(name).catch(() => null);
        if (!id) { log(`booking ${row.id}: contact tag "${name}" does not exist in NOAN; skipped (tags are created by a person)`); continue; }
        if (!ids.includes(id)) ids.push(id);
      }
      if (ids.length !== have.length) upd.tagIds = ids;   // PATCH replaces the set: send all of it
    }
    if (Object.keys(upd).length) await api.noanPatch(`/contacts/${contactId}`, upd);
  }

  async function book(row, type, remember) {
    let contactId = row.noan_contact_id;
    if (!contactId) {
      // allowIncompleteSweep, as site-web does for live visitors: a person just booked, and a
      // rare duplicate (merged by the weekly network-integrity run) beats a lost booking.
      const { contact } = await api.findOrCreateContactByEmail(row.guest_email, { name: row.guest_name, allowIncompleteSweep: true });
      contactId = contact.id;
      await remember({ noan_contact_id: contactId });
    }
    const c = await contactDetail(contactId);
    await mergeContact(contactId, c, type, row);
    await memoOnce(contactId, c, `booking:${row.id}:book`, [
      `[NOAN Meetings] Booked: ${typeName(type, row)}, ${when(row.start_at, row.end_at)}`,
      row.meeting_url ? `Meet: ${row.meeting_url}` : null,
      ...answerLines(row),
    ].filter(Boolean));
    if (!row.noan_task_id && (type?.onBook?.kind || "owner") !== "none") {
      await createTask(type, row, contactId, remember);
    }
    return {};
  }

  async function reschedule(row, type, item) {
    if (!row.noan_contact_id) return {};   // the book item hasn't landed; it will carry the new time
    const c = await contactDetail(row.noan_contact_id);
    await memoOnce(row.noan_contact_id, c, `booking:${row.id}:reschedule:${item.to}`, [
      `[NOAN Meetings] Rescheduled: ${typeName(type, row)}`,
      `From: ${when(item.from)}`, `To: ${when(item.to)}`,
    ]);
    if (row.noan_task_id) {
      await api.noanPatch(`/tasks/${row.noan_task_id}`, { dueDate: row.start_at, title: taskTitle(type, row) });
      await api.postTaskComment(row.noan_task_id, `The guest moved this meeting from ${when(item.from)} to ${when(item.to)}.`);
    }
    return {};
  }

  async function cancel(row, type, item) {
    if (!row.noan_contact_id) return {};
    const c = await contactDetail(row.noan_contact_id);
    await memoOnce(row.noan_contact_id, c, `booking:${row.id}:cancel`, [
      `[NOAN Meetings] Cancelled: ${typeName(type, row)}, was ${when(row.start_at)}`,
      item.reason ? `Reason given by the guest (unverified): ${item.reason}` : null,
    ].filter(Boolean));
    if (!row.noan_task_id) return {};
    const route = type?.onCancel || { kind: "close" };
    // The guest's own closing punctuation is dropped so the sentence ends once ("test.." read live).
    const reason = String(item.reason || "").replace(/[\s.!?]+$/, "");
    const note = `The guest cancelled this meeting${reason ? `. Their reason (unverified): ${reason}` : ""}.`;
    await api.postTaskComment(row.noan_task_id, note);
    if (route.kind === "close") {
      await api.noanPatch(`/tasks/${row.noan_task_id}`, { status: "done", completed: true });
    } else if (route.kind === "tag") {
      // Hand it on: the trigger tag plus the agent's identity, so it picks it up on its next poll.
      const task = await api.findTaskById(row.noan_task_id);
      if (task) {
        await api.addTaskTags(task, route.tag);
        await api.assignVerity(task);
      }
    }
    return {};
  }

  /** The brief task. The worker dedupes on externalId `brief:<id>`, so a retry that files a
   *  second one sends nothing twice; the dispatch is best effort (the worker's cron backstops it). */
  async function brief(row, type, item) {
    if (row.status !== "confirmed") return {};             // cancelled before we got here: no brief
    if (!row.noan_contact_id) throw new Error("brief queued before the contact exists");
    const website = (row.answers || []).find(a => a.kind === "website")?.value || "";
    // The reference lines come first and the guest's answers last: a long answer can
    // run past DETAILS_MAX and is cut, and brief-core's briefTaskRefs reads only above
    // the UNTRUSTED line, so nothing a guest types can pass for a reference.
    const details = [
      `${item.variant === "investor" ? "Investor" : "Customer"} pre-call brief for ${row.guest_name} (${row.guest_email}), who asked for one when booking.`,
      `Call: ${typeName(type, row)}, ${when(row.start_at, row.end_at)}`,
      `Variant: ${item.variant}`,
      `Booking ID: ${row.id}`,
      ...(row.noan_task_id ? [`Booking task: ${row.noan_task_id}`] : []),
      `Contact ID: ${row.noan_contact_id}`,
      `Source: brief:${row.id}`,
      `Website: ${website ? website.replace(/\s+/g, " ") : "none given (use the email domain)"}`,
      "",
      ...answerLines(row),
    ].join("\n");
    const created = await api.noanPost("/tasks", {
      title: api.sanitizeCopy(`Pre-call brief: ${row.guest_name} · ${short(row.start_at)}`).slice(0, 200),
      details: api.sanitizeCopy(details).slice(0, DETAILS_MAX),
      status: "backlog", dueDate: new Date().toISOString(), externalId: `brief:${row.id}`,
    });
    const taskId = created?.task?.id || created?.id;
    if (!taskId) throw new Error("brief task create returned no id");
    // Fresh task: every set is empty, so these writes lose nothing.
    await api.noanPut(`/tasks/${taskId}/contacts`, { contactIds: [row.noan_contact_id] });
    await api.addTaskTags({ id: taskId, tags: [] }, BRIEF_TAG);
    await api.assignResolvedOwner(taskId, { requesterEmail: row.host_email, lane: "sales", agent: "booking", keep: verityId ? [verityId] : [], log });
    const sent = await dispatch({ event_type: "pre-call-brief", client_payload: { taskId, bookingId: row.id } }).catch(e => { log(`booking ${row.id}: brief dispatch failed: ${e.message}`); return false; });
    if (!sent) log(`booking ${row.id}: brief task ${taskId} filed; no dispatch, the worker's cron will pick it up`);
    return {};
  }

  return {
    async apply(row, type, item, remember = async () => {}) {
      if (item.kind === "brief") return brief(row, type, item);
      if (item.kind === "book") return book(row, type, remember);
      if (item.kind === "reschedule") return reschedule(row, type, item);
      if (item.kind === "cancel") return cancel(row, type, item);
      log(`booking ${row.id}: unknown queue item ${JSON.stringify(item).slice(0, 80)} dropped`);
      return {};
    },
  };
}
