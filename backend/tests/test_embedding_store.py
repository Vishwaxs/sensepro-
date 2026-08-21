import numpy as np

from vision.embedding_store import EmbeddingStore


def test_match_above_threshold() -> None:
    s = EmbeddingStore(threshold=0.45)
    s.add("s1", np.array([1, 0, 0], dtype=np.float32))
    s.add("s2", np.array([0, 1, 0], dtype=np.float32))
    sid, score = s.match(np.array([0.9, 0.1, 0.0], dtype=np.float32))
    assert sid == "s1" and score > 0.45


def test_no_match_below_threshold() -> None:
    s = EmbeddingStore(threshold=0.95)
    s.add("s1", np.array([1, 0, 0], dtype=np.float32))
    sid, _ = s.match(np.array([0.5, 0.5, 0.7], dtype=np.float32))
    assert sid is None


def test_from_rows_parses_list_vectors() -> None:
    rows = [
        {"student_id": "s1", "vec": [1.0, 0.0, 0.0]},
        {"student_id": "s2", "vec": [0.0, 1.0, 0.0]},
    ]
    s = EmbeddingStore.from_rows(rows, threshold=0.45)
    assert s.roster == {"s1", "s2"}
    sid, score = s.match(np.array([0.9, 0.1, 0.0], dtype=np.float32))
    assert sid == "s1" and score > 0.45


def test_from_rows_parses_pgvector_string() -> None:
    """PostgREST returns vector columns as the text form '[f,f,...]'."""
    rows = [{"student_id": "s1", "vec": "[1.0,0.0,0.0]"}]
    s = EmbeddingStore.from_rows(rows, threshold=0.45)
    sid, _ = s.match(np.array([1.0, 0.0, 0.0], dtype=np.float32))
    assert sid == "s1"


def test_from_rows_keeps_all_templates_per_student() -> None:
    """Photo + video templates for one student all land in the gallery."""
    rows = [
        {"student_id": "s1", "vec": [1.0, 0.0, 0.0]},  # photo
        {"student_id": "s1", "vec": [0.0, 1.0, 0.0]},  # video, side angle
    ]
    s = EmbeddingStore.from_rows(rows)
    assert s.roster == {"s1"}
    assert len(s._ids) == 2
    # A side-angle probe still matches s1 thanks to the extra template.
    sid, score = s.match(np.array([0.1, 0.9, 0.0], dtype=np.float32))
    assert sid == "s1" and score > 0.45
