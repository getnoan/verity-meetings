@AGENTS.md

# verity-meetings

Open-source, self-hosted booking pages: a Node 22 service with no dependencies and no build step. It reads availability and meeting types from two NOAN facts, writes Google Calendar events, and files each booking in NOAN. Users deploy it to Render from `render.yaml` (the Dockerfile works on any other host).

| Path | Purpose |
| --- | --- |
| `booking/` | HTTP server, booking core, HTML pages, Supabase and in-memory stores, NOAN sync |
| `agents/` | Shared modules (NOAN client, Google Calendar, Resend, slots), seed scripts, tests |
| `schema.sql` | The `booking_bookings` table that self-hosters run once in Supabase |
| `scripts/check-provenance.mjs` | CI check that a PR only edits files the export keeps |

## Generated export

- **Only `README.md`, `LICENSE` and `SECURITY.md` belong to this repo.** Every other file, this one included, is copied from a private upstream repo, and the next export deletes any change to it. Make changes upstream.
- PRs from `export/*` branches carry the upstream copy and skip the provenance check.

## Security

- **Every route is public.** Keep the per-IP rate limits (`LIMITS` in `booking/server.mjs`), the 64 KB body limit, the honeypot field and the security headers.
- **Reschedule and cancel need the manage token.** The table stores only its SHA-256 hash (`manage_token_hash`). Never log the token or put it anywhere but the manage link.
- Guest input is untrusted: it lands in NOAN memos and tasks that agents read. Keep the escaping in `booking/pages.mjs` and the length limits in `booking/core.mjs`.
- Secrets come from env only: `NOAN_AGENT_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_SA_JSON`, `RESEND_API_KEY`. In `render.yaml` a secret is always `sync: false`, never a `value:`.
- The service uses the Supabase service_role key. `schema.sql` enables RLS and revokes the table from `anon` and `authenticated`. Keep both.

## What writes where

- Supabase `booking_bookings`: one row per booking. The `booking_no_overlap` exclusion constraint blocks double bookings.
- NOAN, through `booking/noan-sync.mjs` and `booking/alerts.mjs`: find or create the guest contact, add `booking:<id>:...` memos, create, update and close the meeting task.
- Google Calendar: events on the host's calendar through the service account.
- `agents/seed-*.mjs` create the two config facts in a "Booking Config" stack and never overwrite an existing fact.

## schema.sql

- **Self-hosters already ran this file.** Changes stay additive and idempotent: `create ... if not exists`, `add column if not exists`. Never rename or drop a column, and never change a type.
- A new column the service writes must be nullable, so a deploy works before the user runs the new SQL.
- INSTALL.md must tell users when to run `schema.sql` again.

## Public repo

- Anyone can read every file, commit, PR and CI log.
- No keys, tokens, customer data, real emails or hostnames, internal repo names or names of people. Use `example.com` addresses as in the tests and seeds.

## Tests and CI

- Tests are plain Node scripts, `agents/test-*.mjs`, with no network: fake calendar, fake NOAN, in-memory store.
- CI (`.github/workflows/ci.yml`) runs `node --check` on every `.mjs`, every test, then boots the dry-run server and checks `/healthz` and `/alex`. On PRs it also runs the provenance check.

## Commands

```bash
for t in agents/test-*.mjs; do node "$t" || break; done                    # all tests
for f in $(find booking agents scripts -name '*.mjs'); do node --check "$f"; done   # syntax check
# local run with no keys: in-memory store, fake calendar, seed facts
BOOKING_ENABLED=1 BOOKING_STORE=memory BOOKING_DRY_RUN=1 \
BOOKING_HOSTS=founder@example.com,teammate@example.com \
BOOKING_PUBLIC_URL=http://127.0.0.1:8671 PORT=8671 node booking/server.mjs
```
