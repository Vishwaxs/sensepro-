"""Enrolment write-path to Supabase (service role, RLS-bypassing).

The bulk-photo and video enrolment CLIs use this to persist embeddings to
pgvector. It is deliberately separate from ``app/store.py`` — that module is the
presence write-path and by contract never reads the roster back, whereas
enrolment must read the reg_no->id map and, on ``--replace``, delete a student's
prior rows for a source. Both use the same PostgREST-over-httpx pattern.

No raw image is ever persisted: only the 512-d vector plus its metadata
(pose_bin, quality, source) reaches Postgres.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable

from enroll.pipeline import EmbeddingRecord

logger = logging.getLogger("sensepro.enroll.writer")


class EmbeddingsWriterError(RuntimeError):
    """Raised for configuration / preflight failures the operator must fix."""


def vec_literal(vec: Iterable[float]) -> str:
    """Serialise a vector for pgvector over PostgREST: '[f,f,...]'.

    pgvector accepts the bracketed text form; str(float) is round-trippable."""
    return "[" + ",".join(str(float(x)) for x in vec) + "]"


class EmbeddingsWriter:
    """PostgREST client for the ``embeddings`` table using the service-role key.

    Session lifecycle: hold one writer for a run, then ``close()``. Every method
    raises on failure — enrolment is a deliberate operator action, so a failed
    write must stop and be seen, not be swallowed like a capture-loop write.
    """

    def __init__(self, url: str, key: str) -> None:
        import httpx  # lazy: keeps the offline JSON path import-free

        self._client = httpx.Client(
            base_url=url.rstrip("/") + "/rest/v1",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> EmbeddingsWriter:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # --- preflight ---------------------------------------------------------
    def assert_source_column(self) -> None:
        """Fail clearly if migration 0008 (embeddings.source) is not applied."""
        r = self._client.get("/embeddings", params={"select": "source", "limit": "0"})
        if r.status_code >= 400:
            raise EmbeddingsWriterError(
                "The embeddings.source column is missing. Apply migration "
                "0008_embedding_source.sql to Supabase before running with --supabase. "
                f"(PostgREST: {r.status_code} {r.text.strip()})"
            )

    # --- roster ------------------------------------------------------------
    def reg_no_to_id(self) -> dict[str, str]:
        """Map students.reg_no -> students.id. Never creates rows."""
        r = self._client.get("/students", params={"select": "id,reg_no"})
        r.raise_for_status()
        return {row["reg_no"]: row["id"] for row in r.json()}

    # --- idempotency -------------------------------------------------------
    def has_source_rows(self, student_id: str, source: str) -> bool:
        r = self._client.get(
            "/embeddings",
            params={
                "student_id": f"eq.{student_id}",
                "source": f"eq.{source}",
                "select": "id",
                "limit": "1",
            },
        )
        r.raise_for_status()
        return bool(r.json())

    def delete_source_rows(self, student_id: str, source: str) -> int:
        """Delete a student's rows for one source (the ``--replace`` path)."""
        r = self._client.delete(
            "/embeddings",
            params={"student_id": f"eq.{student_id}", "source": f"eq.{source}"},
            headers={"Prefer": "return=representation"},
        )
        r.raise_for_status()
        return len(r.json())

    # --- insert ------------------------------------------------------------
    def insert_embeddings(
        self, student_id: str, source: str, records: list[EmbeddingRecord]
    ) -> int:
        payload = [
            {
                "student_id": student_id,
                "pose_bin": rec.pose_bin,
                "vec": vec_literal(rec.vec),
                "quality": float(rec.quality),
                "source": source,
            }
            for rec in records
        ]
        if not payload:
            return 0
        r = self._client.post("/embeddings", headers={"Prefer": "return=minimal"}, json=payload)
        r.raise_for_status()
        return len(payload)


def build_embeddings_writer() -> EmbeddingsWriter:
    """Construct a writer from settings, or raise with a fixable message.

    Requires the service-role key: the anon key cannot write to ``embeddings``
    (RLS is admin-read only, and inserts go through the service role)."""
    from app.config import settings

    if not settings.supabase_url or not settings.supabase_postgrest_key:
        raise EmbeddingsWriterError(
            "--supabase requires SUPABASE_URL and a service_role key "
            "(SUPABASE_SERVICE_ROLE_KEY — the eyJ… JWT) in the environment/.env. "
            "PostgREST rejects the sb_secret_ management key, and the anon key "
            "cannot write embeddings."
        )
    return EmbeddingsWriter(settings.supabase_url, settings.supabase_postgrest_key)
