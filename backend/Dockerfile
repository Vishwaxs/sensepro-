# SensePro+ inference backend.
#
# Built for a container host with ~1 GB of RAM (Google Cloud Run at 2 GiB, a
# small VM, Railway, Fly). Measured peak RSS for this workload:
#   InsightFace det+rec only, one 1080p frame ......... 402 MB
#   + YOLOv8n proctor pass ............................ 718 MB
# so a 512 MB instance (Render / Koyeb free tier) is OOM-killed on model load
# and is not a supported target. Set VISION_BACKEND=stub if you must run
# somewhere that small: you get the API and every dashboard, but no real
# recognition.
#
# Both model caches are warmed during the BUILD, never at runtime. Left to the
# first request, InsightFace pulls buffalo_l (~275 MB) on the opening capture
# socket and Ultralytics pulls yolov8n.pt on the first exam session (~45 s for
# that fetch and load alone). That stalls the first real class and repeats on
# every cold start, because the container filesystem is ephemeral.

FROM python:3.12-slim

# libgl1 + libglib2.0-0: OpenCV (pulled in by insightface) links against them
#   even for headless decoding and fails at import without them.
# build-essential: insightface publishes no wheels, so pip compiles it from
#   source; Cython and numpy must already be present when that build starts.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependency layer first: it is by far the slowest step (insightface compiles),
# so keep it cached across ordinary source edits.
COPY pyproject.toml ./
RUN pip install --upgrade pip setuptools wheel \
    && pip install "cython<4" "numpy<2" \
    && pip install ".[insightface,supabase,proctor]"

COPY . .
RUN pip install --no-deps -e .

# Create the runtime user BEFORE warming the caches, and warm them AS that user.
# This ordering is load-bearing: insightface hardcodes root='~/.insightface' and
# expanduser()s it (see insightface/utils/storage.py) — it honours no env var —
# so weights fetched while root would land in /root/.insightface and be invisible
# to this user, silently restoring the 275 MB runtime download the build exists
# to prevent. Ultralytics does respect env vars, so its two directories are
# pinned explicitly.
RUN useradd --create-home --uid 10001 sensepro
USER sensepro
ENV HOME=/home/sensepro \
    YOLO_CONFIG_DIR=/home/sensepro/.cache/ultralytics \
    PROCTOR_MODEL_PATH=/home/sensepro/.cache/sensepro/yolov8n.pt

# ctx_id=-1 forces CPU so the build never looks for a GPU. allowed_modules
# matches vision/insightface_backend.py exactly: pulling only detection +
# recognition skips the landmark and genderage models this app never runs,
# which is worth ~160 MB of resident memory.
RUN mkdir -p /home/sensepro/.cache/sensepro \
    && python -c "from ultralytics import YOLO; YOLO('/home/sensepro/.cache/sensepro/yolov8n.pt')" \
    && python -c "from insightface.app import FaceAnalysis; \
FaceAnalysis(name='buffalo_l', allowed_modules=['detection','recognition']).prepare(ctx_id=-1, det_size=(640,640))" \
    && test -f /home/sensepro/.insightface/models/buffalo_l/w600k_r50.onnx

# Cloud Run injects PORT (8080). The default keeps `docker run` working locally.
ENV PORT=8080
EXPOSE 8080

# ONE worker, deliberately. Each worker loads its own copy of the models, so a
# second would add ~700 MB for no throughput gain: inference already runs in a
# threadpool off the event loop, and the bottleneck is CPU, not accepting
# connections.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1 --timeout-keep-alive 75"]
