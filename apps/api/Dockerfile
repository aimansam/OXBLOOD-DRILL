# syntax=docker/dockerfile:1.7
FROM python:3.12-slim-bookworm AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY apps/api/pyproject.toml ./
# Dependencies come from pyproject.toml (single source of truth); psycopg2 is
# added for the sync Alembic driver used by prestart.py.
RUN python - <<'PY' > /build/requirements.txt
import tomllib
deps = tomllib.load(open("pyproject.toml", "rb"))["project"]["dependencies"]
print("\n".join([*deps, "psycopg2-binary>=2.9.9", "argon2-cffi-bindings"]))
PY
RUN pip install --upgrade pip && \
    pip wheel --wheel-dir=/wheels -r /build/requirements.txt && \
    cp /build/requirements.txt /wheels/requirements.txt

# --- runtime stage ---
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 curl tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 divide

COPY --from=builder /wheels /wheels
RUN pip install --no-index --find-links=/wheels -r /wheels/requirements.txt \
    && rm -rf /wheels /root/.cache

COPY apps/api/app ./app
COPY apps/api/scripts ./scripts
RUN chmod +x ./scripts/prestart.py
COPY apps/api/alembic ./alembic
COPY apps/api/alembic.ini ./alembic.ini
# JSON Schema is shared with the host. We bundle a copy at /app/schemas so
# the schema-sync service works inside the container without a host mount.
COPY schemas ./schemas
# Setup wizard portal (vanilla HTML + JS). Mounted at /portal/ by main.py.
COPY apps/portal ./portal
USER divide

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://localhost:8000/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
# Q1 fix: run alembic upgrade head via prestart.py before uvicorn.
# This way a fresh install (empty DB) gets tables created automatically,
# and existing installs get new migrations applied on container start.
CMD ["python", "/app/scripts/prestart.py"]
