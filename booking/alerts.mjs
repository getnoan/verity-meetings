/**
 * When a booking can't finish on its own.
 *
 *   onStuck            five failed attempts (calendar or NOAN): one task, parked
 *                      for the host. The sweeper keeps retrying every 6 hours, so
 *                      fixing the cause (a missing tag, calendar access) heals it.
 *   onCalendarMissed   Google failed during the booking request itself: the guest
 *                      gets our own confirmation with an .ics and the manage link
 *                      now, because that link exists only in the request.
 */
import { respondLine } from "../agents/respond-by.mjs";
import { agentName } from "../agents/required-env.mjs";

export function createAlerts({ noan, dryRun = false, env = process.env, log = console.log, send = null }) {
  const tz = env.BOOKING_TIMEZONE || "Europe/Lisbon";
  const when = (iso) => new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz, timeZoneName: "short",
  }).format(new Date(iso));

  async function onStuck(row, message) {
    if (dryRun) { log(`booking DRY_RUN: would park booking ${row.id}: ${message}`); return; }
    const created = await noan.noanPost("/tasks", {
      title: noan.sanitizeCopy(`NOAN Meetings: ${row.guest_name}'s booking hasn't fully synced`).slice(0, 200),
      details: noan.sanitizeCopy([
        `A booking for ${row.guest_name} (${row.guest_email}) on ${when(row.start_at)} failed five times.`,
        `Still owed: ${[!row.calendar_synced_at && "the Google Calendar event", (row.noan_queue || []).length && `NOAN writes (${row.noan_queue.map(i => i.kind).join(", ")})`].filter(Boolean).join(" and ")}.`,
        `Last error: ${String(message).slice(0, 600)}`,
        "",
        "Fix the cause and it retries by itself every 6 hours; you don't need to touch the booking.",
        respondLine("human"),
        "",
        `Source: booking-stuck:${row.id}`,
      ].join("\n")).slice(0, 2000),
      status: "backlog",
      externalId: `booking-stuck:${row.id}`,
    });
    const id = created?.task?.id || created?.id;
    if (!id) throw new Error("stuck task create returned no id");
    await noan.parkForHuman({ id, tags: [], assignees: [] }, {
      lane: "sales", agent: "booking", requesterEmail: row.host_email, unassign: true,
      reason: `booking ${row.id} failed five times: ${String(message).slice(0, 200)}`,
    });
  }

  async function onCalendarMissed({ row, type, manageUrl }) {
    const name = type?.name || "Meeting";
    const subject = `Booked: ${name} on ${when(row.start_at)}`;
    const text = [
      `Hi ${row.guest_name},`,
      "",
      `You're booked for ${name}${type?.hostName ? ` with ${type.hostName}` : ""} on ${when(row.start_at)}.`,
      "The video link will follow in a calendar invite. The attached file adds it to your calendar now.",
      "",
      `Reschedule or cancel: ${manageUrl}`,
    ].join("\n");
    if (dryRun) { log(`booking DRY_RUN: would email ${row.guest_email}: ${subject}`); return; }
    const sendEmail = send || (await import("../agents/resend.mjs")).sendEmail;
    await sendEmail({
      to: row.guest_email, subject, text,
      html: text.split("\n").map(l => (l ? `<p>${escapeHtml(l).replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>` : "")).join(""),
      idempotencyKey: `${agentName()}:booking-send:${row.id}:${row.start_at}`,
      cc: false,
      attachments: [{ filename: "invite.ics", content: Buffer.from(ics(row, name)).toString("base64") }],
    });
  }

  return { onStuck, onCalendarMissed };
}

const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** A minimal single-event calendar file (RFC 5545). */
export function ics(row, name) {
  const stamp = iso => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const text = s => String(s).replace(/[\\;,]/g, m => `\\${m}`).replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//NOAN//Meetings//EN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:booking-${row.id}@${process.env.BOOKING_ICS_UID_DOMAIN || "verity-meetings"}`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(row.start_at)}`,
    `DTEND:${stamp(row.end_at)}`,
    `SUMMARY:${text(name)}`,
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}
