"""Measure SCRFD detection across send-width × det-size combinations.

Usage:
    python -m eval.measure_detection path/to/group_photo.jpg

For each (send_width, det_size) pair the script:
  1. Resizes the original image to the given send width (preserving aspect ratio).
  2. Runs InsightFace/SCRFD at that det_size.
  3. Reports: faces detected, mean face pixel height, inference milliseconds.

Output: a formatted table to stdout, plus a CSV written next to the image.
Requires VISION_BACKEND=insightface (the real detector).
"""

from __future__ import annotations

import argparse
import csv
import sys
import time
from pathlib import Path

import cv2
import numpy as np

SEND_WIDTHS = [480, 960, 1280, 1920]
DET_SIZES = [640, 960, 1280]


def _resize(img: np.ndarray, target_w: int) -> np.ndarray:
    h, w = img.shape[:2]
    if w == target_w:
        return img
    target_h = int(h * target_w / w)
    return cv2.resize(img, (target_w, target_h), interpolation=cv2.INTER_AREA)


def _measure_one(img: np.ndarray, det_size: int) -> tuple[int, float, float]:
    """Returns (n_faces, mean_face_px_height, inference_ms)."""
    from insightface.app import FaceAnalysis

    app = FaceAnalysis(name="buffalo_l")
    app.prepare(ctx_id=0, det_size=(det_size, det_size))

    t0 = time.perf_counter()
    faces = app.get(img, max_num=0)
    elapsed_ms = (time.perf_counter() - t0) * 1000

    if not faces:
        return 0, 0.0, elapsed_ms

    heights = []
    for f in faces:
        y1, y2 = f.bbox[1], f.bbox[3]
        heights.append(abs(y2 - y1))
    mean_h = float(np.mean(heights))
    return len(faces), mean_h, elapsed_ms


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="eval.measure_detection",
        description="Grid-test send_width × det_size on a classroom photo.",
    )
    parser.add_argument("image", help="Path to the group photo")
    parser.add_argument(
        "--send-widths",
        default=",".join(map(str, SEND_WIDTHS)),
        help=f"Comma-separated send widths (default: {SEND_WIDTHS})",
    )
    parser.add_argument(
        "--det-sizes",
        default=",".join(map(str, DET_SIZES)),
        help=f"Comma-separated det_sizes (default: {DET_SIZES})",
    )
    args = parser.parse_args(argv)

    img_path = Path(args.image)
    if not img_path.exists():
        print(f"ERROR: {img_path} not found", file=sys.stderr)
        sys.exit(1)

    original = cv2.imread(str(img_path))
    if original is None:
        print(f"ERROR: could not read {img_path}", file=sys.stderr)
        sys.exit(1)

    widths = [int(w) for w in args.send_widths.split(",")]
    det_sizes = [int(d) for d in args.det_sizes.split(",")]

    print(f"\nOriginal: {original.shape[1]}×{original.shape[0]}")
    print(f"Testing {len(widths)} widths × {len(det_sizes)} det_sizes\n")

    header = f"{'send_w':>8} {'det_size':>8} {'faces':>6} {'mean_h_px':>10} {'ms':>8}"
    print(header)
    print("-" * len(header))

    rows: list[dict] = []
    for sw in widths:
        resized = _resize(original, sw)
        for ds in det_sizes:
            n_faces, mean_h, ms = _measure_one(resized, ds)
            row = {
                "send_width": sw,
                "det_size": ds,
                "img_h": resized.shape[0],
                "faces": n_faces,
                "mean_face_px_height": round(mean_h, 1),
                "inference_ms": round(ms, 1),
            }
            rows.append(row)
            print(f"{sw:>8} {ds:>8} {n_faces:>6} {mean_h:>10.1f} {ms:>8.1f}")

    csv_path = img_path.with_suffix(".detection_grid.csv")
    with open(csv_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"\nCSV written to {csv_path}")


if __name__ == "__main__":
    main()
