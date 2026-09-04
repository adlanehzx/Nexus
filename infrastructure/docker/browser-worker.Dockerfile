# syntax=docker/dockerfile:1
#
# Browser Use worker.
#
# Image lourde par nature : elle embarque Chromium. Elle est isolée du reste —
# réseau interne sans port publié, aucun secret applicatif, utilisateur non
# privilégié — parce qu'elle visite du contenu hostile par définition.

ARG PYTHON_VERSION=3.12

FROM python:${PYTHON_VERSION}-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

WORKDIR /app

# `dumb-init` en PID 1 : sans lui, SIGTERM n'atteint pas Python et l'arrêt
# gracieux — fermeture des navigateurs — ne s'exécute jamais.
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

# Sonde de liveness : elle n'ouvre aucun navigateur, donc un Chromium lent ne
# provoque pas de redémarrage en boucle.
HEALTHCHECK --interval=20s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8100/v1/health', timeout=4).status==200 else 1)"

ENTRYPOINT ["dumb-init", "--"]
CMD ["uvicorn", "app.main:build", "--factory", "--host", "0.0.0.0", "--port", "8100"]
