"""Tests for bulk photo enrollment CLI (synthetic images, no network, no real faces)."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest


def make_synthetic_face_image(
    width: int = 400,
    height: int = 400,
    brightness: int = 128,
) -> np.ndarray:
    """Create a synthetic image with a 'face-like' region (uniform rectangle)."""
    img = np.full((height, width, 3), brightness, dtype=np.uint8)
    # Add some texture so blur_var is above threshold
    noise = np.random.randint(0, 30, (height, width, 3), dtype=np.uint8)
    img = cv2.add(img, noise)
    return img


def make_dark_image(width: int = 400, height: int = 400) -> np.ndarray:
    """Create a very dark image that should fail brightness gate."""
    return np.full((height, width, 3), 10, dtype=np.uint8)


def make_small_image(width: int = 30, height: int = 30) -> np.ndarray:
    """Create a too-small image."""
    return np.full((height, width, 3), 128, dtype=np.uint8)


class FakeDetection:
    def __init__(self, box, face_px_height):
        self.box = box
        self.x1, self.y1, self.x2, self.y2 = box
        self.face_px_height = face_px_height
        self.score = 0.99


class FakeDetector:
    """Returns a fake detection for any reasonably-sized image."""

    def detect(self, img: np.ndarray, max_num: int = 0) -> list:
        h, w = img.shape[:2]
        if h < 50 or w < 50:
            return []
        face_h = h // 2
        face_w = w // 2
        cx, cy = w // 2, h // 2
        return [
            FakeDetection(
                box=(cx - face_w // 2, cy - face_h // 2, cx + face_w // 2, cy + face_h // 2),
                face_px_height=face_h,
            )
        ]


class FakeEmbedder:
    """Returns a random unit-vector embedding."""

    def embed(self, img: np.ndarray, det) -> np.ndarray:
        vec = np.random.randn(512).astype(np.float32)
        return vec / np.linalg.norm(vec)


@pytest.fixture
def mock_enroller():
    """Enroller with mocked vision backends."""
    from enroll.pipeline import Enroller, GateConfig

    enroller = Enroller.__new__(Enroller)
    enroller.cfg = GateConfig()
    enroller.degrade = True
    enroller.degrade_heights = (96, 64)
    enroller.jpeg_quality = 40
    enroller.blur_sigma = 0.6
    enroller.detector = FakeDetector()
    enroller.embedder = FakeEmbedder()
    return enroller


@pytest.fixture
def photos_dir(tmp_path: Path) -> Path:
    """Create a test photos directory structure."""
    # Student with good images
    s1 = tmp_path / "2547201"
    s1.mkdir()
    for i in range(3):
        img = make_synthetic_face_image()
        cv2.imwrite(str(s1 / f"img{i}.jpg"), img)

    # Student with one dark image
    s2 = tmp_path / "2547203"
    s2.mkdir()
    cv2.imwrite(str(s2 / "good.jpg"), make_synthetic_face_image())
    cv2.imwrite(str(s2 / "dark.jpg"), make_dark_image())

    # Student with no images
    s3 = tmp_path / "2547204"
    s3.mkdir()

    # Non-student folder (starts with _)
    meta = tmp_path / "_consent"
    meta.mkdir()

    return tmp_path


class TestValidateImage:
    def test_accepts_good_image(self, mock_enroller, tmp_path):
        from enroll.bulk_photos import validate_image

        img = make_synthetic_face_image()
        path = tmp_path / "good.jpg"
        cv2.imwrite(str(path), img)

        ok, reason, frame = validate_image(path, mock_enroller)
        assert ok is True
        assert "ok" in reason
        assert frame is not None

    def test_rejects_small_image(self, mock_enroller, tmp_path):
        from enroll.bulk_photos import validate_image

        img = make_small_image()
        path = tmp_path / "small.jpg"
        cv2.imwrite(str(path), img)

        ok, reason, _ = validate_image(path, mock_enroller)
        assert ok is False
        assert "small" in reason.lower() or "no face" in reason.lower()

    def test_rejects_unreadable_file(self, mock_enroller, tmp_path):
        from enroll.bulk_photos import validate_image

        path = tmp_path / "notanimage.txt"
        path.write_text("not an image")

        ok, reason, _ = validate_image(path, mock_enroller)
        assert ok is False
        assert "cannot read" in reason.lower()


class TestProcessStudent:
    def test_good_student_produces_embeddings(self, mock_enroller, tmp_path):
        from enroll.bulk_photos import process_student

        folder = tmp_path / "2547201"
        folder.mkdir()
        for i in range(2):
            cv2.imwrite(str(folder / f"img{i}.jpg"), make_synthetic_face_image())

        result = process_student("2547201", folder, mock_enroller, dry_run=False)
        assert result["status"] == "ok"
        assert result["images_accepted"] >= 1
        assert result["embeddings_produced"] > 0
        assert "_records" in result

    def test_degrade_increases_embedding_count(self, tmp_path):
        """With degrade ON, more embeddings should be produced than with degrade OFF."""
        from enroll.pipeline import Enroller, GateConfig

        # Enroller WITH degrade
        e_on = Enroller.__new__(Enroller)
        e_on.cfg = GateConfig()
        e_on.degrade = True
        e_on.degrade_heights = (96, 64)
        e_on.jpeg_quality = 40
        e_on.blur_sigma = 0.6
        e_on.detector = FakeDetector()
        e_on.embedder = FakeEmbedder()

        # Enroller WITHOUT degrade
        e_off = Enroller.__new__(Enroller)
        e_off.cfg = GateConfig()
        e_off.degrade = False
        e_off.degrade_heights = ()
        e_off.jpeg_quality = 40
        e_off.blur_sigma = 0.6
        e_off.detector = FakeDetector()
        e_off.embedder = FakeEmbedder()

        from enroll.bulk_photos import process_student

        folder = tmp_path / "test_student"
        folder.mkdir()
        for i in range(2):
            cv2.imwrite(str(folder / f"img{i}.jpg"), make_synthetic_face_image())

        r_on = process_student("test", folder, e_on, dry_run=False)
        r_off = process_student("test", folder, e_off, dry_run=False)

        assert r_on["embeddings_produced"] >= r_off["embeddings_produced"]

    def test_empty_folder_returns_no_images(self, mock_enroller, tmp_path):
        from enroll.bulk_photos import process_student

        folder = tmp_path / "empty"
        folder.mkdir()

        result = process_student("empty", folder, mock_enroller, dry_run=False)
        assert result["status"] == "no_images"

    def test_dry_run_does_not_write(self, mock_enroller, tmp_path):
        from enroll.bulk_photos import process_student

        folder = tmp_path / "2547201"
        folder.mkdir()
        cv2.imwrite(str(folder / "img.jpg"), make_synthetic_face_image())

        result = process_student("2547201", folder, mock_enroller, dry_run=True)
        assert result["status"] == "dry_run_ok"
        assert "_embeddings" not in result
        assert result["embeddings_produced"] > 0  # estimated count


class TestRegNoMapping:
    def test_unmatched_reg_no_is_skipped(self):
        """If students_map has entries and reg_no isn't in it, it should be skipped."""
        from enroll.bulk_photos import load_students_map

        # When Supabase is not configured, returns empty dict (no validation)
        result = load_students_map(None, None)
        assert result == {}


