"""Bulk-enroll students from DSLR photos (one folder per reg_no).

Usage:
  sensepro-enroll-photos --photos-dir ~/sensepro-enrollment/photos --dry-run
  sensepro-enroll-photos --photos-dir ~/sensepro-enrollment/photos --out enrollments.json
  sensepro-enroll-photos --photos-dir ~/sensepro-enrollment/photos --supabase

Each subfolder name is a student reg_no (e.g. 2547201/) containing 2-3 images.
The CLI:
  - Runs the EXISTING quality gate + degrade-augmentation (ON by default)
  - Maps reg_no -> students table (skips unmatched; never creates rows)
  - Writes to a JSON file (--out) OR straight to Supabase pgvector (--supabase),
    tagging each embedding with --source (default 'photo')
  - Idempotent: with --supabase, an already-enrolled student is skipped unless
    --replace is given
  - NEVER copies, moves, or deletes source images
  - Supports --dry-run for validation without writing embeddings
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

import cv2
import numpy as np

from enroll.pipeline import Enroller, blur_var, pose_bin

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
logger = logging.getLogger("sensepro.bulk_photos")


def force_utf8_stdio() -> None:
    """Make stdout/stderr UTF-8 so the status glyphs below don't crash on a
    cp1252 Windows console (the default), which cannot encode ✓ ✗ ⚠ → ≥ ×."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8")
            except (ValueError, OSError):
                pass


# Image extensions to accept
IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp"}

MIN_USABLE_EMBEDDINGS = 6  # ~2 photos × 3 variants (original + 2 degraded)


def load_students_map(supabase_url: str | None, supabase_key: str | None) -> dict[str, str]:
    """Load reg_no -> student UUID from Supabase, or return empty dict if unconfigured."""
    if not supabase_url or not supabase_key:
        logger.warning(
            "Supabase not configured — skipping reg_no validation (all will be accepted)"
        )
        return {}

    try:
        import httpx

        resp = httpx.get(
            f"{supabase_url}/rest/v1/students?select=id,reg_no",
            headers={
                "apikey": supabase_key,
                "Authorization": f"Bearer {supabase_key}",
            },
            timeout=10,
        )
        resp.raise_for_status()
        rows = resp.json()
        return {r["reg_no"]: r["id"] for r in rows}
    except Exception as e:
        logger.warning(
            "Could not fetch students from Supabase: %s — proceeding without validation", e
        )
        return {}


def validate_image(path: Path, enroller: Enroller) -> tuple[bool, str, np.ndarray | None]:
    """Validate a single image through the quality gate.

    Returns (accepted, reason, frame_or_None).
    """
    img = cv2.imread(str(path))
    if img is None:
        return False, "cannot read image file", None

    if img.shape[0] < 50 or img.shape[1] < 50:
        return False, f"image too small ({img.shape[1]}x{img.shape[0]})", None

    dets = enroller.detector.detect(img, max_num=1)  # enrol = single main subject
    if len(dets) == 0:
        return False, "no face detected", None

    det = dets[0]
    if det.face_px_height < enroller.cfg.min_face_px:
        return (
            False,
            f"face too small ({det.face_px_height}px < {enroller.cfg.min_face_px}px)",
            None,
        )

    x1, y1, x2, y2 = det.box
    crop = img[max(0, y1) : max(1, y2), max(0, x1) : max(1, x2)]
    if crop.size == 0:
        return False, "empty crop", None

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    bv = blur_var(gray)
    if bv < enroller.cfg.min_blur_var:
        return False, f"too blurry (variance {bv:.1f} < {enroller.cfg.min_blur_var})", None

    brightness = float(gray.mean())
    if brightness < enroller.cfg.min_brightness:
        return (
            False,
            f"too dark (brightness {brightness:.0f} < {enroller.cfg.min_brightness})",
            None,
        )
    if brightness > enroller.cfg.max_brightness:
        return (
            False,
            f"too bright (brightness {brightness:.0f} > {enroller.cfg.max_brightness})",
            None,
        )

    pbin = pose_bin(det, img.shape[1])
    return True, f"ok (pose={pbin}, blur={bv:.0f}, brightness={brightness:.0f})", img


