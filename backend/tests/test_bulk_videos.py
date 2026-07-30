"""Tests for bulk video enrollment (synthetic frames, no real video, no network)."""

from __future__ import annotations

import numpy as np
import pytest

from tests.test_bulk_photos import (
    FakeDetector,
    FakeEmbeddingsWriter,
    make_synthetic_face_image,
)


@pytest.fixture
def mock_enroller():
    from enroll.pipeline import Enroller, GateConfig

    enroller = Enroller.__new__(Enroller)
    enroller.cfg = GateConfig()
    enroller.degrade = True
    enroller.degrade_heights = (96, 64)
    enroller.jpeg_quality = 40
    enroller.blur_sigma = 0.6
    enroller.detector = FakeDetector()
    enroller.embedder = _RandEmbedder()
    return enroller


class _RandEmbedder:
    def embed(self, img: np.ndarray, det) -> np.ndarray:
        vec = np.random.randn(512).astype(np.float32)
        return vec / np.linalg.norm(vec)


def _patch_frames(monkeypatch, n_frames: int) -> None:
    """Replace video decoding with n synthetic face frames (no real file read)."""
    frames = [make_synthetic_face_image() for _ in range(n_frames)]
    monkeypatch.setattr("enroll.bulk_videos.frames_from_video", lambda path, fps=3.0: list(frames))


class TestProcessStudentVideos:
    def test_produces_embeddings(self, mock_enroller, tmp_path, monkeypatch):
        from enroll.bulk_videos import process_student_videos

        folder = tmp_path / "2547206"
        folder.mkdir()
        (folder / "clip.mp4").write_bytes(b"fake")  # presence only; decoding is patched
        _patch_frames(monkeypatch, 4)

        result = process_student_videos("2547206", folder, mock_enroller, fps=3.0, dry_run=False)
        assert result["status"] == "ok"
        assert result["videos_found"] == 1
        assert result["frames_extracted"] == 4
        assert result["embeddings_produced"] > 0
        assert "_records" in result

    def test_no_videos_folder(self, mock_enroller, tmp_path):
        from enroll.bulk_videos import process_student_videos

        folder = tmp_path / "empty"
        folder.mkdir()
        result = process_student_videos("empty", folder, mock_enroller, fps=3.0, dry_run=False)
        assert result["status"] == "no_videos"
        assert result["videos_found"] == 0

    def test_no_frames_extracted(self, mock_enroller, tmp_path, monkeypatch):
        from enroll.bulk_videos import process_student_videos

        folder = tmp_path / "2547206"
        folder.mkdir()
        (folder / "clip.mp4").write_bytes(b"fake")
        _patch_frames(monkeypatch, 0)

        result = process_student_videos("2547206", folder, mock_enroller, fps=3.0, dry_run=False)
        assert result["status"] == "no_frames"

    def test_dry_run_computes_but_does_not_carry_records(
        self, mock_enroller, tmp_path, monkeypatch
    ):
        from enroll.bulk_videos import process_student_videos

        folder = tmp_path / "2547206"
        folder.mkdir()
        (folder / "clip.mp4").write_bytes(b"fake")
        _patch_frames(monkeypatch, 3)

        result = process_student_videos("2547206", folder, mock_enroller, fps=3.0, dry_run=True)
        assert result["status"] == "dry_run_ok"
        assert result["embeddings_produced"] > 0  # real count, computed
        assert "_records" not in result  # but nothing to write

    def test_source_files_untouched(self, mock_enroller, tmp_path, monkeypatch):
        from enroll.bulk_videos import process_student_videos

        folder = tmp_path / "2547206"
        folder.mkdir()
        clip = folder / "clip.mp4"
        clip.write_bytes(b"fake-video-bytes")
        _patch_frames(monkeypatch, 3)

        before = (clip.stat().st_size, clip.stat().st_mtime_ns)
        process_student_videos("2547206", folder, mock_enroller, fps=3.0, dry_run=False)
        after = (clip.stat().st_size, clip.stat().st_mtime_ns)
        assert before == after  # video was read only, never rewritten


class TestVideoSupabaseWrite:
    def test_video_source_tag_flows_to_writer(self, mock_enroller, tmp_path, monkeypatch):
        """The shared write path tags video embeddings with source='video'."""
        from enroll.bulk_photos import write_results_to_supabase
        from enroll.bulk_videos import process_student_videos

        folder = tmp_path / "2547206"
        folder.mkdir()
        (folder / "clip.mp4").write_bytes(b"fake")
        _patch_frames(monkeypatch, 4)

        res = process_student_videos("2547206", folder, mock_enroller, fps=3.0, dry_run=False)
        writer = FakeEmbeddingsWriter()
        summary = write_results_to_supabase(
            [res], {"2547206": "uuid-6"}, writer, "video", replace=False
        )

        assert summary["written"] == res["embeddings_produced"]
        assert writer.inserted == [("uuid-6", "video", res["embeddings_produced"])]

    def test_replace_video_leaves_photo_untouched(self, mock_enroller, tmp_path, monkeypatch):
        """--replace on source=video must not delete the student's photo rows."""
        from enroll.bulk_photos import write_results_to_supabase
        from enroll.bulk_videos import process_student_videos

        folder = tmp_path / "2547206"
        folder.mkdir()
        (folder / "clip.mp4").write_bytes(b"fake")
        _patch_frames(monkeypatch, 4)

        res = process_student_videos("2547206", folder, mock_enroller, fps=3.0, dry_run=False)
        # Student already has both photo and video rows.
        writer = FakeEmbeddingsWriter(existing={("uuid-6", "photo"), ("uuid-6", "video")})
        write_results_to_supabase([res], {"2547206": "uuid-6"}, writer, "video", replace=True)

        assert writer.deleted == [("uuid-6", "video")]  # only video cleared
        assert ("uuid-6", "photo") in writer.existing  # photo anchors survive
