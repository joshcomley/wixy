# The standalone deployment target's image (spec/independence/03 §1) — also the
# fleet's own image-boot CI proof (03 §5). ONE image serves both editions
# (decisions/00051 #6): WIXY_EDITION (settings.py, default "fleet") and every other
# edition-specific env var (WIXY_CONTAINERIZED, WIXY_STORAGE_ROOT, WIXY_PORT) are
# deliberately NOT baked here — they're supplied by docker-compose.yml for a real
# standalone deployment, or by the CI proof's `docker run -e ...`, never fixed at
# build time. Baking them here would silently reintroduce the standalone/fleet
# image drift decision 6 exists to prevent.

FROM python:3.14-slim

# Build-time provenance (spec/independence/01 §2.6, 03 §1): /api/version prefers
# these over a git-shell fallback, which a pip-installed image (no .git dir) can't
# do at all. Empty defaults are correct for a manual `docker build` with no CI
# context; the publish workflow always passes real values.
ARG WIXY_ENGINE_SHA=""
ARG WIXY_SYNC_BASE=""
ENV WIXY_ENGINE_SHA=${WIXY_ENGINE_SHA} \
    WIXY_SYNC_BASE=${WIXY_SYNC_BASE} \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# git — the site-repo/engine-fork checkout manager (wixy_server/checkout.py).
# ffmpeg — media processing (spec/independence/03 §1).
# openssh-client — SSH-URL checkouts (WIXY_SITE_REPO, 01 §2.2: run_git disables
#   credential helpers, so HTTPS+token isn't an option; deploy keys need SSH).
# ca-certificates — TLS to GitHub/GHCR/Anthropic.
# curl — the healthcheck below, and the guide's own one-liner pattern for parity.
# gnupg — needed by the NodeSource setup script below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ffmpeg \
      openssh-client \
      ca-certificates \
      curl \
      gnupg \
    && rm -rf /var/lib/apt/lists/*

# Node LTS — the Agent SDK worker (milestone 6) wraps the Node-based Claude Code
# CLI. Baked into this one image now (rather than added only when M6 lands) so
# "one image, both editions" never needs a second build stage or a rebuild that
# changes the base layer everyone else already pulled.
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version

# Pin github.com's host key (spec/independence/01 §2.2) so the SSH-URL site-repo/
# engine-fork checkouts never hit an interactive (and here, un-answerable) host-key
# prompt on first connection.
RUN mkdir -p /etc/ssh \
    && ssh-keyscan -t rsa,ecdsa,ed25519 github.com >> /etc/ssh/ssh_known_hosts 2>/dev/null

WORKDIR /app

# Copy only what pip needs to resolve + install first so the dependency layer
# stays cached across source-only changes; `projects/*.json` is the committed
# default project template both editions ship (WIXY_SITE_REPO/WIXY_DOMAIN/
# WIXY_INDEXABLE override it at runtime for a different owner's deployment,
# wixy_server/registry.py). No `admin-ui/`/`editor/` source and no node build
# here — the frontend bundles under wixy_server/static/ are already committed
# (repo CLAUDE.md: "Frontend bundles are committed; CI fails on drift"), so
# COPY wixy_server/ below picks them up as plain static files.
COPY pyproject.toml ./
COPY builder/ ./builder/
COPY wixy_server/ ./wixy_server/
COPY projects/ ./projects/
RUN pip install --no-cache-dir ".[server]"

# Non-root (spec/independence/03 §4 Fable checklist item). /data is the
# conventional mount point for WIXY_STORAGE_ROOT (03 §2) — pre-created and
# owned here so a bind/volume mount inherits correct permissions, and so the
# CI image-boot proof (which runs with no volume at all) still has a writable
# storage root using the image's own ephemeral layer.
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin wixy \
    && mkdir -p /data \
    && chown -R wixy:wixy /app /data
USER wixy

# Documentation only (settings.py's own default is 8000; WIXY_PORT overrides it
# at runtime, e.g. docker-compose.yml's 9380) — EXPOSE does not itself bind or
# publish anything.
EXPOSE 8000

# Shell form deliberately (not the JSON array form): $WIXY_PORT must expand at
# container-RUNTIME (when compose/`docker run` has actually set it), not at
# image-build time, so the same image's healthcheck is correct under either
# edition's own port choice.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${WIXY_PORT:-8000}/healthz" || exit 1

CMD ["python", "-m", "wixy_server"]
