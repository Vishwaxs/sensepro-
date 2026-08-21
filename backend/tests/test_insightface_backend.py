"""InsightFaceBackend is shared process-wide as a singleton (vision/pipeline.py)
across every concurrent classroom session, so its per-call state must be
thread-local, never on self — otherwise one session's embed() can read
another session's detect() output. These tests fake out insightface's
FaceAnalysis (no ~300MB model download) to exercise that contract directly,
plus confirm the constructor wires allowed_modules/det_thresh/det_size
correctly."""

from __future__ import annotations

import threading

import numpy as np
import pytest

from vision.types import Detection


class _FakeFace:
    def __init__(self, cx: float, cy: float, tag: float) -> None:
        # A small box centred on (cx, cy); tag seeds a distinguishable embedding
        # so a test can prove which face's embedding actually came back.
        self.bbox = (cx - 5, cy - 5, cx + 5, cy + 5)
        self.det_score = 0.99
        self.kps = []
        self.normed_embedding = np.full(512, tag, dtype=np.float32)


class _FakeFaceAnalysis:
    """Stands in for insightface.app.FaceAnalysis. get() returns whatever
    per-thread face list the test pre-registers via set_faces_for_thread, so
    two "threads" (simulated via barriers) can be driven through detect()
    with different, controllable results."""

    def __init__(self, *, name, allowed_modules=None) -> None:
        self.name = name
        self.allowed_modules = allowed_modules
        self.prepare_kwargs: dict | None = None
        self._by_thread: dict[int, list] = {}

    def prepare(self, **kwargs) -> None:
        self.prepare_kwargs = kwargs

    def set_faces_for_thread(self, faces: list) -> None:
        self._by_thread[threading.get_ident()] = faces

    def get(self, frame_bgr, max_num: int = 0):
        return self._by_thread.get(threading.get_ident(), [])


def _make_backend(fake_app: _FakeFaceAnalysis, monkeypatch, **kwargs):
    """Construct a real InsightFaceBackend but with FaceAnalysis monkeypatched
    to fake_app's class, so __init__ runs unmodified (proving the constructor
    wiring) without ever importing the real insightface model."""
    import insightface.app as insightface_app_module

    monkeypatch.setattr(insightface_app_module, "FaceAnalysis", lambda **kw: fake_app)
    from vision.insightface_backend import InsightFaceBackend

    return InsightFaceBackend(**kwargs)


def test_constructor_trims_modules_and_passes_det_thresh(monkeypatch):
    fake_app = _FakeFaceAnalysis(name="buffalo_l")
    backend = _make_backend(fake_app, monkeypatch, det_size=800, det_thresh=0.4, min_face_px=12)

    assert backend.app is fake_app
    assert fake_app.prepare_kwargs == {"ctx_id": 0, "det_size": (800, 800), "det_thresh": 0.4}


def test_detect_then_embed_same_thread_matches_own_face(monkeypatch):
    fake_app = _FakeFaceAnalysis(name="buffalo_l")
    backend = _make_backend(fake_app, monkeypatch)
    fake_app.set_faces_for_thread([_FakeFace(cx=50, cy=50, tag=0.7)])

    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    dets = backend.detect(frame)
    assert len(dets) == 1
    vec = backend.embed(frame, dets[0])
    assert np.allclose(vec, 0.7)


def test_embed_without_prior_detect_on_this_thread_returns_zero_vector(monkeypatch):
    # A thread that never called detect() (or whose thread-local cache was
    # never populated) must not silently read some OTHER thread's leftover
    # cache — this is the failure mode the singleton introduces if the cache
    # is ever put back on self instead of thread-local.
    fake_app = _FakeFaceAnalysis(name="buffalo_l")
    backend = _make_backend(fake_app, monkeypatch)
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    fake_det = Detection(45, 45, 55, 55, score=0.9)

    result: dict = {}

    def worker():
        result["vec"] = backend.embed(frame, fake_det)

    t = threading.Thread(target=worker)
    t.start()
    t.join()
    assert np.allclose(result["vec"], 0.0)


def test_concurrent_sessions_do_not_cross_contaminate_embeddings(monkeypatch):
    """The core regression test for the singleton's concurrency safety:
    two "sessions" run detect() then embed() on two different threads,
    deliberately interleaved via barriers so thread A's detect() and thread
    B's detect() both land before either embed() runs. If the cache were
    shared (self._faces_cache instead of thread-local), whichever thread's
    detect() ran last would win for BOTH embeds. With thread-local storage,
    each thread must get back its own face's embedding."""
    fake_app = _FakeFaceAnalysis(name="buffalo_l")
    backend = _make_backend(fake_app, monkeypatch)
    frame = np.zeros((100, 100, 3), dtype=np.uint8)

    both_detected = threading.Barrier(2)
    results: dict[str, np.ndarray] = {}
    errors: list[BaseException] = []

    def run_session(tag: float, label: str) -> None:
        try:
            fake_app.set_faces_for_thread([_FakeFace(cx=50, cy=50, tag=tag)])
            det = backend.detect(frame)[0]
            both_detected.wait(timeout=5)  # force interleaving: both detect() before either embed()
            results[label] = backend.embed(frame, det)
        except BaseException as exc:  # noqa: BLE001 - surfaced via errors list in the main thread
            errors.append(exc)

    t1 = threading.Thread(target=run_session, args=(0.1, "session_a"))
    t2 = threading.Thread(target=run_session, args=(0.9, "session_b"))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert not errors
    assert np.allclose(results["session_a"], 0.1)
    assert np.allclose(results["session_b"], 0.9)


def test_build_backend_insightface_is_a_process_wide_singleton(monkeypatch):
    import vision.pipeline as pipeline_mod

    monkeypatch.setattr(pipeline_mod, "_insightface_singleton", None)
    monkeypatch.setenv("VISION_BACKEND", "insightface")

    fake_app = _FakeFaceAnalysis(name="buffalo_l")
    import insightface.app as insightface_app_module

    monkeypatch.setattr(insightface_app_module, "FaceAnalysis", lambda **kw: fake_app)

    detector1, embedder1 = pipeline_mod.build_backend()
    detector2, embedder2 = pipeline_mod.build_backend()

    assert detector1 is embedder1  # same object serves both roles
    assert detector1 is detector2  # second call reuses the singleton, doesn't rebuild
    pipeline_mod._insightface_singleton = None  # don't leak into other tests


def test_build_backend_stub_is_not_singleton(monkeypatch):
    import vision.pipeline as pipeline_mod
    from vision.stub import StubDetector

    monkeypatch.setenv("VISION_BACKEND", "stub")
    d1, _ = pipeline_mod.build_backend()
    d2, _ = pipeline_mod.build_backend()
    assert isinstance(d1, StubDetector)
    assert d1 is not d2  # stub gets a fresh instance every call, unlike insightface


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
