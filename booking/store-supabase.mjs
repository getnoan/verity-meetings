/**
 * Supabase store for the booking service. Same interface as store-memory.mjs,
 * over PostgREST with the service-role key. The table's DDL is migration
 * 005-booking in the fleet's schema module; an export ships it as schema.sql.
 *
 * Throws on failure, like the exchange's store: a booking that could not be
 * stored must fail the request, not vanish. Postgres refusing a write because
 * it would overlap a confirmed booking (23P01) or reuse a token (23505)
 * surfaces as StoreConflict, which the core turns into "that time was just
 * taken". PostgREST reports an exclusion violation as a 400 and a unique
 * violation as a 409 (seen live on 2026-09-15), so the code decides, not the status.
 */
import { StoreConflict } from "./store-errors.mjs";

const TIMEOUT_MS = 10_000;
const TABLE = "booking_bookings";

export function createSupabaseStore({ url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl = fetch } = {}) {
  const base = String(url || "").replace(/\/$/, "");
  if (!base || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the Supabase store.");

  async function call(method, path, { body, prefer } = {}) {
    const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    if (prefer) headers.Prefer = prefer;
    const res = await fetchImpl(`${base}/rest/v1/${path}`, {
      method, headers, body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (/"code"\s*:\s*"(23P01|23505)"/.test(text)) throw new StoreConflict(text.slice(0, 200));
      throw new Error(`supabase ${method} ${path.split("?")[0]} → ${res.status}: ${text.slice(0, 200)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const q = obj => new URLSearchParams(obj).toString();
  const one = rows => (Array.isArray(rows) && rows.length ? rows[0] : null);

  return {
    kind: "supabase",

    /** One cheap read, at boot: a missing table (schema never applied) or a wrong key fails
     *  HERE, in the deploy log, instead of on the first guest's booking. */
    probe: () => call("GET", `${TABLE}?${q({ select: "id", limit: "1" })}`),

    insert: row => call("POST", TABLE, { body: [row], prefer: "return=representation" }).then(one),
    get: id => call("GET", `${TABLE}?${q({ id: `eq.${id}` })}`).then(one),
    getByTokenHash: hash => call("GET", `${TABLE}?${q({ manage_token_hash: `eq.${hash}` })}`).then(one),

    update: (id, patch, { expectStatus } = {}) => call("PATCH",
      `${TABLE}?${q({ id: `eq.${id}`, ...(expectStatus ? { status: `eq.${expectStatus}` } : {}) })}`,
      { body: { ...patch, updated_at: new Date().toISOString() }, prefer: "return=representation" }).then(one),

    listConfirmedBetween: (host, fromISO, toISO) => call("GET", `${TABLE}?${q({
      host_email: `eq.${host}`, status: "eq.confirmed", start_at: `lt.${toISO}`, end_at: `gt.${fromISO}`,
      select: "id,start_at,end_at", order: "start_at.asc",
    })}`),

    async countFutureConfirmed(host, guestEmail, nowISO) {
      const rows = await call("GET", `${TABLE}?${q({
        host_email: `eq.${host}`, guest_email: `eq.${guestEmail}`, status: "eq.confirmed",
        start_at: `gt.${nowISO}`, select: "id", limit: "20",
      })}`);
      return Array.isArray(rows) ? rows.length : 0;
    },

    listPending: (limit = 25) => call("GET", `${TABLE}?${q({
      or: "(calendar_synced_at.is.null,noan_queue.neq.[])", order: "created_at.asc", limit: String(limit),
    })}`),
  };
}
