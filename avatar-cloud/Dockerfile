FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-dev build-essential git ffmpeg espeak-ng libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/warmshao/FasterLivePortrait.git /opt/FasterLivePortrait && cd /opt/FasterLivePortrait && git checkout 8aad3602177547aaa5e4beec0c3ef5b7944e7a1f
WORKDIR /opt/nexus-avatar
COPY requirements.txt .
RUN python3 -m pip install --no-cache-dir -r requirements.txt
COPY worker.py render.py download_models.py ./
ENV NEXUS_CLOUD_WORKER=1 NEXUS_ENGINE_DIR=/opt/FasterLivePortrait NEXUS_JOB_DIR=/data/jobs
EXPOSE 8000
CMD ["python3", "worker.py"]
