-- Rotating-QR absentee fallback (Section18 / Phase-5 design, ch8 Section8.2).
--
-- The QR NEVER marks attendance. It grants a short, single-use permission to
-- verify BY FACE in the room: a claimed token opens a brief verification window
-- for one student; the normal capture pipeline, on recognising that student's
-- enrolled face while the window is open, writes the presence row (tagged
-- via='qr') and satisfies the window. A printed photo can't scan a QR; a shared
-- screenshot can't produce the student's face. Presence still requires the
-- enrolled face in front of the classroom camera.
--
-- All writes here are service-role (the FastAPI backend). Students only ever
-- READ their own verification window (to see success/expiry live).

-- Mark how a presence row was produced, so QR-assisted attendance is auditable.
alter table presence_intervals
  add column via text not null default 'camera' check (via in ('camera', 'qr'));

-- Single-use, short-lived, rotating tokens bound to one session.
create table qr_tokens (
  token uuid primary key default gen_random_uuid(),
  session_id uuid not null references class_sessions(id) on delete cascade,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,                                  -- set atomically on claim
  used_by uuid references students(id) on delete set null
);
create index qr_tokens_live_idx on qr_tokens(session_id) where used_at is null;

-- A claimed token opens one of these: the student now has N seconds to be seen
-- by the camera. satisfied_at is set when their face is matched in-room.
create table verification_windows (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references class_sessions(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  opened_at timestamptz not null default now(),
  expires_at timestamptz not null,
  satisfied_at timestamptz
);
create index verification_windows_open_idx
  on verification_windows(session_id) where satisfied_at is null;

alter table qr_tokens enable row level security;
alter table verification_windows enable row level security;

-- qr_tokens: service-role only. No policy = no authenticated access; the token
-- travels in the QR payload, never read back from the table by a client.

-- verification_windows: a student may read only their OWN window, so their app
-- can show "verifying… / verified / expired" live. No client writes.
grant select on verification_windows to authenticated;
create policy "verification_windows self read" on verification_windows
  for select using (
    exists (
      select 1 from students s
      where s.id = verification_windows.student_id and s.auth_uid = auth.uid()
    )
  );

-- Live student feedback without polling.
alter publication supabase_realtime add table verification_windows;
