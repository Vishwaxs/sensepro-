-- SensePro+ · enrolment coverage for the admin Enrollment station, WITHOUT
-- exposing biometric templates to the browser.
--
-- The Enrollment page needs one thing from `embeddings`: how many templates
-- each student has, split by provenance, so it can show GOOD/OK/WEAK/NONE and
-- tell an operator who still needs enrolling. It was querying the base table
-- directly, which is denied — `embeddings` is deliberately the one table with
-- no `authenticated` grant (0005, 0015), because rows there carry the raw
-- vector(512) face templates and the CLAUDE.md privacy invariant keeps those
-- server-side. The denial is correct; the page's data source was not. With the
-- very first query throwing, the page never reached its students fetch either,
-- which is why it showed "Could not load the roster" and 0 across every tile.
--
-- This view is the honest middle: aggregate counts per student, no `vec`, no
-- `quality`, no per-embedding rows — nothing that could reconstruct or compare
-- a template. Counting your own templates is not a biometric disclosure.
--
-- On security_invoker: the obvious spelling is `security_invoker = on`, so the
-- caller's RLS on `students` scopes the rows. That does not work here — an
-- invoker-rights view also requires the CALLER to hold SELECT on `embeddings`,
-- which is precisely the grant being withheld, so every read failed with
-- "permission denied for table embeddings". The view therefore runs with
-- definer rights (the owner may count templates) and enforces visibility in
-- its OWN where clause instead of borrowing RLS. That clause mirrors the
-- `students` policies exactly: staff see the roster, a student sees only their
-- own row. Because the view bypasses RLS, treat that predicate as security-
-- critical — changing it changes who can see whom.

create or replace view enrollment_coverage
with (security_invoker = off) as
select
  s.id            as student_id,
  s.reg_no,
  s.full_name,
  s.class_section,
  count(e.id)                                         as total,
  count(e.id) filter (where e.source = 'photo')        as photo,
  count(e.id) filter (where e.source = 'video_knee')   as video_knee,
  count(e.id) filter (where e.source = 'video_waist')  as video_waist,
  count(e.id) filter (where e.source is null)          as video
from students s
left join embeddings e on e.student_id = s.id
where
  (auth.jwt() ->> 'app_role') in ('teacher', 'management', 'admin')
  or s.auth_uid = auth.uid()
group by s.id, s.reg_no, s.full_name, s.class_section;

comment on view enrollment_coverage is
  'Per-student enrolment template COUNTS by provenance for the admin Enrollment '
  'station. Exposes no vector, quality, or per-embedding row; `embeddings` stays '
  'ungranted to authenticated. security_definer by necessity, so visibility is '
  'enforced by this view''s own WHERE clause: staff see the roster, a student '
  'sees only their own row.';

revoke all on enrollment_coverage from anon;
grant select on enrollment_coverage to authenticated;
