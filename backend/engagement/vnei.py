"""Visibility-Normalised Engagement Index — ZONE aggregates, nothing finer.

There is intentionally NO per-student engagement value in this module, in the
schema, or anywhere else. If a change ever seems to need a student identifier
on an engagement record, STOP: that violates the design (privacy tier T2 and
the k>=5 floor). See ADR 0007.

Zones are fixed horizontal bands of the FRAME: the camera stands at the front
of the room, so nearer rows appear lower in the image. A track whose box
centre sits in the bottom band (y >= front_band * height) is 'front', in the
top band (y <= back_band * height) 'back', otherwise 'mid'. Crude but stable,
and honest about being frame geometry rather than seat maps.

The visibility normalisation: vnei is computed over observations of tracks
that were actually VISIBLE in the zone that window — a sparsely-seen back row
contributes only what was seen, and its thin evidence is declared through
`coverage` (distinct tracks seen / enrolled in zone) rather than silently
skewing the number. Windows with n_tracked < k_min are suppressed outright
(also CHECK-enforced in the DB).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.store import PresenceWriter, ZoneAggregateRow
from engagement.signals import TrackSignals
from vision.types import Track

logger = logging.getLogger("sensepro.engagement")

ZONES = ("front", "mid", "back")


@dataclass
class _ZoneWindow:
    track_ids: set[int] = field(default_factory=set)
    # Most tracks seen in the zone in a SINGLE frame this window. `track_ids`
    # is a running union over the whole window, so it counts a person once per
    # track id they are ever assigned — and ids churn on every re-detection
    # after an occlusion or a turned head. Over a 60s window that inflated a
    # 17-seat zone to n_tracked in the hundreds, which pinned coverage at the
    # min(1.0, ...) clamp and made every vnei look like a full-visibility
    # reading. Peak-concurrent is the honest "how many were actually visible
    # at once" and cannot exceed the people in the room.
    peak_concurrent: int = 0
    n_obs: int = 0
    attend_obs: int = 0  # observations where the backend could tell
    attending: int = 0
    head_down: int = 0
    pose_peak_concurrent: int = 0
    phone_obs: int = 0
    phone: int = 0
    still_obs: int = 0
    still: int = 0


def _rate(num: int, den: int) -> float:
    return round(num / den, 3) if den else 0.0


class ZoneAggregator:
    def __init__(
        self,
        session_id: str,
        writer: PresenceWriter,
        session_start: datetime,
        enrolled_by_zone: dict[str, int],
        window_s: float = 60.0,
        front_band: float = 0.66,
        back_band: float = 0.33,
        k_min: int = 5,
    ) -> None:
        self._session_id = session_id
        self._writer = writer
        self._session_start = session_start
        self._enrolled = enrolled_by_zone
        self._window_s = window_s
        self._front_band = front_band
        self._back_band = back_band
        self._k_min = k_min
        self._window_start_rel: float | None = None
        self._zones: dict[str, _ZoneWindow] = {}
        self._completed_windows = 0
        self._last_window: dict | None = None

    @property
    def window_s(self) -> float:
        return self._window_s

    def zone_of(self, track: Track, frame_h: int) -> str:
        y1, y2 = track.det.box[1], track.det.box[3]
        centre_y = (y1 + y2) / 2.0
        if centre_y >= self._front_band * frame_h:
            return "front"
        if centre_y <= self._back_band * frame_h:
            return "back"
        return "mid"

    def observe(
        self,
        observations: list[tuple[Track, TrackSignals]],
        frame_h: int,
        rel_ts: float,
    ) -> list[ZoneAggregateRow]:
        """Fold one sampled frame into the current window; when the window
        boundary passes, emit (write + return) the closed window's rows."""
        emitted: list[ZoneAggregateRow] = []
        if self._window_start_rel is None:
            self._window_start_rel = rel_ts
        elif rel_ts - self._window_start_rel >= self._window_s:
            emitted = self.flush()
            self._window_start_rel = rel_ts
        # Distinct tracks per zone IN THIS FRAME, so peak_concurrent measures
        # simultaneous visibility rather than the window-long id union.
        this_frame: dict[str, set[int]] = {}
        pose_this_frame: dict[str, set[int]] = {}
        for track, sig in observations:
            zone = self.zone_of(track, frame_h)
            this_frame.setdefault(zone, set()).add(track.track_id)
            win = self._zones.setdefault(zone, _ZoneWindow())
            win.track_ids.add(track.track_id)
            win.n_obs += 1
            if sig.attending is not None:
                pose_this_frame.setdefault(zone, set()).add(track.track_id)
                win.attend_obs += 1
                win.attending += int(sig.attending)
                win.head_down += int(bool(sig.head_down))
            if sig.phone_nearby is not None:
                win.phone_obs += 1
                win.phone += int(sig.phone_nearby)
            if sig.still is not None:
                win.still_obs += 1
                win.still += int(sig.still)
        for zone, ids in this_frame.items():
            win = self._zones[zone]
            win.peak_concurrent = max(win.peak_concurrent, len(ids))
            win.pose_peak_concurrent = max(
                win.pose_peak_concurrent,
                len(pose_this_frame.get(zone, set())),
            )
        return emitted

    def flush(self) -> list[ZoneAggregateRow]:
        """Close the current window: write and return its zone rows, suppress
        any zone below the k-anonymity floor."""
        if self._window_start_rel is None:
            return []
        window_start = self._session_start + timedelta(seconds=self._window_start_rel)
        rows: list[ZoneAggregateRow] = []
        withheld: dict[str, str] = {}
        for zone, win in self._zones.items():
            # Peak concurrent, not the id union — see _ZoneWindow.peak_concurrent.
            # This also makes the k>=5 floor mean "5 people visible together",
            # which is the k-anonymity property ADR 0007 actually claims; the
            # union could clear the floor with one person re-detected 5 times.
            n_tracked = win.peak_concurrent
            if n_tracked < self._k_min:
                logger.info("zone %s suppressed: n_tracked=%d < %d", zone, n_tracked, self._k_min)
                withheld[zone] = "privacy_floor"
                continue
            # A zone can have five visible boxes but only one pose-capable face
            # (or none with a backend that exposes no landmarks). Reporting an
            # index from that one person would both overstate model coverage and
            # defeat the aggregate privacy claim. Require k simultaneously
            # observable poses as well as k visible tracks.
            if win.pose_peak_concurrent < self._k_min or win.attend_obs == 0:
                logger.info(
                    "zone %s suppressed: pose_observable=%d < %d",
                    zone,
                    win.pose_peak_concurrent,
                    self._k_min,
                )
                withheld[zone] = "insufficient_pose_observations"
                continue
            configured_enrolled = self._enrolled.get(zone, 0)
            # Until a calibrated seat-zone map is available, callers use an
            # even roster split. Frame-geometry bands do not necessarily contain
            # that same split, so a legitimate peak can exceed the approximation.
            # Migration 0016 rejects n_tracked > enrolled_in_zone. Treat the
            # observation as a lower bound on that approximate denominator rather
            # than dropping a valid aggregate at the database boundary.
            enrolled = max(configured_enrolled, n_tracked)
            signals: dict[str, float] = {
                "head_down_rate": _rate(win.head_down, win.attend_obs),
            }
            if win.phone_obs:
                signals["phone_rate"] = _rate(win.phone, win.phone_obs)
            if win.still_obs:
                signals["still_rate"] = _rate(win.still, win.still_obs)
            row = ZoneAggregateRow(
                session_id=self._session_id,
                window_start=window_start,
                window_s=int(self._window_s),
                zone=zone,
                n_tracked=n_tracked,
                enrolled_in_zone=enrolled,
                coverage=round(min(1.0, n_tracked / enrolled), 3) if enrolled else 0.0,
                vnei=_rate(win.attending, win.attend_obs),
                signals=signals,
            )
            self._writer.create_zone_aggregate(row)
            rows.append(row)
        if self._zones:
            self._completed_windows += 1
            self._last_window = {
                "state": "reported" if rows else "withheld",
                "window_start": window_start.isoformat(),
                # "reported" means handed to the configured writer. The writer
                # deliberately owns retry/error policy, so this layer must not
                # claim a database acknowledgement it cannot observe.
                "reported_zones": [row.zone for row in rows],
                "withheld_zones": withheld,
            }
        self._zones = {}
        return rows

    def window_status(self, rel_ts: float) -> dict:
        """Transport-neutral state for the live workshop/RTSP UI.

        It exposes collection progress and the last closed window without ever
        claiming a database acknowledgement. Persisted rows remain the source
        of truth for management views.
        """

        elapsed = (
            0.0
            if self._window_start_rel is None
            else min(self._window_s, max(0.0, rel_ts - self._window_start_rel))
        )
        return {
            "state": "collecting" if self._window_start_rel is not None else "waiting",
            "window_s": int(self._window_s),
            "elapsed_s": round(elapsed, 1),
            "remaining_s": round(max(0.0, self._window_s - elapsed), 1),
            "completed_windows": self._completed_windows,
            "last_window": self._last_window,
        }


