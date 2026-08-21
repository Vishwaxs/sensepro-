-- SensePro+ · replace the security_definer enrollment_coverage view with an
-- invoker-rights view over a narrowly-scoped definer FUNCTION.
--
-- 0017 shipped enrollment_coverage as a SECURITY DEFINER view because an
-- invoker-rights view would have required the CALLER to hold SELECT on
-- `embeddings` — the one grant this project deliberately withholds, since that
-- table stores raw vector(512) face templates. That worked, and its WHERE
-- clause scoped rows correctly, but it earns an ERROR-level lint for good
-- reason: a definer view runs EVERY query as its owner, so all row visibility
-- rests on a predicate written by hand inside the view. Any later edit to that
-- clause could widen access with no RLS policy left to catch it — a bad
-- property for anything adjacent to biometric data.
--
-- Split of responsibilities now:
--   * embedding_counts() — SECURITY DEFINER, but returns ONLY (student_id,
--     total, photo, video_knee, video_waist, video). No vec, no quality, no
--     per-embedding row. It cannot leak a template because it never selects
--     one, and that is verifiable by reading eight lines instead of a view.
--   * enrollment_coverage — SECURITY INVOKER, joins that function to
--     `students`. Row visibility therefore comes from the REAL RLS policies on
--     students ("students staff read" / "students self read"), which is what
--     should have been deciding it all along: staff see the class, a student
--     sees only their own row.
--
-- Verified after applying: admin 53 rows / 102 templates; student 1 row.

drop view if exists enrollment_coverage;

create or replace function embedding_counts()
returns table (
  student_id   uuid,
  total        bigint,
  photo        bigint,
  video_knee   bigint,
  video_waist  bigint,
  video        bigint
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select
    e.student_id,
    count(*)                                       as total,
    count(*) filter (where e.source = 'photo')      as photo,
    count(*) filter (where e.source = 'video_knee') as video_knee,
    count(*) filter (where e.source = 'video_waist') as video_waist,
    count(*) filter (where e.source is null)        as video
  from embeddings e
  group by e.student_id;
$$;

revoke all on function embedding_counts() from public, anon;
grant execute on function embedding_counts() to authenticated;

comment on function embedding_counts is
  'Per-student enrolment template COUNTS only. SECURITY DEFINER so callers need '
  'no grant on embeddings (which holds raw vector(512) templates and stays '
  'ungranted); returns no vector, quality, or per-embedding row.';

create view enrollment_coverage
with (security_invoker = on) as
select
  s.id            as student_id,
  s.reg_no,
  s.full_name,
  s.class_section,
  coalesce(c.total, 0)       as total,
  coalesce(c.photo, 0)       as photo,
  coalesce(c.video_knee, 0)  as video_knee,
  coalesce(c.video_waist, 0) as video_waist,
  coalesce(c.video, 0)       as video
from students s
left join embedding_counts() c on c.student_id = s.id;

comment on view enrollment_coverage is
  'Roster + enrolment template counts for the admin Enrollment station. '
  'security_invoker: row visibility comes from the RLS policies on students, '
  'so staff see the class and a student sees only their own row.';

revoke all on enrollment_coverage from anon;
grant select on enrollment_coverage to authenticated;
