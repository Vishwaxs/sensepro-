-- SensePro+ Migration 0023: Allow Clerk user IDs in students.auth_uid
-- Drops foreign key referencing auth.users(id), temporarily drops policies
-- that reference auth_uid with their exact names, converts auth_uid to text,
-- and recreates policies so both Clerk user_... IDs and Supabase UUIDs work cleanly.

-- 1. Temporarily drop dependent RLS policies (using exact names from migrations 0002, 0010, 0011, 0013)
drop policy if exists "students self read" on public.students;
drop policy if exists "consent self read" on public.consent_records;
drop policy if exists "presence self read" on public.presence_intervals;
drop policy if exists "verification_windows self read" on public.verification_windows;
drop policy if exists "sessions student read own section" on public.class_sessions;
drop policy if exists "deletion requests self read" on public.deletion_requests;

-- 2. Drop foreign key constraint referencing auth.users(id)
alter table if exists public.students
  drop constraint if exists students_auth_uid_fkey;

-- 3. Alter column to text
alter table if exists public.students
  alter column auth_uid type text using auth_uid::text;

-- 4. Recreate RLS policies supporting both UUIDs and Clerk string subjects
create policy "students self read" on public.students
  for select using (
    auth_uid = auth.uid()::text or auth_uid = (auth.jwt() ->> 'sub')
  );

create policy "consent self read" on public.consent_records
  for select using (
    exists (
      select 1 from public.students s
      where s.id = consent_records.student_id
        and (s.auth_uid = auth.uid()::text or s.auth_uid = (auth.jwt() ->> 'sub'))
    )
  );

create policy "presence self read" on public.presence_intervals
  for select using (
    exists (
      select 1 from public.students s
      where s.id = presence_intervals.student_id
        and (s.auth_uid = auth.uid()::text or s.auth_uid = (auth.jwt() ->> 'sub'))
    )
  );

create policy "verification_windows self read" on public.verification_windows
  for select using (
    exists (
      select 1 from public.students s
      where s.id = verification_windows.student_id
        and (s.auth_uid = auth.uid()::text or s.auth_uid = (auth.jwt() ->> 'sub'))
    )
  );

create policy "sessions student read own section" on public.class_sessions
  for select using (
    (auth.jwt() ->> 'app_role') = 'student'
    and class_section in (
      select s.class_section from public.students s
      where s.auth_uid = auth.uid()::text or s.auth_uid = (auth.jwt() ->> 'sub')
    )
  );

create policy "deletion requests self read" on public.deletion_requests
  for select using (
    exists (
      select 1 from public.students s
      where s.id = deletion_requests.student_id
        and (s.auth_uid = auth.uid()::text or s.auth_uid = (auth.jwt() ->> 'sub'))
    )
  );
