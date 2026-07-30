# Chapter 6 — Testing & Evaluation

## 6.1 Evaluation Methodology

All metrics are produced by the evaluation harness (`backend/eval/`) running against a recorded classroom clip with hand-labelled ground truth. No numbers are fabricated or hardcoded.

### 6.1.1 Ground Truth Format

```json
{
  "present": {
    "<student_id>": [[start_s, end_s], ...],
    ...
  },
  "phone_windows": [[start_s, end_s], ...]
}
```

### 6.1.2 Test Conditions

- **Camera:** [TODO: camera model and position]
- **Distance:** [TODO: approximate student distances from camera]
- **Lighting:** [TODO: classroom lighting conditions]
- **Enrollment source:** DSLR photos with degrade-augmentation ON
- **Cosine threshold:** 0.45
- **Re-ID interval:** 30 seconds

## 6.2 Recognition Accuracy

| Student | Zone | Hit Rate | Frames (truth) | Frames (matched) |
|---------|------|----------|----------------|------------------|
| [TODO: measured values from eval harness] | | | | |

**Overall hit rate:** [TODO: measured value]

**False-accept rate** (marking an absent person as present): [TODO: measured value]

### 6.2.1 Distance/Zone Analysis

| Zone | Avg Distance | Hit Rate | Coverage |
|------|-------------|----------|----------|
| Front (0–2m) | [TODO] | [TODO] | [TODO] |
| Mid (2–4m) | [TODO] | [TODO] | [TODO] |
| Back (4–6m) | [TODO] | [TODO] | [TODO] |

## 6.3 Presence Duration Accuracy

| Student | Truth (min) | Measured (min) | Error (min) |
|---------|------------|----------------|-------------|
| [TODO: measured values from eval harness] | | | |

**Mean duration error:** [TODO: measured value] min per 60-min session

**Median duration error:** [TODO: measured value] min per 60-min session

## 6.4 Proctor False-Positive Reduction

| Metric | Filter OFF | Filter ON |
|--------|-----------|-----------|
| True positives | [TODO] | [TODO] |
| False positives | [TODO] | [TODO] |
| **FP reduction** | — | **[TODO]%** |

The gaze-down suppression filter is the measurable improvement. The eval harness runs the same clip twice: once with the pitch threshold at −25° (ON) and once with a threshold no head can reach (OFF). The difference in false positives proves (or disproves) the filter's value.

## 6.5 Latency

| Metric | Value |
|--------|-------|
| Frame → result (p50) | [TODO: measured] ms |
| Frame → result (p95) | [TODO: measured] ms |
| Frame → dashboard (p50) | [TODO: measured if measurable] ms |

## 6.6 Unit Test Coverage

The backend test suite covers:

| Module | Tests | Status |
|--------|-------|--------|
| Presence FSM | `test_presence_fsm.py` | [TODO: pass/fail] |
| Presence writer | `test_presence_writer.py` | [TODO: pass/fail] |
| Integration (presence) | `test_integration_presence.py` | [TODO: pass/fail] |
| Engagement (VNEI) | `test_engagement.py` | [TODO: pass/fail] |
| Proctor engine | `test_proctor.py` | [TODO: pass/fail] |
| Enrollment degrade | `test_enroll_degrade.py` | [TODO: pass/fail] |
| Bulk photo enrollment | `test_bulk_photos.py` | [TODO: pass/fail] |
| Embedding store | `test_embedding_store.py` | [TODO: pass/fail] |
| WebSocket capture | `test_ws_capture.py` | [TODO: pass/fail] |
| RTSP session | `test_rtsp_session.py` | [TODO: pass/fail] |
| Eval harness | `test_eval.py` | [TODO: pass/fail] |

Frontend build: [TODO: pass/fail]

## 6.7 Honest Limitations

1. **Single-classroom only.** Not tested with multiple simultaneous sessions.
2. **Distance ceiling.** Recognition accuracy at >6m is expected to degrade significantly.
3. **Lighting sensitivity.** Low-light and backlighting conditions not systematically tested.
4. **Demographic bias.** ArcFace has known performance variations across demographics; we do not claim uniform accuracy.
5. **Spoofing.** No liveness detection in the current version.
6. **Sample size.** [TODO: number of enrolled students] enrolled; statistical significance limited.
