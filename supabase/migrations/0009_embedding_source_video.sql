-- Bulk video enrolment tags its templates 'video': multi-angle / side-face /
-- distance variants that raise matching confidence and speed, alongside the
-- DSLR 'photo' anchors that are the primary attendance reference. This is a
-- single honest tag — the folder videos are not split by framing — while
-- video_knee/video_waist stay valid for the admin two-framing upload path.
--
-- CHECK constraints can't be widened in place, so drop and re-add (named this
-- time). Idempotent: safe to re-run.

alter table embeddings drop constraint if exists embeddings_source_check;
alter table embeddings
  add constraint embeddings_source_check
  check (source in ('photo', 'video', 'video_knee', 'video_waist'));
