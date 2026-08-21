-- Right-to-erasure request queue.
--
-- Before this migration, apps/web/src/routes/_shell.me.tsx's "Delete my data"
-- flow was a client-side-only stub (setDeleted(true), nothing persisted) and
-- _shell.admin.tsx's "Deletion queue" tab was an honest "not available yet"
-- placeholder — there was no table to back either side. This migration adds
-- the queue both were already designed around: a student submits a request
-- (status='pending'); an admin approves (purges the biometric template +
-- withdraws consent, backend/app/students_api.py) or denies it. Nothing is
-- purged automatically on request — only on admin approval, matching the
-- existing "admin will action within 24h" / "two-step confirm" UI copy.
create table deletion_requests (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  requested_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  resolved_at timestamptz,
  resolved_by uuid
);
create index deletion_requests_student_idx on deletion_requests(student_id);
-- One outstanding pending request per student — a resubmit while pending
-- returns the existing row instead of piling up duplicates (enforced in
-- backend/app/store.py, this index makes the invariant queryable/cheap).
create index deletion_requests_pending_idx on deletion_requests(student_id) where status = 'pending';

alter table deletion_requests enable row level security;

-- RLS and GRANTs are additive layers (0004/0005): without this, PostgREST
-- rejects the read with "permission denied for table" before RLS is even
-- evaluated, regardless of how correct the policies below are.
grant select on deletion_requests to authenticated;

create policy "deletion requests admin read" on deletion_requests
  for select using ((auth.jwt() ->> 'app_role') = 'admin');

create policy "deletion requests self read" on deletion_requests
  for select using (
    exists (
      select 1 from students s
      where s.id = deletion_requests.student_id and s.auth_uid = auth.uid()
    )
  );

-- No client insert/update/delete policy: a student submits via
-- POST /v1/students/me/deletion-request and an admin resolves via
-- POST /v1/admin/deletion-requests/{id}/resolve — both service-role writes,
-- same convention as presence overrides (migration 0012) and QR claims
-- (migration 0010). A raw client insert/update here would let a student
-- forge another student's request or an admin edit the queue without the
-- purge side effects actually running.
