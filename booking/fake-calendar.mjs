/** A calendar that books nothing: BOOKING_DRY_RUN local runs and the tests. Same shape as the google-cal.mjs adapter in server.mjs. */
export function createFakeCalendar({ zones = {} } = {}) {
  const events = new Map();
  let n = 0;
  return {
    events,
    zones,                                                   // host → the zone Google reports
    userTimeZone: async (host) => zones[host] ?? null,
    freeBusy: async () => [],
    createEvent: async (e) => { const id = `fake-${++n}`; const ev = { id, hangoutLink: `https://meet.google.com/fake-${n}`, ...e }; events.set(id, ev); return ev; },
    updateEvent: async (id, patch) => { events.set(id, { ...events.get(id), ...patch }); return events.get(id); },
    cancelEvent: async (id) => { events.delete(id); },
    findEventByBooking: async (bookingId) => [...events.values()].find(e => e.privateProps?.bookingId === bookingId) || null,
  };
}
