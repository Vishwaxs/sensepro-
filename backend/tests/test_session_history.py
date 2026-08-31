"""Mode-specific session-history summaries without network or database access."""

import pytest

from app.store import SupabaseWriter


class FakeResponse:
    status_code = 200

    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    def json(self) -> list[dict]:
        return self._rows

    def raise_for_status(self) -> None:
        return None


class FakeHistoryClient:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []

    def get(self, path: str, params: dict) -> FakeResponse:
        self.requests.append((path, params))
        if path == "/class_sessions":
            return FakeResponse(
                [
                    {
                        "id": "lecture-1",
                        "class_section": "MCA-4B",
                        "subject": "Networks",
                        "mode": "lecture",
                        "starts_at": "2026-08-30T08:00:00Z",
                        "ends_at": "2026-08-30T09:00:00Z",
                    },
                    {
                        "id": "exam-1",
                        "class_section": "MCA-4B",
                        "subject": "Networks exam",
                        "mode": "exam",
                        "starts_at": "2026-08-30T10:00:00Z",
                        "ends_at": "2026-08-30T11:00:00Z",
                    },
                    {
                        "id": "workshop-1",
                        "class_section": "MCA-4B",
                        "subject": "Networks lab",
                        "mode": "workshop",
                        "starts_at": "2026-08-30T12:00:00Z",
                        "ends_at": "2026-08-30T13:00:00Z",
                    },
                ]
            )
        if path == "/presence_intervals":
            return FakeResponse(
                [
                    {"session_id": "lecture-1", "student_id": "student-1"},
                    {"session_id": "lecture-1", "student_id": "student-1"},
                ]
            )
        if path == "/students":
            return FakeResponse(
                [
                    {"id": "student-1", "class_section": "MCA-4B"},
                    {"id": "student-2", "class_section": "MCA-4B"},
                ]
            )
        if path == "/proctor_flags":
            return FakeResponse(
                [
                    {"session_id": "exam-1", "review_status": "pending"},
                    {"session_id": "exam-1", "review_status": "dismissed"},
                ]
            )
        if path == "/engagement_zone_aggregates":
            return FakeResponse(
                [
                    {
                        "session_id": "workshop-1",
                        "window_start": "2026-08-30T12:00:00Z",
                        "zone": "front",
                        "n_tracked": 5,
                        "enrolled_in_zone": 10,
                        "vnei": 0.2,
                        "coverage": 0.5,
                    },
                    {
                        "session_id": "workshop-1",
                        "window_start": "2026-08-30T12:00:00Z",
                        "zone": "mid",
                        "n_tracked": 15,
                        "enrolled_in_zone": 30,
                        "vnei": 0.8,
                        "coverage": 0.25,
                    },
                    {
                        "session_id": "workshop-1",
                        "window_start": "2026-08-30T12:01:00Z",
                        "zone": "class",
                        "n_tracked": 10,
                        "enrolled_in_zone": 40,
                        "vnei": 0.6,
                        "coverage": 0.5,
                    },
                    {
                        "session_id": "workshop-1",
                        "window_start": "2026-08-30T12:01:00Z",
                        "zone": "front",
                        "n_tracked": 10,
                        "enrolled_in_zone": 10,
                        "vnei": 0.0,
                        "coverage": 0.0,
                    },
                ]
            )
        raise AssertionError(f"Unexpected path: {path}")


def test_session_history_scopes_each_metric_to_its_mode() -> None:
    client = FakeHistoryClient()
    writer = object.__new__(SupabaseWriter)
    writer._client = client

    rows = writer.list_sessions_history()

    lecture, exam, workshop = rows
    assert lecture["present_count"] == 1
    assert lecture["total_count"] == 2
    assert lecture["flag_count"] == 0
    assert lecture["vnei"] is None

    assert exam["present_count"] == 0
    assert exam["total_count"] == 0
    assert exam["flag_count"] == 2
    assert exam["pending_flag_count"] == 1
    assert exam["vnei"] is None

    assert workshop["present_count"] == 0
    assert workshop["flag_count"] == 0
    assert workshop["vnei"] == pytest.approx(19 / 30)
    assert workshop["coverage"] == pytest.approx(32.5 / 80)
    assert workshop["reportable_windows"] == 2
    assert workshop["vnei_weight"] == 30
    assert workshop["coverage_weight"] == 80

    requests = dict(client.requests)
    assert requests["/presence_intervals"]["session_id"] == "in.(lecture-1)"
    assert requests["/proctor_flags"]["session_id"] == "in.(exam-1)"
    assert requests["/engagement_zone_aggregates"]["session_id"] == "in.(workshop-1)"
    assert "zone,n_tracked,enrolled_in_zone" in requests["/engagement_zone_aggregates"]["select"]
