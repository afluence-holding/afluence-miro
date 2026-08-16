# Railway PostgreSQL pool timeout — 2026-08-15

## Symptom

Railway deployment `a86cd45b` failed during AFFiNE's pre-deploy command with:

`StorageRuntime failed to connect postgres: pool timed out while waiting for an open connection`

## Evidence

- The same log shows `BackendRuntimeProvider` successfully started with `db=true` immediately before the failure.
- The failure occurs five seconds later, matching the five-second SQLx acquire timeout in `packages/backend/native/src/runtime/storage_runtime/mod.rs`.
- The storage and backend native runtimes each create an independent PostgreSQL pool of up to five connections (`storage_runtime/mod.rs:85`, `backend_runtime/mod.rs:93`).
- `miro.byafluence.com/info` returned HTTP 200 on 2026-08-16, so Railway retained a healthy previous deployment while the new deployment did not promote.

## Root cause

The Railway PostgreSQL service had exhausted its client-connection limit. An SSH `psql` connection to the linked PostgreSQL service was rejected with `FATAL: sorry, too many clients already`. The deployed service had no Prisma connection cap, while its two native runtimes each allowed pools of five connections. During the pre-deploy overlap, the backend runtime obtained a connection and the storage runtime exhausted its five-second acquisition timeout.

This is unrelated to the Journal removal, OIDC, or a missing `DATABASE_URL`; the configured URL uses Railway's internal PostgreSQL hostname.

## Fix

- Render the Afluence config before the Railway pre-deploy command, so migrations use the same bounded Prisma configuration as the server.
- Configure Prisma with a `connection_limit` of 3 through `AFLUENCE_PRISMA_CONNECTION_LIMIT`.
- Make both native PostgreSQL pools configurable through `AFLUENCE_NATIVE_DB_POOL_MAX_CONNECTIONS` and set it to 2 in Railway.
- Add Railway's `/info` health check to prevent promoting an unhealthy process.

## Verification

- The config renderer test confirmed that Prisma receives `connection_limit=3`.
- `cargo check --package affine_server_native`, `cargo fmt --check --package affine_server_native`, `oxfmt`, `oxlint`, and `git diff --check` passed.
- Railway confirms `AFLUENCE_PRISMA_CONNECTION_LIMIT=3` and `AFLUENCE_NATIVE_DB_POOL_MAX_CONNECTIONS=2` are set without exposing database credentials.
- Railway deployment `4c58bebc-f99f-41c6-a700-66ecc0b61f83` for commit `d374c61fe` completed successfully. Its logs show both `BackendRuntimeProvider` and `StorageRuntimeProvider` started with `db=true`.
- `https://miro.byafluence.com/info` returned HTTP 200 from `AFFiNE 2026.8.16-canary.007` after the deployment.

## Status

FIXED AND VERIFIED IN PRODUCTION.
