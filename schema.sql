-- The booking store: run once in the Supabase SQL editor (or psql) before the first deploy.
-- Idempotent: safe to run again. The exclusion constraint IS the double-booking guarantee.
create extension if not exists btree_gist;
create table if not exists public.booking_bookings (
  id                  uuid primary key default gen_random_uuid(),
  type_slug           text not null,
  host_email          text not null,
  guest_name          text not null,
  guest_email         text not null,
  answers             jsonb not null default '[]'::jsonb,
  start_at            timestamptz not null,
  end_at              timestamptz not null,
  status              text not null default 'confirmed' check (status in ('confirmed','cancelled')),
  manage_token_hash   text not null unique,
  source              text not null default 'page',
  google_event_id     text,
  meeting_url         text,
  noan_contact_id     text,
  noan_task_id        text,
  calendar_synced_at  timestamptz,
  noan_queue          jsonb not null default '[]'::jsonb,
  noan_synced_at      timestamptz,
  last_error          text,
  attempts            int not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (end_at > start_at),
  constraint booking_no_overlap exclude using gist
    (host_email with =, tstzrange(start_at, end_at) with &&) where (status = 'confirmed')
);
create index if not exists booking_bookings_host_start_idx on public.booking_bookings (host_email, start_at);
create index if not exists booking_bookings_pending_idx on public.booking_bookings (created_at)
  where calendar_synced_at is null or noan_queue <> '[]'::jsonb;
alter table public.booking_bookings enable row level security;
revoke all on public.booking_bookings from anon, authenticated;
grant all on public.booking_bookings to service_role;
