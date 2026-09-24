/**
 * In-memory store for the booking service: the tests and local smoke runs.
 * Same interface as store-supabase.mjs, and it enforces the same no-overlap
 * rule the Postgres exclusion constraint does (two confirmed bookings for one
 * host never overlap), so the tests exercise the real guarantee.
 */
import { randomUUID } from "node:crypto";
import { StoreConflict } from "./store-errors.mjs";

export function createMemoryStore({ now = () => new Date() } = {}) {
  const rows = new Map();
  const copy = r => (r ? structuredClone(r) : null);
  const overlaps = (a, b) => a.host_email === b.host_email &&
    Date.parse(a.start_at) < Date.parse(b.end_at) && Date.parse(b.start_at) < Date.parse(a.end_at);

  function assertNoOverlap(next) {
    if (next.status !== "confirmed") return;
    for (const r of rows.values()) {
      if (r.id !== next.id && r.status === "confirmed" && overlaps(r, next)) {
        throw new StoreConflict("overlaps a confirmed booking");
      }
    }
  }

  return {
    kind: "memory",

    async insert(row) {
      const at = now().toISOString();
      const full = {
        id: randomUUID(), answers: [], status: "confirmed", source: "page",
        google_event_id: null, meeting_url: null, noan_contact_id: null, noan_task_id: null,
        calendar_synced_at: null, noan_queue: [], noan_synced_at: null, last_error: null,
        attempts: 0, created_at: at, updated_at: at, ...row,
      };
      for (const r of rows.values()) {
        if (r.manage_token_hash === full.manage_token_hash) throw new StoreConflict("duplicate token");
      }
      assertNoOverlap(full);
      rows.set(full.id, full);
      return copy(full);
    },

    async get(id) { return copy(rows.get(id)); },

    async getByTokenHash(hash) {
      for (const r of rows.values()) if (r.manage_token_hash === hash) return copy(r);
      return null;
    },

    /** Patch one row. With expectStatus, only a row still in that status moves (compare-and-set). */
    async update(id, patch, { expectStatus } = {}) {
      const cur = rows.get(id);
      if (!cur || (expectStatus && cur.status !== expectStatus)) return null;
      const next = { ...cur, ...structuredClone(patch), updated_at: now().toISOString() };
      assertNoOverlap(next);
      rows.set(id, next);
      return copy(next);
    },

    /** Confirmed bookings for a host that overlap [fromISO, toISO). */
    async listConfirmedBetween(host, fromISO, toISO) {
      const win = { host_email: host, start_at: fromISO, end_at: toISO };
      return [...rows.values()].filter(r => r.status === "confirmed" && overlaps(r, win)).map(copy);
    },

    async countFutureConfirmed(host, guestEmail, nowISO) {
      return [...rows.values()].filter(r => r.status === "confirmed" && r.host_email === host &&
        r.guest_email === guestEmail && r.start_at > nowISO).length;
    },

    /** Rows with calendar or NOAN work still owed, oldest first. */
    async listPending(limit = 25) {
      return [...rows.values()]
        .filter(r => !r.calendar_synced_at || (r.noan_queue || []).length)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
        .slice(0, limit).map(copy);
    },
  };
}
