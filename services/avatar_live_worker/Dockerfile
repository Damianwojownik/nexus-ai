FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04

ARG DEBIAN_FRONTEND=noninteractive
ARG MUSETALK_COMMIT=0a89dec45a0192b824e3cf4daf96c239440c5ed8

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.10 python3.10-venv python3-pip git ffmpeg build-essential ca-certificates curl \
    libglib2.0-0 libsm6 libxext6 libxrender1 \
  && rm -rf /var/lib/apt/lists/*

RUN python3.10 -m venv /opt/nexus-live-venv
ENV PATH="/opt/nexus-live-venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NEXUS_MUSETALK_DIR=/opt/MuseTalk \
    NEXUS_LIVE_WORKER_HOST=0.0.0.0 \
    NEXUS_LIVE_WORKER_PORT=9874 \
    NEXUS_LIVE_RENDER_FPS=25 \
    NEXUS_LIVE_MAX_SESSIONS=1 \
    NEXUS_LIVE_AUDIO_WINDOW_MS=480

RUN git clone https://github.com/TMElyralab/MuseTalk.git /opt/MuseTalk \
 && git -C /opt/MuseTalk checkout --detach "$MUSETALK_COMMIT" \
 && test "$(git -C /opt/MuseTalk rev-parse HEAD)" = "$MUSETALK_COMMIT"

RUN python -m pip install --upgrade pip setuptools wheel \
 && pip install torch==2.0.1 torchvision==0.15.2 torchaudio==2.0.2 --index-url https://download.pytorch.org/whl/cu118 \
 && pip install -r /opt/MuseTalk/requirements.txt \
 && pip install --upgrade openmim \
 && mim install mmengine \
 && mim install "mmcv==2.0.1" \
 && mim install "mmdet==3.1.0" \
 && mim install "mmpose==1.1.0"

WORKDIR /app
COPY services/avatar_live_worker/requirements.txt /app/services/avatar_live_worker/requirements.txt
RUN pip install -r /app/services/avatar_live_worker/requirements.txt \
 && pip install "huggingface_hub==0.30.2" gdown

COPY services/avatar_live_worker /app/services/avatar_live_worker
COPY public/avatars/references/nexus-librarian /app/public/avatars/references/nexus-librarian

RUN python /app/services/avatar_live_worker/download_models.py --musetalk-dir /opt/MuseTalk

EXPOSE 9874
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD test -n "$NEXUS_LIVE_AVATAR_WORKER_TOKEN" || exit 1

CMD ["python", "/app/services/avatar_live_worker/worker.py"]
