/**
 * booking/store-supabase.mjs error mapping, against the response shapes the
 * live fleet PostgREST returned on 2026-09-15 when the booking_bookings table
 * was first exercised: an overlap (exclusion constraint, 23P01) comes back as a
 * 400, a reused token (unique, 23505) as a 409. Both must be StoreConflict, so
 * a guest racing another for one slot hears "that time was just taken", not a
 * 503. Anything else still throws a plain error. No network.
 */
import assert from "node:assert";
import { createSupabaseStore } from "../booking/store-supabase.mjs";
import { StoreConflict } from "../booking/store-errors.mjs";

const ok = (name) => console.log("  ok  ", name);
const reply = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const store = f => createSupabaseStore({ url: "https://x.supabase.co", key: "k", fetchImpl: f });
const row = { type_slug: "t", host_email: "h@example.com", start_at: "2030-01-07T10:00:00Z", end_at: "2030-01-07T10:30:00Z" };

await assert.rejects(store(reply(400, { code: "23P01", message: "conflicting key value violates exclusion constraint \"booking_no_overlap\"" })).insert(row), StoreConflict);
ok("an overlap (23P01, returned as 400) is a StoreConflict");
await assert.rejects(store(reply(409, { code: "23505", message: "duplicate key value violates unique constraint" })).insert(row), StoreConflict);
ok("a reused token (23505, returned as 409) is a StoreConflict");
await assert.rejects(store(reply(400, { code: "23P01" })).update("id", { start_at: row.start_at }), StoreConflict);
ok("an overlapping reschedule (update) is a StoreConflict too");
for (const [status, body] of [[400, { code: "22P02", message: "invalid input syntax" }], [500, { message: "boom" }], [409, { code: "40001" }]]) {
  await assert.rejects(store(reply(status, body)).insert(row), e => !(e instanceof StoreConflict) && /supabase POST booking_bookings/.test(e.message));
}
ok("any other failure stays a plain error (the request answers 503; nothing is booked)");
const rows = [{ id: "1" }];
assert.deepEqual(await store(reply(200, rows)).get("1"), { id: "1" });
ok("a normal read still returns the row");
console.log("\nbooking supabase store: all passed");
