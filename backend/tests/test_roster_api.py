"""Protected class-roster endpoint tests with a local fake writer."""

from fastapi.testclient import TestClient

from app.main import app
from app.store import SupabaseNotConfigured
from tests.conftest import staff_token

client = TestClient(app)


def _headers(role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {staff_token(role)}"}


class FakeRosterWriter:
    def __init__(self) -> None:
        self.requested_sections: list[str | None] = []
        self.closed = False

    def list_students(self, class_section: str | None = None) -> list[dict[str, str]]:
        self.requested_sections.append(class_section)
        return [
            {"id": "student-1", "reg_no": "2547201", "full_name": "Asha Rao"},
            {"id": "student-2", "reg_no": "2547202", "full_name": "Dev Shah"},
        ]

    def close(self) -> None:
        self.closed = True


def test_roster_requires_authentication() -> None:
    response = client.get("/v1/roster?class_section=MCA-4B")

    assert response.status_code == 401


def test_roster_rejects_student_role(monkeypatch) -> None:
    writer = FakeRosterWriter()
    monkeypatch.setattr("app.roster_api.require_supabase_writer", lambda: writer)

    response = client.get("/v1/roster", headers=_headers("student"))

    assert response.status_code == 403
    assert writer.requested_sections == []
    assert writer.closed is False


def test_roster_is_section_scoped_and_reports_exact_count(monkeypatch) -> None:
    writer = FakeRosterWriter()
    monkeypatch.setattr("app.roster_api.require_supabase_writer", lambda: writer)

    response = client.get("/v1/roster?class_section=MCA-4B", headers=_headers("teacher"))

    assert response.status_code == 200
    assert response.json() == {
        "students": [
            {"id": "student-1", "reg_no": "2547201", "full_name": "Asha Rao"},
            {"id": "student-2", "reg_no": "2547202", "full_name": "Dev Shah"},
        ],
        "count": 2,
    }
    assert writer.requested_sections == ["MCA-4B"]
    assert writer.closed is True


def test_roster_allows_management(monkeypatch) -> None:
    writer = FakeRosterWriter()
    monkeypatch.setattr("app.roster_api.require_supabase_writer", lambda: writer)

    response = client.get("/v1/roster", headers=_headers("management"))

    assert response.status_code == 200
    assert writer.requested_sections == [None]
    assert writer.closed is True


def test_roster_reports_missing_store_configuration(monkeypatch) -> None:
    def unavailable():
        raise SupabaseNotConfigured("not configured")

    monkeypatch.setattr("app.roster_api.require_supabase_writer", unavailable)

    response = client.get("/v1/roster", headers=_headers("admin"))

    assert response.status_code == 503
    assert response.json()["detail"] == "not configured"