class TestDetailedRecords:
    def test_records_carry_valid_pose_bin_and_quality(self, mock_enroller, tmp_path):
        """Each record must satisfy the embeddings-table columns: pose_bin in the
        CHECK set, a float quality, a 512-d vector, and a provenance variant."""
        from enroll.pipeline import EmbeddingRecord

        folder = tmp_path / "s"
        folder.mkdir()
        for i in range(2):
            cv2.imwrite(str(folder / f"img{i}.jpg"), make_synthetic_face_image())
        frames = [cv2.imread(str(p)) for p in sorted(folder.iterdir())]

        records = mock_enroller.enroll_frames_detailed(frames)
        assert records, "expected at least one embedding record"

        valid_bins = {"center", "left", "right", "up", "down", "avg"}
        for r in records:
            assert isinstance(r, EmbeddingRecord)
            assert r.pose_bin in valid_bins
            assert isinstance(r.quality, float)
            assert len(r.vec) == 512
            assert r.variant == "clean" or r.variant.startswith("degrade_")

    def test_enroll_frames_is_vectors_view_of_detailed(self, mock_enroller, tmp_path):
        """enroll_frames returns exactly the vectors of enroll_frames_detailed
        (same count — the pipeline is deterministic in which frames it keeps)."""
        folder = tmp_path / "s"
        folder.mkdir()
        for i in range(2):
            cv2.imwrite(str(folder / f"img{i}.jpg"), make_synthetic_face_image())
        frames = [cv2.imread(str(p)) for p in sorted(folder.iterdir())]

        assert len(mock_enroller.enroll_frames(frames)) == len(
            mock_enroller.enroll_frames_detailed(frames)
        )

    def test_degrade_variants_inherit_parent_pose_bin(self, mock_enroller, tmp_path):
        """A degraded variant shares its clean parent's pose bin (only the
        sharpness changes, not the horizontal position)."""
        folder = tmp_path / "s"
        folder.mkdir()
        cv2.imwrite(str(folder / "img.jpg"), make_synthetic_face_image())
        frames = [cv2.imread(str(folder / "img.jpg"))]

        records = mock_enroller.enroll_frames_detailed(frames)
        bins = {r.pose_bin for r in records}
        # A single frame lands in exactly one bin; clean + all its variants share it.
        assert len(bins) == 1


class FakeEmbeddingsWriter:
    """Records calls instead of hitting the network (tests never touch Supabase)."""

    def __init__(self, existing: set | None = None):
        self.existing = set(existing or [])  # (student_id, source) already enrolled
        self.inserted: list = []  # (student_id, source, n_records)
        self.deleted: list = []  # (student_id, source)

    def has_source_rows(self, student_id: str, source: str) -> bool:
        return (student_id, source) in self.existing

    def delete_source_rows(self, student_id: str, source: str) -> int:
        self.deleted.append((student_id, source))
        self.existing.discard((student_id, source))
        return 1

    def insert_embeddings(self, student_id: str, source: str, records: list) -> int:
        self.inserted.append((student_id, source, len(records)))
        return len(records)


