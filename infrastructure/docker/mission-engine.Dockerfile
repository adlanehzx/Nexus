FROM python:3.12.12-slim-bookworm@sha256:27f90d79cc85e9b7b2560063ef44fa0e9eaae7a7c3f5a9f74563065c5477cc24 AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN groupadd --system --gid 10001 nexus \
    && useradd --system --uid 10001 --gid nexus --home-dir /var/lib/nexus nexus

WORKDIR /app
COPY services/mission-engine/pyproject.toml /app/pyproject.toml
COPY services/mission-engine/src /app/src
RUN pip install --no-compile .

USER nexus
EXPOSE 8000
ENTRYPOINT ["nexus-mission-engine"]
