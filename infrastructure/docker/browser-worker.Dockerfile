# syntax=docker/dockerfile:1
#
# Browser Use worker.
#
# Chromium makes this image large. It remains isolated, unprivileged, and free
# of application secrets because it visits hostile content by design.

ARG PYTHON_VERSION=3.12

FROM python:${PYTHON_VERSION}-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

WORKDIR /app

# dumb-init forwards SIGTERM so Python can close browsers gracefully.
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

COPY services/browser-worker/pyproject.toml ./
COPY services/browser-worker/app ./app

RUN pip install --no-cache-dir "." \
    && python -m playwright install --with-deps chromium \
    && useradd --create-home --uid 10001 worker \
    && chown -R worker:worker /app /opt/playwright

USER worker
EXPOSE 8100

# Liveness opens no browser, so a slow Chromium cannot cause restart loops.
HEALTHCHECK --interval=20s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8100/v1/health', timeout=4).status==200 else 1)"

ENTRYPOINT ["dumb-init", "--"]
CMD ["uvicorn", "app.main:build", "--factory", "--host", "0.0.0.0", "--port", "8100"]
