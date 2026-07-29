"""In-memory cosine matcher over enrolled embeddings.

Loaded from an enrolment JSON (produced by the enrol CLI) or from Supabase
pgvector in production. Embeddings are L2-normalised, so cosine == dot product.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np


class EmbeddingStore:
    def __init__(self, threshold: float = 0.45) -> None:
        self.threshold = threshold
        self._ids: list[str] = []
        self._mat: np.ndarray | None = None  # (N, D), L2-normalised

    def add(self, student_id: str, vec: np.ndarray) -> None:
        v = _l2(vec).astype(np.float32)
        self._ids.append(student_id)
        self._mat = v[None, :] if self._mat is None else np.vstack([self._mat, v])

    def match(self, vec: np.ndarray) -> tuple[str | None, float]:
        if self._mat is None or not len(self._ids):
            return None, 0.0
        sims = self._mat @ _l2(vec).astype(np.float32)
        i = int(np.argmax(sims))
        score = float(sims[i])
        return (self._ids[i], score) if score >= self.threshold else (None, score)

    @property
    def roster(self) -> set[str]:
        return set(self._ids)

    @classmethod
    def from_json(cls, path: str | Path, threshold: float = 0.45) -> "EmbeddingStore":
        store = cls(threshold)
        data = json.loads(Path(path).read_text())
        for sid, vecs in data.items():
            for v in vecs:
                store.add(sid, np.asarray(v, dtype=np.float32))
        return store

    @classmethod
    def from_rows(cls, rows: list[dict], threshold: float = 0.45) -> "EmbeddingStore":
        """Build a store from embeddings rows (each {'student_id', 'vec'}).

        ``vec`` may be a list or the pgvector text form '[f,f,...]' (which is
        valid JSON, so it parses either way). Every template is added, so a
        student with photo + video templates gets all of them in the gallery."""
        store = cls(threshold)
        for row in rows:
            vec = row["vec"]
            if isinstance(vec, str):
                vec = json.loads(vec)
            store.add(row["student_id"], np.asarray(vec, dtype=np.float32))
        return store

    @classmethod
    def from_supabase(
        cls,
        url: str,
        key: str,
        threshold: float = 0.45,
        page: int = 1000,
    ) -> "EmbeddingStore":
        """Load the whole enrolled gallery from pgvector via PostgREST.

        This is the inference engine reading its own templates with the
        service-role key (embeddings are admin/service-role only) — not a
        browser read path. Paginated so it scales past PostgREST's row cap."""
        import httpx  # lazy: the offline JSON path stays import-free

        rows: list[dict] = []
        client = httpx.Client(
            base_url=url.rstrip("/") + "/rest/v1",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=30.0,
        )
        try:
            offset = 0
            while True:
                r = client.get(
                    "/embeddings",
                    params={
                        "select": "student_id,vec",
                        "order": "id",
                        "limit": str(page),
                        "offset": str(offset),
                    },
                )
                r.raise_for_status()
                batch = r.json()
                rows.extend(batch)
                if len(batch) < page:
                    break
                offset += page
        finally:
            client.close()
        return cls.from_rows(rows, threshold)


def _l2(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32)
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v
