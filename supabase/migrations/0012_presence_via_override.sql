-- Allow presence_intervals.via to record a teacher's manual correction.
--
-- 0010 introduced via ('camera'|'qr') so a QR-assisted presence row is
-- distinguishable from a camera-recognised one. A teacher's manual override
-- (POST /v1/sessions/{id}/override) needs a third, equally honest label —
-- writing 'camera' or 'qr' for a row the camera never saw would misrepresent
-- how that attendance decision was actually made.
alter table presence_intervals drop constraint presence_intervals_via_check;
alter table presence_intervals
  add constraint presence_intervals_via_check check (via in ('camera', 'qr', 'override'));
