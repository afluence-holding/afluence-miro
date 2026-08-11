# syntax=docker/dockerfile:1.7

# Build the whole application from one source revision.  Building only the web
# bundle and then layering it onto ghcr.io/toeverything/affine:stable leaves the
# browser ahead of the GraphQL schema in the server image (notably AI BYOK).
FROM node:22-bookworm-slim AS build

WORKDIR /app
ARG TARGETARCH
ENV CI=true \
    DEBIAN_FRONTEND=noninteractive \
    PATH=/root/.cargo/bin:${PATH}

# The server's native runtime is part of the application contract and must be
# compiled for the same Linux image that runs the Node server.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      clang \
      curl \
      libssl-dev \
      pkg-config && \
    rm -rf /var/lib/apt/lists/* && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal && \
    rustup toolchain install 1.97.1 && \
    rustup default 1.97.1

# The bundler records a revision in index.html. Railway uploads a source archive
# without .git metadata, so use a deterministic build identifier.
ARG GIT_SHA=afluence-miro
ENV GITHUB_SHA=${GIT_SHA}

COPY . .

RUN corepack enable && yarn install --immutable
RUN case "${TARGETARCH}" in \
      amd64) NAPI_TARGET=x86_64-unknown-linux-gnu ;; \
      arm64) NAPI_TARGET=aarch64-unknown-linux-gnu ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    yarn workspace @affine/server-native build --target "${NAPI_TARGET}"
RUN yarn affine build --package @affine/web --deps && \
    yarn affine build --package @affine/admin --deps && \
    yarn workspace @affine/server build

# Match AFFiNE's release image layout: production dependencies and generated
# Prisma client live alongside the server bundle.
RUN yarn workspaces focus @affine/server --production && \
    yarn workspace @affine/server prisma generate && \
    mv ./node_modules ./packages/backend/server/node_modules

FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl libjemalloc2 && \
    rm -rf /var/lib/apt/lists/*

ENV LD_PRELOAD=libjemalloc.so.2

COPY --from=build /app/packages/backend/server /app
COPY --from=build /app/packages/frontend/apps/web/dist /app/static
COPY --from=build /app/packages/frontend/admin/dist /app/static/admin
COPY --from=build /app/packages/frontend/core/public/ /app/static/mobile/

EXPOSE 3010

CMD ["node", "./dist/main.js"]
