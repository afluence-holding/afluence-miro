# Build the product UI from this repository. Railway previously extended the
# upstream AFFiNE image directly, which meant every Afluence Miro source change
# was ignored at deploy time.
FROM node:22-bookworm-slim AS frontend-build

WORKDIR /app
ENV CI=true

COPY . .

RUN corepack enable && yarn install --immutable
RUN yarn affine build --package @affine/web --deps
RUN yarn affine build --package @affine/admin --deps

# Keep the supported AFFiNE self-host server runtime, but replace its web and
# admin bundles with the Afluence Miro bundles built above.
FROM ghcr.io/toeverything/affine:stable

COPY --from=frontend-build /app/packages/frontend/apps/web/dist /app/static
COPY --from=frontend-build /app/packages/frontend/admin/dist /app/static/admin
