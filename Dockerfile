# Build the Afluence Miro web bundles from this repository.
FROM node:22-bookworm-slim AS frontend-build

WORKDIR /app
ENV CI=true

# Railway's source archive has no .git directory, while the bundler records a
# revision in index.html. Supply a deterministic build identifier instead.
ARG GIT_SHA=afluence-miro
ENV GITHUB_SHA=${GIT_SHA}

COPY . .

RUN corepack enable && yarn install --immutable
RUN yarn affine build --package @affine/web --deps
RUN yarn affine build --package @affine/admin --deps

# `canary` is built from the same current AFFiNE line as these web bundles.
# Keeping the frontend and backend on this channel prevents AI BYOK GraphQL
# schema drift, without recompiling the Rust runtime during every deploy.
FROM ghcr.io/toeverything/affine:canary

COPY --from=frontend-build /app/packages/frontend/apps/web/dist /app/static
COPY --from=frontend-build /app/packages/frontend/admin/dist /app/static/admin
COPY --from=frontend-build /app/packages/frontend/core/public/ /app/static/mobile/