def process_student(
    reg_no: str,
    folder: Path,
    enroller: Enroller,
    dry_run: bool,
) -> dict:
    """Process one student folder. Returns a summary dict."""
    result = {
        "reg_no": reg_no,
        "folder": str(folder),
        "images_found": 0,
        "images_accepted": 0,
        "images_rejected": 0,
        "rejections": [],
        "embeddings_produced": 0,
        "pose_bins": [],
        "status": "pending",
    }

    # Collect image files
    image_files = sorted(
        p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMG_EXTS
    )
    result["images_found"] = len(image_files)

    if not image_files:
        result["status"] = "no_images"
        return result

    # Validate each image
    accepted_frames: list[np.ndarray] = []
    for img_path in image_files:
        ok, reason, frame = validate_image(img_path, enroller)
        if ok and frame is not None:
            result["images_accepted"] += 1
            accepted_frames.append(frame)
        else:
            result["images_rejected"] += 1
            result["rejections"].append({"file": img_path.name, "reason": reason})

    if not accepted_frames:
        result["status"] = "all_rejected"
        return result

    if dry_run:
        # Estimate embedding count: accepted × (1 clean + len(degrade_heights) variants)
        variants_per = 1 + (len(enroller.degrade_heights) if enroller.degrade else 0)
        result["embeddings_produced"] = len(accepted_frames) * variants_per
        result["status"] = "dry_run_ok"
        return result

    # Run enrollment pipeline. Detailed records carry pose_bin + quality so the
    # rows satisfy the embeddings table's NOT NULL columns.
    records = enroller.enroll_frames_detailed(accepted_frames)
    result["embeddings_produced"] = len(records)
    result["pose_bins"] = sorted({r.pose_bin for r in records})

    if not records:
        result["status"] = "no_embeddings"
    else:
        result["status"] = "ok"
        result["_records"] = records  # carried for writing, not printed

    return result


def write_results_to_supabase(
    results: list[dict],
    students_map: dict[str, str],
    writer,
    source: str,
    replace: bool,
) -> dict:
    """Push each student's embeddings to pgvector.

    Honors --replace (clear this source's rows first); otherwise a student
    already enrolled from this source is skipped, never duplicated. ``writer``
    is any object exposing has_source_rows/delete_source_rows/insert_embeddings
    (a fake in tests, EmbeddingsWriter in production)."""
    written = 0
    skipped_existing: list[str] = []
    for r in results:
        records = r.get("_records")
        if not records:
            continue
        student_id = students_map[r["reg_no"]]
        if not replace and writer.has_source_rows(student_id, source):
            skipped_existing.append(r["reg_no"])
            r["status"] = "skipped_existing"
            continue
        if replace:
            writer.delete_source_rows(student_id, source)
        n = writer.insert_embeddings(student_id, source, records)
        r["embeddings_written"] = n
        written += n
    return {"written": written, "skipped_existing": skipped_existing}


def report_supabase_dry_run(
    results: list[dict],
    students_map: dict[str, str],
    writer,
    source: str,
    replace: bool,
) -> dict:
    """Read-only: report which students would be written vs skipped, no writes."""
    would_write: list[str] = []
    would_skip: list[str] = []
    for r in results:
        if r["status"] != "dry_run_ok" or r["embeddings_produced"] == 0:
            continue
        student_id = students_map[r["reg_no"]]
        if writer.has_source_rows(student_id, source) and not replace:
            would_skip.append(r["reg_no"])
        else:
            would_write.append(r["reg_no"])
    return {"would_write": would_write, "would_skip": would_skip}