def live_engagement_view(
    signals: dict[int, TrackSignals],
    aggregator: ZoneAggregator,
    rel_ts: float,
    *,
    k_min: int = 5,
) -> dict:
    """Build the shared WS/RTSP class-level preview from observable evidence.

    Unknown pose and an unavailable phone detector remain unknown. VNEI is
    withheld unless at least ``k_min`` currently visible tracks also have a
    pose observation, so the preview never turns one person's posture into a
    class score.
    """

    visible = len(signals)
    pose_observed = sum(1 for signal in signals.values() if signal.attending is not None)
    attending = sum(1 for signal in signals.values() if signal.attending is True)
    head_down = sum(1 for signal in signals.values() if signal.head_down is True)
    phone_observed = sum(1 for signal in signals.values() if signal.phone_nearby is not None)
    phone = (
        sum(1 for signal in signals.values() if signal.phone_nearby is True)
        if phone_observed
        else None
    )
    still_observed = sum(1 for signal in signals.values() if signal.still is not None)
    still = sum(1 for signal in signals.values() if signal.still is True)
    moving = sum(1 for signal in signals.values() if signal.still is False)

    privacy_ready = visible >= k_min
    observable_ready = pose_observed >= k_min
    suppressed = not (privacy_ready and observable_ready)
    if not privacy_ready:
        suppression_reason = "privacy_floor"
    elif not observable_ready:
        suppression_reason = "insufficient_pose_observations"
    else:
        suppression_reason = None

    return {
        "visible": visible,
        "observable": pose_observed,
        "attending": attending,
        "head_down": head_down,
        "phone": phone,
        "phone_observed": phone_observed,
        "still": still,
        "moving": moving,
        "still_observed": still_observed,
        "vnei": round(attending / pose_observed, 3) if not suppressed else None,
        "k_min": k_min,
        "suppressed": suppressed,
        "suppression_reason": suppression_reason,
        "window": aggregator.window_status(rel_ts),
    }
