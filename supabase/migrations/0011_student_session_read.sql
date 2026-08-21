-- Student self-read on class_sessions.
--
-- Bug: "presence self read" (0002) lets a signed-in student read their own
-- presence_intervals rows, but class_sessions has no student-facing read
-- policy at all — only "sessions staff read" (teacher/management/admin).
-- apps/web/src/lib/data/my-attendance.ts queries presence_intervals with a
-- `class_sessions!inner(...)` join to show the subject/date of each session;
-- under RLS an inner join requires BOTH sides to be readable, so with no
-- policy on class_sessions the join silently drops every row and "My
-- Attendance" renders empty for every student, regardless of their real
-- presence history.
--
-- Scope: a student may read a class_sessions row only if it belongs to their
-- own class_section (not just "any session they have a presence row for" —
-- avoids also having to special-case sessions with zero presence rows, e.g.
-- ones they were fully absent for, which my-attendance.ts's honest-absence
-- handling also needs to read the session metadata for).
create policy "sessions student read own section" on class_sessions
  for select using (
    (auth.jwt() ->> 'app_role') = 'student'
    and class_section in (
      select s.class_section from students s where s.auth_uid = auth.uid()
    )
  );
