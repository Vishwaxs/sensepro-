-- Global feature toggles, admin-controlled.
--
-- First (only, for now) use: qr_checkin_enabled, read by
-- backend/app/qr_api.py's issue_token before minting a rotating absentee-QR
-- token, so an admin can kill the QR fallback campus-wide (e.g. mid-exam)
-- without touching config or redeploying.
create table app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into app_settings (key, value) values ('qr_checkin_enabled', 'true'::jsonb);

alter table app_settings enable row level security;

-- RLS and GRANTs are additive layers (0004/0005): without this, PostgREST
-- rejects the read with "permission denied for table" before RLS is even
-- evaluated. The app itself reads settings through the backend (service
-- role, bypasses RLS) — this grant covers direct client/Studio inspection,
-- same rationale as "embeddings admin read" in migration 0002.
grant select on app_settings to authenticated;

-- Readable by any staff role — a teacher opening the absentee panel benefits
-- from knowing it's disabled before they try (backend/app/qr_api.py enforces
-- this regardless; this policy only affects the direct client read used to
-- render the toggle/its current state).
create policy "settings staff read" on app_settings
  for select using ((auth.jwt() ->> 'app_role') in ('teacher', 'management', 'admin'));

-- No client write policy: only PATCH /v1/settings/{key} (admin-only, backend
-- service role) may change a setting — a raw client write would bypass the
-- audit_log entry the endpoint appends on every change.
