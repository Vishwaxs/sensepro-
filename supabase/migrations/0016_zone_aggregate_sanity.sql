-- SensePro+ · make the "more people tracked than exist in the zone" state
-- unrepresentable.
--
-- backend/engagement/vnei.py originally set n_tracked from a running UNION of
-- track ids over the whole window. Track ids churn on every re-detection, so a
-- 60s window over a 17-seat zone accumulated hundreds of ids. Because coverage
-- is min(1.0, n_tracked / enrolled), that inflation silently clamped coverage
-- to a confident 1.0 and made every VNEI read as a full-visibility number —
-- the flat line on the Trends and Management charts. The aggregator now uses
-- peak-concurrent tracks instead, which cannot exceed the people in the room.
--
-- This CHECK is the backstop for that fix: n_tracked is a headcount of
-- simultaneously-visible people, so exceeding the zone's enrolment is not a
-- degraded reading to be displayed with a caveat, it is arithmetically
-- impossible and means the counter regressed. Fail the write rather than
-- persist a number the dashboards would present as fact.
--
-- enrolled_in_zone = 0 is exempt: zone enrolment is currently an even split of
-- the roster (students.seat_zone is not yet populated), and a session that
-- starts before any roster is loaded legitimately reports 0 enrolled with
-- coverage 0.0 — thin evidence, correctly declared, not a corrupt count.

alter table engagement_zone_aggregates
  add constraint zone_agg_tracked_within_enrolled
  check (enrolled_in_zone = 0 or n_tracked <= enrolled_in_zone);
