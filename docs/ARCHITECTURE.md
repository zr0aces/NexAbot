# Architecture and recovery

The external reverse proxy terminates TLS for NexAbot and forwards requests to the published host port (`WEB_PORT`, default 8068), mapped to port 8080 in the web container. Nginx serves React and forwards same-origin API calls to Fastify. Bundled Caddy is disabled in this deployment. See [proxy addresses](DOCKER_DEPLOYMENT.md). PostgreSQL owns state, Redis/BullMQ delivers work, and one dedicated worker shares two private volumes with the API.

1. Verify the exact signed webhook bytes before parsing. In one transaction, record the event ID, serialize group membership decisions, insert a unique (channel destination, message ID) image and create its outbox record. A new group is disabled. Leave disables collection. Only new group images received while authorized qualify. No user IDs, reply tokens, message text or full event payloads are stored.
2. The dispatcher uses the outbox ID as the BullMQ job ID. Publication is not acknowledgement: the row stays until processing checkpoints commit. Unacknowledged rows are republished after a minute, including after Redis loss. Download jobs take priority over uploads. One global worker slot serializes Google creation for this account.
3. Stream into an exclusive partial file, bound bytes, inspect MIME/dimensions, compute SHA-256, rename atomically, and persist STAGED. Generate 320/640 fit-inside WebP previews. Reinspect and hash before streaming unchanged LINE bytes to Google.
4. A durable compare-and-set creation flag and unique album mapping protect the group ID, independent of its name. Unknown album creation is held for review, not blindly repeated. Check item count before upload and individual provider errors afterward.
5. Persist CREATING_MEDIA before batchCreate. Use the destination album ID and deterministic filename based on the internal image UUID. Success requires a Google media ID in the database. After a lost response, search all pages of the app-created destination album. Adopt exactly one filename match. Zero or multiple matches mean NEEDS_REVIEW. No uncertain retry creates media.

## State machine

RECEIVED → DOWNLOAD_PENDING → DOWNLOADING → STAGED → UPLOAD_PENDING → UPLOADING → CREATING_MEDIA → SYNCED. Updates check expected state; SQL also prevents syncing without a media ID. Transient failures enter RETRY_PENDING with capped exponential backoff, jitter and a Retry-After floor. FAILED includes actionable OAuth, storage or capacity blocks. Expired LINE content and invalid files become UNRECOVERABLE. Bounded automatic retries cannot loop forever. NEEDS_REVIEW retry only reconciles.

## Storage

Staged synced originals expire 24 hours after upload by default. Failed/uncertain originals have a 7-day **review deadline from ingestion**, not permission to erase data. A dashboard warning starts within 24 hours of that deadline. Files can remain longer until resolved or explicitly discarded by the owner. Discard is audited and durable, never a Google deletion. Thumbnail cache expires by last-touch age (default 30 days). Remote content is fetched by media ID after cache expiry. Abandoned partial files expire after a day.

Low disk rejects new eligible webhooks with a retryable response instead of acknowledging lost images. Check reserve again at download; allow space for the maximum next file. Free-space checks cannot reserve capacity against other writers. Isolate and monitor the volumes.

## Migrations

Greenfield workspace: no legacy data, users or writers. The API applies checked-in Prisma migrations before readiness. The authorization-window migration adds a nullable timestamp and initializes existing enabled groups without dropping data. Stop workers for upgrades; roll back compatible application images without dropping columns. Restoring older metadata requires reconciling Google writes since the backup.
