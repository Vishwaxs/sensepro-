-- SensePro+ · make proctor review attribution identity-provider agnostic.
--
-- Supabase Auth subjects are UUIDs, while Clerk subjects use values such as
-- `user_...`.  A text audit column can safely hold either form.  The trigger
-- stamps the verified JWT subject and server time; reviewers submit only the
-- decision, never their own identity.

alter table proctor_flags
  alter column reviewed_by type text using reviewed_by::text;

create or replace function proctor_flags_review_only() returns trigger
language plpgsql
set search_path = public, pg_catalog
as $fn$
begin
  if (auth.jwt() ->> 'app_role') in ('teacher', 'admin') then
    if new.session_id <> old.session_id
       or new.student_id is distinct from old.student_id
       or new.flag_type <> old.flag_type
       or new.suppressed <> old.suppressed
       or new.flagged_at <> old.flagged_at then
      raise exception 'staff review may only change review_status, reviewed_by, reviewed_at';
    end if;

    if new.review_status is distinct from old.review_status then
      new.reviewed_by := auth.jwt() ->> 'sub';
      new.reviewed_at := statement_timestamp();
    elsif new.reviewed_by is distinct from old.reviewed_by
       or new.reviewed_at is distinct from old.reviewed_at then
      raise exception 'review attribution is stamped by the database';
    end if;
  end if;
  return new;
end
$fn$;
