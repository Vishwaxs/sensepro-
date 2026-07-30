"""Bulk-enroll students from short videos (one folder per reg_no).

Usage:
  sensepro-enroll-videos --videos-dir ~/sensepro-enrollment/Videos --dry-run
  sensepro-enroll-videos --videos-dir ~/sensepro-enrollment/Videos --supabase

Each subfolder name is a student reg_no (e.g. 2547206/) holding one or more
short clips. Videos add multi-angle / side-face / distance templates on top of
the DSLR 'photo' anchors, so the recogniser marks a student PRESENT faster and
more confidently. The matcher uses every template a student has.

The CLI:
  - Extracts frames in memory (raw video/frames are NEVER copied or persisted)
  - Runs the EXISTING quality gate + degrade-augmentation (ON by default)
  - Maps reg_no -> students table (skips unmatched; never creates rows)
  - Writes to a JSON file (--out) OR straight to Supabase pgvector (--supabase),
    tagging each embedding with --source (default 'video'; needs migration 0009)
  - Idempotent: with --supabase, an already-enrolled student is skipped unless
    --replace is given
  - Supports --dry-run for validation without writing embeddings
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from enroll.bulk_photos import (
    force_utf8_stdio,
    load_students_map,
    report_supabase_dry_run,
    write_results_to_supabase,
)
from enroll.pipeline import Enroller, frames_from_video

# Container formats OpenCV can usually read; iPhone "Most Compatible" is .mov/.mp4
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}

MIN_USABLE_EMBEDDINGS = 6


def process_student_videos(
    reg_no: str,
    folder: Path,
    enroller: Enroller,
    fps: float,
    dry_run: bool,
) -> dict:
    """Process one student's video folder. Returns a summary dict.

    Frames are extracted in memory only; nothing is written back to the folder.
    In --dry-run the embeddings are still computed (so the count and pose-bin
    coverage are real, not guessed) but never persisted."""
    result = {
        "reg_no": reg_no,
        "folder": str(folder),
        "videos_found": 0,
        "frames_extracted": 0,
        "embeddings_produced": 0,
        "pose_bins": [],
        "status": "pending",
    }

    video_files = sorted(
        p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_EXTS
    )
    result["videos_found"] = len(video_files)
    if not video_files:
        result["status"] = "no_videos"
        return result

    frames = []
    for vf in video_files:
        frames.extend(frames_from_video(str(vf), fps=fps))
    result["frames_extracted"] = len(frames)
    if not frames:
        result["status"] = "no_frames"
        return result

    records = enroller.enroll_frames_detailed(frames)
    del frames  # free the in-memory frames as soon as we have embeddings
    result["embeddings_produced"] = len(records)
    result["pose_bins"] = sorted({r.pose_bin for r in records})

    if not records:
        result["status"] = "no_embeddings"
        return result

    result["status"] = "dry_run_ok" if dry_run else "ok"
    if not dry_run:
        result["_records"] = records  # carried for writing, not printed
    return result


def main() -> None:
    force_utf8_stdio()
    ap = argparse.ArgumentParser(
        description="SensePro+ bulk video enrollment (no training; embeddings only)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Example:
  sensepro-enroll-videos --videos-dir D:/enrollment/Videos --dry-run
  sensepro-enroll-videos --videos-dir D:/enrollment/Videos --supabase --replace
        """,
    )
    ap.add_argument(
        "--videos-dir",
        required=True,
        help="Directory with subfolders named by reg_no, each holding one or more clips",
    )
    ap.add_argument("--out", default="enrollments.json", help="Output JSON file for embeddings")
    ap.add_argument(
        "--supabase",
        action="store_true",
        help="Write embeddings straight to Supabase pgvector instead of the JSON file "
        "(requires SUPABASE_URL + SUPABASE_SECRET_KEY and migrations 0008 + 0009)",
    )
    ap.add_argument(
        "--source",
        choices=("video", "video_knee", "video_waist"),
        default="video",
        help="Provenance tag stored on each embedding (default: video)",
    )
    ap.add_argument(
        "--replace",
        action="store_true",
        help="With --supabase, clear a student's existing rows for this source before "
        "inserting (default: skip already-enrolled students, never duplicate)",
    )
    ap.add_argument("--dry-run", action="store_true", help="Validate only, don't write embeddings")
    ap.add_argument(
        "--fps", type=float, default=3.0, help="Frames per second to sample (default: 3)"
    )
    ap.add_argument(
        "--no-degrade",
        dest="degrade",
        action="store_false",
        help="Disable degrade-augmentation (default: ON — bridges the board-camera distance gap)",
    )
    ap.add_argument(
        "--min-embeddings",
        type=int,
        default=MIN_USABLE_EMBEDDINGS,
        help=f"Warn if a student has fewer than N usable embeddings (default: {MIN_USABLE_EMBEDDINGS})",
    )
    args = ap.parse_args()

    videos_dir = Path(args.videos_dir)
    if not videos_dir.is_dir():
        print(f"ERROR: {videos_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    student_folders = sorted(
        d for d in videos_dir.iterdir() if d.is_dir() and not d.name.startswith("_")
    )
    if not student_folders:
        print(f"ERROR: No student folders found in {videos_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"\n{'=' * 60}")
    print("  SensePro+ Bulk Video Enrollment")
    print(f"  Videos dir:  {videos_dir}")
    print(f"  Students:    {len(student_folders)}")
    print(f"  Degrade aug: {'ON' if args.degrade else 'OFF'}")
    print(f"  Sample fps:  {args.fps}")
    print(f"  Target:      {'Supabase pgvector' if args.supabase else f'JSON ({args.out})'}")
    print(f"  Source tag:  {args.source}")
    mode = "DRY RUN" if args.dry_run else "LIVE"
    if args.replace and args.supabase:
        mode += " + REPLACE"
    print(f"  Mode:        {mode}")
    print(f"{'=' * 60}\n")

    # Resolve the write path up front so credential/schema problems fail fast.
    writer = None
    if args.supabase:
        from enroll.embeddings_writer import EmbeddingsWriterError, build_embeddings_writer

        try:
            writer = build_embeddings_writer()
            writer.assert_source_column()
            students_map = writer.reg_no_to_id()
        except EmbeddingsWriterError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            sys.exit(1)
        if not students_map:
            print(
                "ERROR: no students found in Supabase — cannot map reg_no to student rows.",
                file=sys.stderr,
            )
            writer.close()
            sys.exit(1)
    else:
        supabase_url = os.environ.get("SUPABASE_URL")
        supabase_key = os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_ANON_KEY")
        students_map = load_students_map(supabase_url, supabase_key)

    print("Loading vision models...")
    enroller = Enroller(degrade=args.degrade)
    print("Models loaded.\n")

    results: list[dict] = []
    skipped_no_match: list[str] = []

    for folder in student_folders:
        reg_no = folder.name
        print(f"  [{reg_no}] ", end="", flush=True)

        if students_map and reg_no not in students_map:
            print("SKIPPED — no matching student row in database")
            skipped_no_match.append(reg_no)
            continue

        result = process_student_videos(reg_no, folder, enroller, args.fps, args.dry_run)
        results.append(result)

        status_emoji = {
            "ok": "✓",
            "dry_run_ok": "✓ (dry)",
            "no_videos": "✗ no videos",
            "no_frames": "✗ no frames",
            "no_embeddings": "✗ no embeddings",
        }.get(result["status"], "?")

        pb = f"  bins: {','.join(result['pose_bins'])}" if result["pose_bins"] else ""
        print(
            f"{status_emoji}  "
            f"videos: {result['videos_found']}  frames: {result['frames_extracted']}  "
            f"embeddings: {result['embeddings_produced']}{pb}"
        )

    # Write embeddings (unless dry run)
    if args.dry_run:
        if args.supabase and writer is not None:
            dr = report_supabase_dry_run(results, students_map, writer, args.source, args.replace)
            print(
                f"\n  DRY RUN (Supabase): would write {len(dr['would_write'])} student(s), "
                f"source={args.source}"
            )
            if dr["would_skip"]:
                print(
                    f"  Would skip (already enrolled from {args.source}; use --replace): "
                    f"{', '.join(dr['would_skip'])}"
                )
    elif args.supabase and writer is not None:
        summary = write_results_to_supabase(
            results, students_map, writer, args.source, args.replace
        )
        print(f"\n  Embeddings written to Supabase: {summary['written']} (source={args.source})")
        if summary["skipped_existing"]:
            print(
                f"  Skipped (already enrolled from {args.source}; use --replace): "
                f"{', '.join(summary['skipped_existing'])}"
            )
    else:
        out_path = Path(args.out)
        data: dict = json.loads(out_path.read_text()) if out_path.exists() else {}
        written = 0
        for r in results:
            if "_records" in r:
                key = r["reg_no"]
                if students_map and key in students_map:
                    key = students_map[key]
                # Merge with any existing templates (e.g. photo) under this key.
                data.setdefault(key, [])
                data[key].extend(rec.vec for rec in r["_records"])
                written += 1
        out_path.write_text(json.dumps(data))
        print(f"\n  Embeddings written to {out_path} ({written} students)")

    # Summary
    print(f"\n{'=' * 60}")
    print("  SUMMARY")
    print(f"{'=' * 60}")

    total_frames = sum(r["frames_extracted"] for r in results)
    total_embeddings = sum(r["embeddings_produced"] for r in results)

    print(f"  Students processed:  {len(results)}")
    print(f"  Frames extracted:    {total_frames}")
    print(f"  Embeddings produced: {total_embeddings}")

    if skipped_no_match:
        print(f"\n  ⚠ SKIPPED (no student row): {', '.join(skipped_no_match)}")

    low_emb = [
        r
        for r in results
        if r["embeddings_produced"] < args.min_embeddings and r["status"] not in ("no_videos",)
    ]
    if low_emb:
        print(
            f"\n  ⚠ WARNING: {len(low_emb)} student(s) have fewer than {args.min_embeddings} embeddings:"
        )
        for r in low_emb:
            print(
                f"      {r['reg_no']}: {r['embeddings_produced']} embeddings — re-record with more head turns"
            )

    failed = [r for r in results if r["status"] in ("no_videos", "no_frames", "no_embeddings")]
    if failed:
        print(f"\n  ✗ FAILED: {len(failed)} student(s):")
        for r in failed:
            print(f"      {r['reg_no']}: {r['status']}")

    print(
        "\n  NOTE: Videos/frames were processed IN MEMORY — no file was copied, moved, or deleted."
    )
    print(f"{'=' * 60}\n")

    if writer is not None:
        writer.close()


if __name__ == "__main__":
    main()
