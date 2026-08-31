"""Evaluate a recorded clip against ground truth.

    python -m eval.run --clip exam.mp4 --truth truth.json --mode exam

Prints the metric table and writes it to CSV. The clip is read once per pass
(presence, proctor ON, proctor OFF) so nothing is held in memory. Use
VISION_BACKEND=insightface for real numbers; the stub only proves plumbing.
"""

from __future__ import annotations

import argparse
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings
from eval.harness import (
    EvaluationWriter,
    eval_presence,
    eval_proctor,
    iter_clip,
    load_truth,
    print_table,
    report_rows,
    write_csv,
)
from proctor.detector import build_proctor_detector
from proctor.engine import ProctorEngine
from proctor.suppression import GazeSuppressor
from vision.embedding_store import EmbeddingStore
from vision.pipeline import SessionPipeline

NEVER_DOWN_DEG = -1e9  # a threshold no head can reach: the filter-OFF pass


def _load_roster(args: argparse.Namespace) -> EmbeddingStore:
    """Load the gallery once. --supabase reads the real photo + video templates
    from pgvector (same source the live capture path uses); otherwise the
    enrolment JSON. The store is read-only during matching, so every pass can
    share this one instance."""
    if args.supabase:
        if not settings.supabase_enabled:
            raise SystemExit(
                "--supabase needs SUPABASE_URL + SUPABASE_SECRET_KEY (service key) "
                "in the environment/.env."
            )
        return EmbeddingStore.from_supabase(
            settings.supabase_url,
            settings.supabase_secret_key,
            threshold=settings.cosine_threshold,
        )
    path = Path(args.enrollment)
    if path.exists():
        return EmbeddingStore.from_json(path, threshold=settings.cosine_threshold)
    return EmbeddingStore(threshold=settings.cosine_threshold)


def _pipeline(store: EmbeddingStore) -> SessionPipeline:
    return SessionPipeline(
        store=store,
        reid_interval_s=settings.reid_interval_s,
        miss_threshold=settings.miss_threshold,
    )


def _engine(filter_on: bool) -> ProctorEngine:
    return ProctorEngine(
        detector=build_proctor_detector(),
        suppressor=GazeSuppressor(
            window_s=settings.gaze_window_s,
            pitch_down_deg=settings.gaze_pitch_down_deg if filter_on else NEVER_DOWN_DEG,
        ),
        writer=EvaluationWriter(),  # acknowledges in memory; never persists
        session_id="eval",
        session_start=datetime.now(timezone.utc),
        cooldown_s=0.0,  # count every candidate, not the deduped queue
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="eval.run", description=__doc__)
    parser.add_argument("--clip", required=True, help="recorded video file")
    parser.add_argument("--truth", required=True, help="ground-truth JSON")
    parser.add_argument("--mode", choices=("lecture", "exam"), default="lecture")
    parser.add_argument("--enrollment", default=settings.enrollment_json)
    parser.add_argument(
        "--supabase",
        action="store_true",
        help="Load the gallery from Supabase pgvector (real photo + video templates) "
        "instead of the enrolment JSON",
    )
    parser.add_argument("--csv", default="eval_report.csv")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING)  # keep the table readable
    truth = load_truth(args.truth)

    store = _load_roster(args)
    roster_src = "supabase pgvector" if args.supabase else args.enrollment
    print(
        f"conditions: roster={roster_src}  templates={len(store._ids)}  "
        f"students={len(store.roster)}  cosine_threshold={settings.cosine_threshold}  "
        f"vision_backend={os.getenv('VISION_BACKEND', 'stub')}"
    )

    presence = eval_presence(iter_clip(args.clip), _pipeline(store), truth["present"])
    on = off = None
    if args.mode == "exam":
        on = eval_proctor(iter_clip(args.clip), _pipeline(store), _engine(True), truth)
        off = eval_proctor(iter_clip(args.clip), _pipeline(store), _engine(False), truth)

    rows = report_rows(presence, on, off)
    print_table(rows)
    write_csv(rows, args.csv)
    print(f"\nwritten: {args.csv}")


if __name__ == "__main__":
    main()
