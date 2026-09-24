# Verity Meetings

Booking pages on your own domain — a zero-dependency Node service whose brain is your
[NOAN](https://www.getnoan.com) fact layer. It renders its own pages: one deploy, one
CNAME, no frontend build.

**Install:** hand INSTALL.md to your coding agent. Step 0 runs the whole thing locally
with no accounts in about a minute.

Availability and meeting types are facts you edit in your workspace; the service re-reads
them every 5 minutes. Bookings write calendar events and land as tasks. Reschedule and
cancel links ride every confirmation.

Exported one-way from the private fleet repo; see scripts/check-provenance.mjs.
