"""POST/GET /v1/students/me/deletion-request tests (fake writer, no network).

Core invariant under test: the acting student_id ALWAYS comes from the
verified caller's own linked record — no student_id in the request body, so a
student can never submit a deletion request for anyone else."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

AUTH = {"Authorization": "Bearer x"}
STUDENT = {"id": "stud-1", "reg_no": "2547201", "class_section": "CS-401"}
PENDING = {"id": "req-1", "status": "pending", "requested_at": "2026-08-14T00:00:00Z"}


class FakeDeletionWriter:
    def __init__(self, *, student=None, existing=None, latest=None):
        self.student = student
        self.existing = existing
        self.latest = latest
        self.created: list[str] = []
        self.audits: list = []

    def student_by_auth_uid(self, auth_uid):
        return self.student

    def get_pending_deletion_request(self, student_id):
        return self.existing

    def create_deletion_request(self, student_id):
        if self.existing is not None:
            return self.existing
        self.created.append(student_id)
        return PENDING

    def latest_deletion_request(self, student_id):
        return self.latest

    def append_audit(self, actor, action, payload):
        self.audits.append((action, payload))

    def close(self):
        pass


def _patch(monkeypatch, writer, uid="uid-1"):
    monkeypatch.setattr("app.students_api.require_supabase_writer", lambda: writer)
    monkeypatch.setattr("app.students_api._verify_user", lambda auth: uid)


# --- POST (submit) -------------------------------------------------------
def test_request_deletion_requires_auth_header():
    r = client.post("/v1/students/me/deletion-request")
    assert r.status_code == 401


def test_request_deletion_not_linked_to_student_forbidden(monkeypatch):
    _patch(monkeypatch, FakeDeletionWriter(student=None))
    r = client.post("/v1/students/me/deletion-request", headers=AUTH)
    assert r.status_code == 403


def test_request_deletion_creates_and_audits(monkeypatch):
    writer = FakeDeletionWriter(student=STUDENT)
    _patch(monkeypatch, writer)
    r = client.post("/v1/students/me/deletion-request", headers=AUTH)
    assert r.status_code == 201
    assert r.json()["status"] == "pending"
    assert writer.created == ["stud-1"]
    assert ("deletion_request", {"student_id": "stud-1"}) in writer.audits


def test_request_deletion_idempotent_returns_existing_pending(monkeypatch):
    writer = FakeDeletionWriter(student=STUDENT, existing=PENDING)
    _patch(monkeypatch, writer)
    r = client.post("/v1/students/me/deletion-request", headers=AUTH)
    assert r.status_code == 201
    assert r.json()["id"] == "req-1"
    assert writer.created == []  # no duplicate row


# --- GET (restore state after reload) -------------------------------------
def test_my_deletion_request_none_when_never_asked(monkeypatch):
    _patch(monkeypatch, FakeDeletionWriter(student=STUDENT, latest=None))
    r = client.get("/v1/students/me/deletion-request", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"request": None}


def test_my_deletion_request_returns_latest(monkeypatch):
    _patch(monkeypatch, FakeDeletionWriter(student=STUDENT, latest=PENDING))
    r = client.get("/v1/students/me/deletion-request", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["request"]["id"] == "req-1"


def test_my_deletion_request_not_linked_forbidden(monkeypatch):
    _patch(monkeypatch, FakeDeletionWriter(student=None))
    r = client.get("/v1/students/me/deletion-request", headers=AUTH)
    assert r.status_code == 403
