# MPOL Messenger — durable online deployment

This branch prepares the server for a **separate managed PostgreSQL** database. Do **not** merge and deploy until an external database is configured.

## Storage

- Users, sessions, friends, group membership and message history are persisted in PostgreSQL via `MPOL_DATABASE_URL`.
- New attachments are written to `attachment_blobs` in PostgreSQL, rather than the ephemeral Render filesystem. Existing on-disk attachments cannot be recovered if Render already discarded them.
- The service refuses to start with SQLite when `MPOL_REQUIRE_PERSISTENT_DB=1`. This avoids accidentally accepting new accounts on temporary storage.
- The current public server still uses SQLite, and its data is **not durable**.

## Connect an independent database (Neon)

1. Create a free Neon project for MPOL only, separately from RUNIVERSE.
2. Retrieve its **pooled** PostgreSQL connection URI with TLS; do not put it in GitHub, screenshots, or chat messages.
3. In the Render dashboard of the MPOL service, set the following secrets as **environment variables**:
   - `MPOL_DATABASE_URL`: URI in `postgresql+psycopg://...` format; include `sslmode=require`.
   - `MPOL_REQUIRE_PERSISTENT_DB=1`
   - `MPOL_EPHEMERAL_STORAGE=0`
4. Update/render the service from this branch, verify `GET /api/health` returns `{"durable_database":true,"temporary_storage":false}`.
5. Verify two independent sessions, friends, message exchange, and attachments. Restart/redeploy the service and verify data remains.
6. Set up backups, migrations, moderation, retention policy, email recovery and review permissions before public production use.

**Data warning:** Existing accounts on the current Render SQLite instance are not migrated by switching the database URI. Create fresh test accounts. Do not promise preservation for old beta data.

**Platform warning:** A Render free web service can sleep and cause connection delays. PostgreSQL persistence does not guarantee always-on uptime; persistent hosting, backups, rate limits, antivirus/file-scanning and abuse controls require additional work. MPOL is not end-to-end encrypted.
