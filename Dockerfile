# Build the Afluence Miro web bundles from this repository.
FROM node:22-bookworm-slim AS frontend-build

WORKDIR /app
ENV CI=true

# Railway's source archive has no .git directory, so declare its injected
# commit variable explicitly for the bundler's revision marker.
ARG RAILWAY_GIT_COMMIT_SHA=afluence-miro
ENV GITHUB_SHA=${RAILWAY_GIT_COMMIT_SHA}

COPY . .

RUN corepack enable && yarn install --immutable
RUN yarn affine build --package @affine/web --deps
RUN yarn affine build --package @affine/admin --deps
# Rspack resolves every supported native target while bundling the server.
# The production x64 binding is replaced below with the release Rust build.
RUN touch packages/backend/native/server-native.arm64.node \
  packages/backend/native/server-native.armv7.node \
  packages/backend/native/server-native.x64.node
RUN yarn workspace @affine/server build

# The upstream image ships a precompiled server-native binding. Build the
# binding from this checkout as well so backend fixes (including BYOK
# diagnostics) are actually present at runtime.
FROM rust:1.97-bookworm AS native-build

RUN apt-get update \
  && apt-get install -y --no-install-recommends clang cmake pkg-config \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# Keep the expensive fat-LTO build independent from the web workspace.  These
# are every Cargo workspace member plus the root manifests, toolchain, and
# Cargo configuration; copying a member directory also retains its build
# scripts, migrations, fixtures, and include_{str,bytes}! inputs.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY .cargo/config.toml ./.cargo/config.toml
COPY packages/backend/native ./packages/backend/native
COPY packages/common/native ./packages/common/native
COPY packages/frontend/mobile-native ./packages/frontend/mobile-native
COPY packages/frontend/native ./packages/frontend/native

# tree-sitter currently requires this compatibility define on Linux builds.
ENV CC="clang -D_BSD_SOURCE"

RUN cargo build --release --package affine_server_native \
  && install -D -m 755 target/release/libaffine_server_native.so /out/server-native.x64.node

# `canary` is built from the same current AFFiNE line as these web bundles.
# Keeping the frontend and backend on this channel prevents AI BYOK GraphQL
# schema drift; the native binding above supplies this checkout's backend fix.
FROM ghcr.io/toeverything/affine:canary

COPY --from=frontend-build /app/packages/frontend/apps/web/dist /app/static
COPY --from=frontend-build /app/packages/frontend/admin/dist /app/static/admin
COPY --from=frontend-build /app/packages/frontend/core/public/ /app/static/mobile/
COPY --from=frontend-build /app/packages/backend/server/dist /app/dist
# The canary runtime can lag behind this checkout's queue integration. Keep
# the queue packages in sync with the server bundle compiled above.
COPY --from=frontend-build /app/node_modules/@nestjs/bullmq /app/node_modules/@nestjs/bullmq
COPY --from=frontend-build /app/node_modules/@nestjs/bull-shared /app/node_modules/@nestjs/bull-shared
COPY --from=frontend-build /app/node_modules/bullmq /app/node_modules/bullmq
COPY --from=native-build /out/server-native.x64.node /app/dist/server-native.x64.node
COPY scripts/render-afluence-config.mjs /app/scripts/render-afluence-config.mjs
COPY --chmod=755 scripts/start-afluence.sh /app/scripts/start-afluence.sh
