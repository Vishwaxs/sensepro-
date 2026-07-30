-- Enrolment provenance on each embedding, so photo and two-framing video
-- templates are distinguishable. This enables idempotent re-enrolment (clear
-- and rewrite one source without touching the others) and honest coverage
-- reporting per student.
--
-- Nullable ON PURPOSE: any embedding written before this column (e.g. the
-- JSON-era roster) has an unknown source and stays NULL rather than being
-- back-filled with a guess. The CHECK still constrains every non-NULL value.

alter table embeddings
  add column source text
  check (source in ('photo', 'video_knee', 'video_waist'));

comment on column embeddings.source is
  'Enrolment provenance: photo (DSLR bulk), video_knee (far framing, small face), '
  'video_waist (near framing, medium face). NULL = written before this column existed.';
