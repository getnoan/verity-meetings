# Install — written for your coding agent

Hand this file to Claude Code (or any coding agent) in a clone of this repo and say
"install this for me". Steps marked **HUMAN** need the person; everything else the
agent runs and verifies itself. Do the steps in order — step 0 needs no accounts at all.

## 0. Prove it locally (no keys, ~1 minute)

```bash
BOOKING_ENABLED=1 BOOKING_STORE=memory BOOKING_DRY_RUN=1 \
BOOKING_HOSTS=founder@example.com,teammate@example.com \
BOOKING_PUBLIC_URL=http://127.0.0.1:8671 PORT=8671 node booking/server.mjs
```

VERIFY: `curl -s http://127.0.0.1:8671/healthz` prints `ok`, and http://127.0.0.1:8671/alex
shows the booking pages with three sample meeting types. Bookings are in-memory and the
calendar is fake — this is the whole flow with zero accounts. Everything after this step
is just swapping the fakes for real services.

## 1. HUMAN — a NOAN workspace and key

The service's brain is two facts in your NOAN workspace (https://app.getnoan.com):
your availability (Scheduling Config) and your meeting types (Booking Types). Create a
workspace if you don't have one, then create an API key (Settings → API keys). Give the
key to your agent as `NOAN_AGENT_API_KEY` in the deploy env — never commit it.

Then let the agent seed the two facts and capture their block slugs:

```bash
NOAN_AGENT_API_KEY=... node agents/seed-scheduling.mjs
NOAN_AGENT_API_KEY=... node agents/seed-booking.mjs
```

VERIFY: both print a `..._BLOCK_SLUG=` line — those are `SCHEDULE_CONFIG_BLOCK_SLUG` and
`BOOKING_TYPES_BLOCK_SLUG`. They land in a custom "Booking Config" stack (created if you have
none; kept apart from any other agent's instructions, because these pages take public input). Re-running a seed never overwrites an existing fact.

Then edit the Booking Types fact in the NOAN app: the starters use placeholder hosts
(founder@example.com, teammate@example.com). Put your real hosts' emails in, and list the same
addresses in `BOOKING_HOSTS` (comma-separated) — a type whose host is not listed is not served.
The service re-reads both facts every 5 minutes.

## 2. HUMAN — Google calendar credentials (the one genuinely fiddly step)

The service writes events through a Google service account. In Google Cloud Console:
create a project → enable the Calendar API → create a Service Account → download its
JSON key. For Google Workspace, grant the SA domain-wide delegation with scopes
`calendar.events` and `calendar.freebusy` (Admin console → Security → API controls →
Domain-wide delegation), so it can act as each meeting host.

Give the JSON to the deploy env as `GOOGLE_SA_JSON` (the whole file, one env var).

VERIFY (agent): deploy first (step 4), book a test slot, see the event on the host's
calendar. Until then you can deploy in dry-run to check everything else.

## 3. Supabase (the booking store)

**HUMAN:** create a project at https://supabase.com (free tier is fine). Then run
`schema.sql` (in this repo) once — Supabase dashboard → SQL Editor → paste → Run, or
`psql "$DATABASE_URL" -f schema.sql`. It creates the `booking_bookings` table; it is
idempotent, so running it twice is harmless. The service does NOT create it for you.

The agent sets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API;
the service_role key, never the anon key) in the deploy env.

VERIFY: on boot the service reads the table once; if it is missing the deploy log says
"the booking store is unreadable — is the booking_bookings table created (schema.sql)?"
and the service exits instead of failing on your first guest.

## 4. Deploy (Render blueprint — the blessed path)

Fork or push this repo to your GitHub, then: Render → New → Blueprint → pick the repo.
Render reads render.yaml; fill the `sync: false` env vars when prompted. Set
`BOOKING_PUBLIC_URL` to the domain you'll use (e.g. https://meeting.yourcompany.com).

VERIFY: `curl -s https://<render-url>/healthz` prints `ok` and the service log says
how many meeting types it loaded.

Any Docker host works instead — the Dockerfile is the escape hatch — but Render is the
path this INSTALL verifies.

## 5. HUMAN — DNS

CNAME `meeting.yourcompany.com` to the Render hostname, add the custom domain in
Render's dashboard.

VERIFY (agent): `curl -s https://meeting.yourcompany.com/healthz` prints `ok`. Open
the page; the meeting types are yours (from the fact, not the samples).

## 6. Optional

- `COMPANY_NAME`: your company, for link previews ("Book a meeting with …").
- `AGENT_NAME`: what your agent signs as (default "Agent").
- `BOOKING_FONT_ORIGIN`: a site whose /assets/fonts/ the pages may borrow; unset, they use
  the system font stack.
- Share cards and icons: put a 1200x630 `default.jpg` in `booking/og/` and
  `favicon-32.png`, `favicon-192.png`, `apple-touch-icon.png` in `booking/icons/`; the
  pages link whichever exist. (Your fork keeps them; they are not part of the export.)
- `RESEND_API_KEY` + `MAIL_FROM`: confirmation emails when a booker's invite might
  not reach them.
- The service is rate-limited by default (bookings 10/hour/IP, manage 30/hour, reads
  300/10min). Keep it that way; it is public.

## What you got

Calendly on your own domain, with availability and meeting types living in your fact
layer instead of a SaaS dashboard, reschedule/cancel links in every confirmation, and
bookings landing as tasks in your workspace.

Exported from getnoan/agents @ a70dfb6.
