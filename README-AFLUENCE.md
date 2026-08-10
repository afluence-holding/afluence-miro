# Afluence Miro (AFFiNE self-hosted)

This fork is deployed in Railway project `afluence-tools`, environment `MIRO`.

The production topology is intentionally small and stateful:

- `affine`: official AFFiNE stable image; runs the upstream migration command before each release.
- `Postgres`: the source of truth for workspaces, users and collaboration metadata.
- `Redis`: realtime collaboration and job coordination.
- `/root/.affine/storage`: Railway volume for uploaded documents and media.

The `AFFINE_PRIVATE_KEY` Railway secret must never be rotated casually: it is used
to sign/encrypt application data. Back up both the Postgres database and the
storage volume before an AFFiNE upgrade.

`AFFINE_SERVER_EXTERNAL_URL` must always be the single canonical HTTPS URL. Do
not run multiple replicas until AFFiNE's realtime scaling requirements have been
validated with the target workload.