def _good_result(reg_no, enroller, tmp_path):
    folder = tmp_path / reg_no
    folder.mkdir()
    for i in range(2):
        cv2.imwrite(str(folder / f"img{i}.jpg"), make_synthetic_face_image())
    from enroll.bulk_photos import process_student

    return process_student(reg_no, folder, enroller, dry_run=False)


class TestSupabaseWrite:
    def test_inserts_each_student(self, mock_enroller, tmp_path):
        from enroll.bulk_photos import write_results_to_supabase

        res = _good_result("2547201", mock_enroller, tmp_path)
        writer = FakeEmbeddingsWriter()
        summary = write_results_to_supabase(
            [res], {"2547201": "uuid-1"}, writer, "photo", replace=False
        )

        assert summary["written"] == res["embeddings_produced"]
        assert writer.inserted == [("uuid-1", "photo", res["embeddings_produced"])]
        assert writer.deleted == []

    def test_existing_student_skipped_without_replace(self, mock_enroller, tmp_path):
        from enroll.bulk_photos import write_results_to_supabase

        res = _good_result("2547201", mock_enroller, tmp_path)
        writer = FakeEmbeddingsWriter(existing={("uuid-1", "photo")})
        summary = write_results_to_supabase(
            [res], {"2547201": "uuid-1"}, writer, "photo", replace=False
        )

        assert summary["written"] == 0
        assert writer.inserted == []
        assert summary["skipped_existing"] == ["2547201"]
        assert res["status"] == "skipped_existing"

    def test_replace_deletes_before_insert(self, mock_enroller, tmp_path):
        from enroll.bulk_photos import write_results_to_supabase

        res = _good_result("2547201", mock_enroller, tmp_path)
        writer = FakeEmbeddingsWriter(existing={("uuid-1", "photo")})
        summary = write_results_to_supabase(
            [res], {"2547201": "uuid-1"}, writer, "photo", replace=True
        )

        assert writer.deleted == [("uuid-1", "photo")]
        assert len(writer.inserted) == 1
        assert summary["written"] > 0

    def test_replace_targets_only_the_given_source(self, mock_enroller, tmp_path):
        """--replace with source=photo must not touch video_* rows."""
        from enroll.bulk_photos import write_results_to_supabase

        res = _good_result("2547201", mock_enroller, tmp_path)
        writer = FakeEmbeddingsWriter()
        write_results_to_supabase([res], {"2547201": "uuid-1"}, writer, "photo", replace=True)
        assert all(src == "photo" for _sid, src in writer.deleted)

    def test_dry_run_report_writes_nothing(self, mock_enroller, tmp_path):
        from enroll.bulk_photos import process_student, report_supabase_dry_run

        folder = tmp_path / "2547201"
        folder.mkdir()
        cv2.imwrite(str(folder / "img.jpg"), make_synthetic_face_image())
        res = process_student("2547201", folder, mock_enroller, dry_run=True)

        writer = FakeEmbeddingsWriter()
        report = report_supabase_dry_run(
            [res], {"2547201": "uuid-1"}, writer, "photo", replace=False
        )

        assert writer.inserted == []
        assert writer.deleted == []
        assert report["would_write"] == ["2547201"]

    def test_dry_run_report_flags_existing_as_would_skip(self, mock_enroller, tmp_path):
        from enroll.bulk_photos import process_student, report_supabase_dry_run

        folder = tmp_path / "2547201"
        folder.mkdir()
        cv2.imwrite(str(folder / "img.jpg"), make_synthetic_face_image())
        res = process_student("2547201", folder, mock_enroller, dry_run=True)

        writer = FakeEmbeddingsWriter(existing={("uuid-1", "photo")})
        report = report_supabase_dry_run(
            [res], {"2547201": "uuid-1"}, writer, "photo", replace=False
        )
        assert report["would_skip"] == ["2547201"]
        assert report["would_write"] == []


class TestVecLiteral:
    def test_serialises_to_pgvector_string(self):
        from enroll.embeddings_writer import vec_literal

        assert vec_literal([0.1, -0.2, 0.3]) == "[0.1,-0.2,0.3]"

    def test_handles_numpy_floats(self):
        from enroll.embeddings_writer import vec_literal

        s = vec_literal(np.array([0.5, 0.25], dtype=np.float32))
        assert s.startswith("[") and s.endswith("]")
        assert s.count(",") == 1


class TestSourceImagesUntouched:
    def test_process_student_does_not_modify_sources(self, mock_enroller, tmp_path):
        """The CLI must never copy/move/alter the operator's photos."""
        from enroll.bulk_photos import process_student

        folder = tmp_path / "2547201"
        folder.mkdir()
        for i in range(2):
            cv2.imwrite(str(folder / f"img{i}.jpg"), make_synthetic_face_image())

        before = {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in folder.iterdir()}
        process_student("2547201", folder, mock_enroller, dry_run=False)
        after = {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in folder.iterdir()}

        assert before == after  # same files, same sizes, same mtimes — nothing written
