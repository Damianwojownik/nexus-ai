FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NEXUS_LIVE_AVATAR_HOST=0.0.0.0

WORKDIR /app
COPY services/avatar_live/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY services/avatar_live/nexus_live_avatar_server.py /app/nexus_live_avatar_server.py

USER 10001:10001
EXPOSE 9873
CMD ["python", "/app/nexus_live_avatar_server.py", "--host", "0.0.0.0", "--port", "9873"]
