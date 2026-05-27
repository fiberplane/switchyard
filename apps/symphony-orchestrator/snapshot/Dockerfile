# Production-style Daytona snapshot for the Symphony orchestrator.
#
# Image name: `symphony-codex-bun` (set in WORKFLOW.md). Workers dispatched
# into sandboxes built from this image must be able to run the same gates the
# host runs: `bun run test`, `bun run format:check`, `bun run check`,
# `bun run lint:drift`. Anything missing here means the worker ships unverified
# diffs (see SWYRD-fktyqemh).
#
# Build via: `bun run --filter @switchyard/symphony-orchestrator snapshot:build`
# (which invokes apps/symphony-orchestrator/snapshot/build.ts).

FROM ubuntu:22.04

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive
ENV BUN_INSTALL=/usr/local

# Base system + language runtimes + repo verification tools that get pulled
# from system packages or one-shot installers.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates coreutils curl gh git jq procps ripgrep sudo tar unzip \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && npm install -g @openai/codex@0.128.0 \
  && curl -fsSL https://bun.sh/install | bash \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://setup.fp.dev/install.sh | sh -s -- --version latest --install-dir /usr/local/bin \
  && fp --version

# ast-grep: prebuilt release binary keeps us off the npm-postinstall path
# (which collides with util-linux's /usr/bin/sg). Arch-aware via TARGETARCH.
ARG ASTGREP_VERSION=0.42.1
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) sg_arch=x86_64 ;; \
      arm64) sg_arch=aarch64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/ast-grep/ast-grep/releases/download/${ASTGREP_VERSION}/app-${sg_arch}-unknown-linux-gnu.zip" \
      -o /tmp/ast-grep.zip; \
    unzip -j /tmp/ast-grep.zip 'ast-grep' -d /usr/local/bin; \
    rm /tmp/ast-grep.zip; \
    chmod +x /usr/local/bin/ast-grep; \
    ln -sf /usr/local/bin/ast-grep /usr/local/bin/sg; \
    ast-grep --version

# drift: prebuilt release binary, arch-aware via Docker BuildKit's TARGETARCH.
ARG DRIFT_VERSION=0.9.1
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) drift_arch=x86_64 ;; \
      arm64) drift_arch=aarch64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/fiberplane/drift/releases/download/v${DRIFT_VERSION}/drift-${drift_arch}-linux.tar.gz" \
      -o /tmp/drift.tar.gz; \
    tar -xzf /tmp/drift.tar.gz -C /usr/local/bin; \
    rm /tmp/drift.tar.gz; \
    drift --version

RUN useradd -m daytona \
  && echo "daytona ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/91-daytona \
  && mkdir -p /workspace \
  && chown daytona:daytona /workspace

WORKDIR /workspace

USER daytona

# Fail the build early if any worker-required binary is missing from PATH for
# the daytona user (the user the orchestrator's worker process runs as).
RUN bun --version \
  && drift --version \
  && codex --version \
  && fp --version \
  && gh --version \
  && rg --version \
  && bash --version \
  && curl --version \
  && jq --version \
  && sg --version \
  && git --version \
  && node --version

ENTRYPOINT ["sleep", "infinity"]