def main() -> None:
    force_utf8_stdio()
    ap = argparse.ArgumentParser(
        description="SensePro+ bulk photo enrollment (no training; embeddings only)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Example:
  python -m enroll.bulk_photos --photos-dir D:/enrollment/photos --dry-run
  python -m enroll.bulk_photos --photos-dir D:/enrollment/photos --out enrollments.json
        """,
    )
    ap.add_argument(
        "--photos-dir",
        required=True,
        help="Directory with subfolders named by reg_no, each containing 2-3 images",
    )
    ap.add_argument("--out", default="enrollments.json", help="Output JSON file for embeddings")
    ap.add_argument(
        "--supabase",
        action="store_true",
        help="Write embeddings straight to Supabase pgvector instead of the JSON file "
        "(requires SUPABASE_URL + SUPABASE_SECRET_KEY and migration 0008)",
    )
    ap.add_argument(
        "--source",
        choices=("photo", "video_knee", "video_waist"),
        default="photo",
        help="Provenance tag stored on each embedding (default: photo)",
    )
    ap.add_argument(
        "--replace",
        action="store_true",
        help="With --supabase, clear a student's existing rows for this source before "
        "inserting (default: skip already-enrolled students, never duplicate)",
    )
    ap.add_argument("--dry-run", action="store_true", help="Validate only, don't write embeddings")
    ap.add_argument(
        "--no-degrade",
        dest="degrade",
        action="store_false",
        help="Disable degrade-augmentation (default: ON — critical for DSLR→board-camera matching)",
    )
    ap.add_argument(
        "--min-embeddings",
        type=int,
        default=MIN_USABLE_EMBEDDINGS,
        help=f"Warn if a student has fewer than N usable embeddings (default: {MIN_USABLE_EMBEDDINGS})",
    )
    args = ap.parse_args()

    photos_dir = Path(args.photos_dir)
    if not photos_dir.is_dir():
        print(f"ERROR: {photos_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    # Find student folders
    student_folders = sorted(
        d for d in photos_dir.iterdir() if d.is_dir() and not d.name.startswith("_")
    )
    if not student_folders:
        print(f"ERROR: No student folders found in {photos_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"\n{'=' * 60}")
    print("  SensePro+ Bulk Photo Enrollment")
    print(f"  Photos dir:  {photos_dir}")
    print(f"  Students:    {len(student_folders)}")
    print(f"  Degrade aug: {'ON' if args.degrade else 'OFF'}")
    print(f"  Target:      {'Supabase pgvector' if args.supabase else f'JSON ({args.out})'}")
    print(f"  Source tag:  {args.source}")
    mode = "DRY RUN" if args.dry_run else "LIVE"
    if args.replace and args.supabase:
        mode += " + REPLACE"
    print(f"  Mode:        {mode}")
    print(f"{'=' * 60}\n")

    # Resolve the write path up front so credential/schema problems fail fast,
    # before the heavy vision-model load.
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

    # Initialize enroller
    print("Loading vision models...")
    enroller = Enroller(degrade=args.degrade)
    print("Models loaded.\n")

    results: list[dict] = []
    skipped_no_match: list[str] = []

    for folder in student_folders:
        reg_no = folder.name
        print(f"  [{reg_no}] ", end="", flush=True)

        # Check reg_no mapping
        if students_map and reg_no not in students_map:
            print("SKIPPED — no matching student row in database")
            skipped_no_match.append(reg_no)
            continue

        result = process_student(reg_no, folder, enroller, args.dry_run)
        results.append(result)

        status_emoji = {
            "ok": "✓",
            "dry_run_ok": "✓ (dry)",
            "no_images": "✗ no images",
            "all_rejected": "✗ all rejected",
            "no_embeddings": "✗ no embeddings",
        }.get(result["status"], "?")

        pb = f"  bins: {','.join(result['pose_bins'])}" if result["pose_bins"] else ""
        print(
            f"{status_emoji}  "
            f"images: {result['images_accepted']}/{result['images_found']} accepted  "
            f"embeddings: {result['embeddings_produced']}{pb}"
        )

        if result["rejections"]:
            for rej in result["rejections"]:
                print(f"      ✗ {rej['file']}: {rej['reason']}")

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
                # If Supabase mapping is available, use the student UUID
                if students_map and key in students_map:
                    key = students_map[key]
                data[key] = [rec.vec for rec in r["_records"]]
                written += 1
        out_path.write_text(json.dumps(data))
        print(f"\n  Embeddings written to {out_path} ({written} students)")

    # Summary
    print(f"\n{'=' * 60}")
    print("  SUMMARY")
    print(f"{'=' * 60}")

    total_accepted = sum(r["images_accepted"] for r in results)
    total_rejected = sum(r["images_rejected"] for r in results)
    total_embeddings = sum(r["embeddings_produced"] for r in results)

    print(f"  Students processed:  {len(results)}")
    print(f"  Images accepted:     {total_accepted}")
    print(f"  Images rejected:     {total_rejected}")
    print(f"  Embeddings produced: {total_embeddings}")

    if skipped_no_match:
        print(f"\n  ⚠ SKIPPED (no student row): {', '.join(skipped_no_match)}")

    # Warn about low-embedding students
    low_emb = [
        r
        for r in results
        if r["embeddings_produced"] < args.min_embeddings and r["status"] not in ("no_images",)
    ]
    if low_emb:
        print(
            f"\n  ⚠ WARNING: {len(low_emb)} student(s) have fewer than {args.min_embeddings} embeddings:"
        )
        for r in low_emb:
            print(
                f"      {r['reg_no']}: {r['embeddings_produced']} embeddings — consider re-capture or video enrollment"
            )

    failed = [r for r in results if r["status"] in ("all_rejected", "no_embeddings", "no_images")]
    if failed:
        print(f"\n  ✗ FAILED: {len(failed)} student(s):")
        for r in failed:
            print(f"      {r['reg_no']}: {r['status']}")

    print("\n  NOTE: Source images were READ ONLY — no files were copied, moved, or deleted.")
    print(f"{'=' * 60}\n")

    if writer is not None:
        writer.close()


if __name__ == "__main__":
    main()
