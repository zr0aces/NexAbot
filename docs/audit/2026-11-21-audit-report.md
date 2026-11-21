# RivoSnap Full Codebase Engineering Audit Report

- **Audit date:** 2026-11-21 (Asia/Bangkok)
- **Revision audited:** `main` at `6a19bb0` (clean worktree)
- **Scope:** Every tracked first-party file (91 files). This is the first audit after the Go backend migration (`docs/plans/completed/2026-11-21-go-backend-migration.md`); the previous report (`2026-11-20-audit-report.md`) covered the retired TypeScript backend.
- **Coverage verdict:** Full file coverage for source, tests, configuration, build, CI and deployment files. Some runtime behaviors could not be exercised (see §9).

## 1. Executive Summary

### Architecture understood

RivoSnap is a single-owner service that copies new images (and optionally videos) from enabled LINE groups into app-created Google Photos albums.

- **Edge:** An external TLS proxy forwards to one unprivileged Nginx container (`web`, published on `127.0.0.1` and `192.168.8.70` at `WEB_PORT`). Nginx serves the React SPA and proxies `/api/` to the Go API (`infra/docker/web.conf`).
- **API (`rivosnap api`, `cmd/rivosnap/main.go`, `internal/api`):** `net/http` mux with a wrapper that applies an in-memory rate limiter, an Origin + `X-Gallery-Request` CSRF guard and a Redis-backed signed-cookie session check. It verifies the LINE webhook HMAC over raw bytes and ingests events transactionally into PostgreSQL (`WebhookEvent` dedup → `LineGroup` lock → `Image` unique on `(channelId, lineMessageId)` → `OutboxEvent`). It also serves media (local staging/thumbnail files or Google-proxied bytes), OAuth, settings and job actions. Migrations run at startup under an advisory lock.
- **Worker (`rivosnap worker`, `internal/worker`):** One session-level advisory lock makes it a singleton. It claims outbox rows with `FOR UPDATE SKIP LOCKED` and re-claims unacknowledged rows after one minute. Each item moves through the state machine: download from LINE → stage (bounded, inspected, hashed, atomically renamed) → generate thumbnails → upload bytes → `batchCreate` → reconcile on uncertainty. A one-minute maintenance task prunes synced originals, stale `.part` files, old thumbnails and old `WebhookEvent` rows. A Redis heartbeat reports liveness.
- **State:** PostgreSQL 18 (state, outbox, audit), Redis 7 (sessions, OAuth state, heartbeat), two shared volumes (`staging`, `thumbnails`).
- **Frontend (`apps/web`):** React 19 + TanStack Query, polling every 15 s; no client-side secrets.

### Most important risks

1. **Correctness / data loss (CRITICAL, confirmed in production configuration):** `AUD2-001`. Timestamps are stored as `TIMESTAMP WITHOUT TIME ZONE`. PostgreSQL runs with `TimeZone=Asia/Bangkok`, but Go compares against UTC wall-clock values. As a result, **every image sent during the first 7 hours after a group is enabled (or re-enabled) is silently dropped.** I reproduced it by running the repository's own integration test against a Bangkok-timezone Postgres. The live database reports `Asia/Bangkok`.
2. **Security / availability (MEDIUM):** `AUD2-002`. All unauthenticated traffic reaches the API from the Nginx container's address. The login limiter (8 attempts per 5 minutes) is therefore one global bucket, and any internet client can lock the owner out. The webhook bucket key is attacker-chosen.
3. **Resource safety (MEDIUM):** `AUD2-003` and `AUD2-004`. The worker fully decodes every image, which can approach or exceed the 768 MB container limit at the 100 MP ceiling. An OOM kill bypasses the bounded-retry logic, so it repeats every minute. The API spawns an unbounded number of `ffmpeg` processes for on-demand thumbnails.
4. **Operations (MEDIUM):** `AUD2-005`. After an uncertain album creation, every later image in that group fails and must be retried one at a time.
5. **Testing (MEDIUM):** `AUD2-006`. No CI workflow runs the Go tests, typecheck, or integration suite. The release workflow builds and pushes images without running tests. The integration environment uses UTC, unlike production, which is why `AUD2-001` was not caught.

### Areas needing deeper investigation

- Real Google Photos and LINE behavior (quotas, `batchCreate` partial failures, content expiry). All provider calls in the tests are mocked.
- Worker memory under real 50 MB / 100 MP inputs (`AUD2-003`). Measure it rather than infer it.
- A historical data repair for timestamps already written under the Bangkok session timezone (`AUD2-001`, recommended fix step 3).

## 2. Findings

### [AUD2-001] [CRITICAL] — Mixed timezone semantics silently drop images for 7 hours after a group is enabled

- **Category:** Correctness / data loss
- **Location:**
  - `internal/api/ingest.go:27` (`eventDate := time.UnixMilli(e.Timestamp).UTC()`), `:136` (`date.Before(*enabledSince)`)
  - `internal/api/server.go:937` (`"enabledSince" = NOW()`)
  - `packages/database/migrations/202611190001_initial/migration.sql` (all `TIMESTAMP(3)` columns, no time zone)
  - `docker-compose.yml:19`, `:43` and `docs/example-deploy/compose.yml:19`, `:43` (`TZ: Asia/Bangkok` for app containers and Postgres)
  - `internal/db/db.go:32` (pool created without a session `timezone`)
- **Confidence:** High (reproduced; production setting confirmed)
- **Problem:** Columns are `timestamp without time zone`. Postgres was initialized with `TZ=Asia/Bangkok`, so the session `TimeZone` is `Asia/Bangkok`, and `NOW()` stores Bangkok wall-clock time. pgx v5 writes a `time.Time` by keeping its wall clock and discarding the zone (`pgtype/timestamp.go`, `discardTimeZone`). It scans values back labelled as UTC. Ingest stores and compares LINE event times as UTC wall-clock (`ingest.go:27`). `enabledSince` is written by SQL `NOW()`, so it reads back 7 hours ahead of the true instant.
- **Evidence:**
  - A disposable `postgres:18` started with `-e TZ=Asia/Bangkok` returns `SHOW timezone` → `Asia/Bangkok`, and `NOW()::timestamp` is 7 hours ahead of `NOW() AT TIME ZONE 'UTC'`.
  - Running `TestFullPipelineIntegration` against such a Postgres (copy of `scripts/test-integration.sh` with only `-e TZ=Asia/Bangkok` added) fails with `pipeline_test.go:273: expected 1 deduplicated image, got 0`. The unmodified script (UTC Postgres) passes.
  - The running `rivosnap-postgres` container reports `SHOW timezone` → `Asia/Bangkok`. Only this setting was read; no application data was queried.
- **Impact:**
  - **Primary:** After the owner enables collection (and on every pause → re-enable), webhook images received during the next 7 hours fail the `date.Before(enabledSince)` check. They are acknowledged to LINE and recorded as a `PROCESSED` `WebhookEvent`, but no `Image` is created. Nothing is shown to the owner. LINE content expires and LINE does not redeliver acknowledged events, so the images are permanently missed. Onboarding is hit hardest: the owner's first test photo is dropped, and `docs/TROUBLESHOOTING.md` only says to send another image.
  - **Secondary:**
    - `createdAt`, `updatedAt`, `uploadedAt`, audit `createdAt`, attempt times and "Oldest unuploaded" display 7 hours ahead (`workspace.tsx:175`, `:190`).
    - The discard deadline is 7 hours late (`server.go:1709`, `photos.tsx:257`).
    - Synced originals are retained 7 hours longer than configured (`worker.go:647` UTC cutoff vs `uploadedAt` from `NOW()`).
    - `WebhookEvent` pruning is offset (`worker.go:708`).
- **How it can occur:** Normal use. Enable a group in the UI, then send a photo to the group within 7 hours.
- **Recommended fix:**
  1. Pin the session timezone to UTC at the connection layer, independent of host or Postgres configuration: in `db.Connect`, parse the config with `pgxpool.ParseConfig` and set `ConnConfig.RuntimeParams["timezone"] = "UTC"`.
  2. Make every Go-side timestamp explicitly UTC: `worker.go:615` (`time.Now()` → `time.Now().UTC()`), `server.go:1853`, and any other `time.Now()` written to or compared with the database. Today `worker.go:615` is consistent with `NOW()` only because both are in Bangkok time; it would break once step 1 alone is applied.
  3. Add a reviewed, idempotent data-repair migration. Rows written by SQL `NOW()`/`CURRENT_TIMESTAMP` while the session was Bangkok hold Bangkok wall-clock values; rows written from Go `date` values (`lineEventTimestamp`, `lastEventAt`, `membershipAt`) already hold UTC values. At minimum, correct `LineGroup.enabledSince` for rows set via the API. Evaluate other `NOW()`-written columns per column. Rows written by the legacy Prisma backend may follow a different convention, so verify on a restored copy first.
  4. Longer term, migrate to `timestamptz` so the database stores instants.
  5. Make `scripts/test-integration.sh` start Postgres with `TZ=Asia/Bangkok` to match production.
- **Expected impact:** Removes the silent 7-hour ingestion blackout and makes all displayed and compared times correct.

### [AUD2-002] [MEDIUM] — Rate limiting keys on the Nginx peer address; login can be locked out by any internet client

- **Category:** Security / availability
- **Location:**
  - `internal/api/server.go:84-90` (`peerHost`), `:327-337` (global bucket key), `:368` (auth bucket key)
  - `infra/docker/web.conf:14` (`proxy_set_header X-Forwarded-For ""`; no real-IP header forwarded)
  - `internal/api/rate_test.go:12`
- **Confidence:** High (code path); not exercised against the live stack
- **Problem:** Every request reaches the API from the `web` container's socket address, so `peerHost(r.RemoteAddr)` is the same for every visitor.
  - `/auth/login` and `/auth/setup` share one global 8-per-5-minutes bucket.
  - All unauthenticated requests share one 600-per-minute bucket, including `/auth/status` polling from the login page and the web container's own health check.
  - The webhook bucket is keyed by the `X-Line-Signature` header value, which the client chooses. An attacker can rotate it to bypass the limiter and to add one map entry per request, swept only once a minute. Each such request also performs a database read and buffers up to 1 MB.
  - AUD-008 from the previous audit intended "unauthenticated requests by `req.ip`"; behind this Nginx that address is always the proxy's.
- **Evidence:** `web.conf:14` clears `X-Forwarded-For` and sets no `X-Real-IP`. `checkRate` uses only `peerHost`. The unit test asserts that peer-based keying is preserved across ports from the same peer.
- **Impact:** A remote, unauthenticated attacker who sends about 2 bad logins per minute keeps the owner unable to sign in indefinitely. Flooding the unauthenticated bucket makes the SPA show "Cannot reach the gallery". Ingestion keeps working, because signed webhooks use separate keys.
- **How it can occur:** `curl -X POST https://<APP_URL>/api/v1/auth/login -H 'Origin: <APP_URL>' -H 'X-Gallery-Request: 1' -d '{"email":"a@b","password":"x"}'` repeated 8 times per 5 minutes.
- **Recommended fix:**
  - In Nginx, derive the client address from the trusted external proxy (`set_real_ip_from <proxy address>; real_ip_header X-Forwarded-For;`) and forward `proxy_set_header X-Real-IP $remote_addr;`.
  - In Go, honour `X-Real-IP` only when the socket peer is the `web` container network.
  - Key the webhook limiter by peer address rather than by signature, or apply it only to requests whose signature failed.
  - Optionally add a per-account backoff that does not block the legitimate owner, for example by requiring a valid session cookie or a slower path rather than a hard global block.
- **Expected impact:** Login brute-force protection without a global lockout; bounded limiter memory.

### [AUD2-003] [MEDIUM] — Full-image decode in the worker risks OOM crash-loops; strict decode failures discard downloaded bytes

- **Category:** Performance / resource / reliability
- **Location:**
  - `internal/media/media.go:201-213` (full `image.Decode` / `webp.Decode`), `:379` (`defer os.Remove(tmp)`), `:403-410`
  - `internal/worker/worker.go:381`, `:468` (second full inspection before upload), `:231-242` (attempt row inserted before work), `:719-723` (one-minute re-claim)
  - `docker-compose.yml:31` (`mem_limit: 768m`)
- **Confidence:** Medium (memory figures are derived from Go decoder pixel formats, not measured)
- **Problem:** `Inspect` decodes the whole image to detect truncation. The 100 MP limit allows decoded buffers of roughly 150 MB (JPEG 4:2:0), 400 MB (8-bit RGBA PNG) or 800 MB (16-bit PNG, `NRGBA64`). This happens twice per item and on the same 768 MB container as `ffmpeg`. An OOM kill bypasses the failure handler, so no attempt is recorded as failed and the `n < 8` retry cap never applies. The outbox row is re-claimed after one minute and the worker is killed again, indefinitely. Separately, when Go's decoder rejects a file that Google would accept (for example an unsupported JPEG variant), `Stage` deletes the only downloaded copy and the item becomes `UNRECOVERABLE`.
- **Evidence:** Code above. The `ffmpeg` thumbnail step runs in the same process tree.
- **Impact:** One hostile or unusual large image in an enabled group can make the worker restart every minute, slowing all other uploads and making health flap. A decoder false negative loses an original that LINE may no longer serve.
- **How it can occur:** A group member sends a large, highly compressible 16-bit PNG near 10,000×10,000 px that is under `MAX_IMAGE_SIZE_MB`, if LINE delivers it unchanged as an image message.
- **Recommended fix:**
  - Keep `DecodeConfig` plus the pixel limit, and drop the full decode. Google validates the bytes, and the `ffmpeg` thumbnail run already proves the file decodes.
  - Alternatively, run the full check in a memory-capped subprocess.
  - Do not delete the staged temporary file on inspection failure: rename it to a quarantine path and keep `stagingPath`, so the owner can review it and Discard is the only deletion path.
  - Count attempts from the inserted `UploadAttempt` rows that never completed. Mark an item `FAILED` once the count exceeds a threshold, so OOM loops terminate.
- **Expected impact:** Bounded worker memory, guaranteed termination of poison items, no loss of undecodable originals.

### [AUD2-004] [MEDIUM] — Unbounded on-demand `ffmpeg` thumbnail generation in the API request path

- **Category:** Performance / resource
- **Location:**
  - `internal/api/server.go:1530-1550`
  - `internal/media/media.go:319-346`
  - `internal/worker/worker.go:697-704` (thumbnail eviction by mtime, including for still-staged unsynced items)
  - `apps/web/src/photos.tsx:265`, `:359` (36 thumbnails per page)
- **Confidence:** Medium
- **Problem:** When a staged, not-yet-synced item has no cached thumbnail, each request spawns `ffmpeg` with a 30 s timeout. This happens for queue items older than `thumbnailDays`, for items whose thumbnail step failed, and for videos. There is no concurrency limit and no single-flight per `(id, size)`. One page of the gallery or upload queue can start up to 36 decoders of 50 MB / 100 MP originals or 200 MB videos concurrently inside the 768 MB API container. A second tab or a refetch duplicates the work.
- **Evidence:** No semaphore or single-flight around `Store.Thumbnail`. The cleanup loop deletes any `.webp` older than `thumbnailDays` regardless of item state.
- **Impact:** CPU saturation or OOM in the API, which also serves the LINE webhook. A restart there causes webhook 5xx responses and depends on LINE redelivery.
- **How it can occur:** Leave `FAILED`/`NEEDS_REVIEW` items longer than `thumbnailDays`, then open the upload queue.
- **Recommended fix:** Bound thumbnail generation with a small semaphore (for example 2) and `singleflight` keyed by `(id, size)`. Return 503 with `Retry-After` when the semaphore is saturated. Exempt thumbnails of non-synced staged items from age eviction.
- **Expected impact:** Bounded API CPU and memory under gallery load.

### [AUD2-005] [MEDIUM] — An uncertain album creation fails every later image in the group; recovery is one retry per image

- **Category:** Reliability / operations
- **Location:**
  - `internal/worker/worker.go:85-134` (`ResolveAlbum`), `:570-580`
  - `internal/api/server.go:1085-1174` (`handleResolveAlbum`), `:1769-1837` (single-item retry)
  - `apps/web/src/photos.tsx:300-313`
- **Confidence:** High
- **Problem:** A transient network error or 5xx during `albums.create` leaves `albumCreating = true`, which is correct for an uncertain write. After that, every image from the group is downloaded, staged and then moved to `FAILED` with `ALBUM_REVIEW`. `resolve-album` clears the flag but does not re-queue those images. The UI offers only per-item "Retry upload", 36 items per page, with no bulk action.
- **Evidence:** `handleResolveAlbum` updates only `LineGroup` and the audit log. `docs/TROUBLESHOOTING.md` says "Retry the failed image."
- **Impact:** In an active group, one network blip produces hundreds of `FAILED` items that need hundreds of clicks. Originals sit on disk, approach review deadlines, and can trigger disk pressure that pauses all ingestion.
- **How it can occur:** A timeout on the first upload for a new group.
- **Recommended fix:** In the `resolve-album` transaction, move that group's `FAILED` + `errorCode = 'ALBUM_REVIEW'` images to `RETRY_PENDING` and insert `PROCESS` outbox rows, mirroring `handleRetryJob`. Optionally add a filtered bulk retry for `FAILED` items.
- **Expected impact:** One owner action restores the whole group.

### [AUD2-006] [MEDIUM] — No CI test gate; release images are built and pushed without running tests; integration environment differs from production

- **Category:** Testing / delivery
- **Location:**
  - `.github/workflows/release-images.yml:24-55` (only workflow)
  - `scripts/test-integration.sh:3` (UTC Postgres)
  - `internal/db/migrate_test.go:49-50` (comment claims `prisma migrate deploy` ran first; the script no longer does that)
- **Confidence:** High
- **Problem:** No workflow runs `go test ./...`, `go vet`, `corepack pnpm typecheck`/`build`, `node --test scripts/version-control.test.mjs` or the integration suite on pull requests or before publishing. The integration environment omits the production `TZ=Asia/Bangkok`, which hid `AUD2-001`. The "Prisma-initialized upgrade path" test no longer exercises a Prisma-created database; it re-runs Go migrations on a Go-migrated database.
- **Evidence:** One workflow file; it calls only `sync-version --check` and `docker build`.
- **Impact:** Regressions such as `AUD2-001` can ship to GHCR `:latest`, which `docs/example-deploy` consumes.
- **Recommended fix:** Add a PR/push workflow that runs the existing commands, including `bash scripts/test-integration.sh` (it already uses disposable containers). Make the release job depend on the same checks. Run the integration Postgres with `TZ=Asia/Bangkok`. Fix or remove the stale Prisma comment, or restore a real legacy-schema fixture.
- **Expected impact:** Pre-merge detection of pipeline regressions.

### [AUD2-007] [LOW] — `/groups` holds a pooled connection while issuing one query per row (N+1, pool self-deadlock under concurrency)

- **Category:** Performance / reliability
- **Location:** `internal/api/server.go:855-881` (open `rows`), `:824-828` (`QueryRow` per group inside the loop)
- **Confidence:** High for the mechanism; low likelihood
- **Problem:** pgx `rows` keeps its connection until it is closed, and `fetchGroupMap` acquires a second connection for each group. The pool defaults to `max(4, NumCPU)` connections (6 on this host). If 6 or more `/groups` requests arrive at once, each holds one connection and waits for another. They stall until the client disconnects (Nginx default 60 s), and other handlers, including the webhook, wait behind them.
- **Impact:** Rare stalls with several open tabs or devices, since `/groups` is polled every 15 s by four pages. N+1 latency grows with the number of groups.
- **Recommended fix:** Fetch the latest image per group in the same query (`LEFT JOIN LATERAL (... ORDER BY "lineEventTimestamp" DESC LIMIT 1)`). The handler then needs one connection.
- **Expected impact:** One query per request; no nested pool acquisition.

### [AUD2-008] [LOW] — Local video `Range` handling mis-serves suffix ranges and ignores unsatisfiable ranges

- **Category:** Correctness
- **Location:** `internal/api/server.go:1493-1517`
- **Confidence:** High
- **Problem:** `bytes=-N` (the last N bytes) is parsed as `start=0, end=N`, so the server returns the first N+1 bytes with a `206` and a wrong `Content-Range`. Out-of-range or inverted ranges fall through to a full `200` instead of `416`.
- **Impact:** Some players, for example Safari reading MP4 `moov` atoms at the end of a file, may fail to seek or play staged (not yet synced) videos.
- **Recommended fix:** Use `http.ServeContent(w, r, name, modTime, f)`. It implements single and suffix ranges, `416` and conditional requests, and the handler code becomes smaller.
- **Expected impact:** Correct, standard range semantics.

### [AUD2-009] [LOW] — Errors are swallowed into misleading success states

- **Category:** Observability / correctness
- **Location:**
  - `internal/api/server.go:1846-1864` (dashboard counts ignore errors and return zeros)
  - `:419-428` (a database error during login returns 401 "incorrect" instead of 5xx)
  - `:616` (LINE mismatch count error ignored)
  - `internal/db/db.go:156-166` (a failure to decrypt saved LINE credentials silently falls back to environment values)
  - `apps/web/src/data.ts:31` (a non-JSON error body, such as an Nginx 502 page, surfaces as a JSON parse error)
  - `internal/api/server.go:694-735` (OAuth callback failures render raw JSON in a top-level navigation)
- **Confidence:** High
- **Impact:**
  - During a database outage the dashboard reports an empty, healthy queue, and login reports a wrong password.
  - After a `TOKEN_ENCRYPTION_KEY` change, every webhook gets 403 without any operator signal.
  - OAuth failures leave the owner on a raw JSON page.
- **Recommended fix:**
  - Propagate the dashboard query errors (or run a single aggregate query and return 5xx on failure).
  - Separate `ErrNoRows` from other errors on login.
  - Log, without the secret, when saved credentials cannot be decrypted, and show it in `/health`.
  - In `data.ts`, check `content-type` before parsing.
  - Redirect OAuth failures to `/settings?google_error=<code>`.

### [AUD2-010] [LOW] — Worker `GROUP_SUMMARY` paths skip the sanitization the API applies

- **Category:** Consistency / input handling
- **Location:** `internal/worker/worker.go:198`, `:204-212`, `:479-489` vs `internal/api/server.go:1005`, `:1018`
- **Confidence:** High
- **Problem:** The worker builds `group/<id>/summary` without `url.PathEscape` and stores `groupName` without stripping control characters. The API refresh handler does both.
- **Impact:** Limited, because the group ID comes from a signed webhook and album titles are sanitized later by `google.Title`. Control characters can still reach the stored `displayName` and the UI.
- **Recommended fix:** Extract one `fetchGroupName` helper with the API's sanitization and use it in all three places.

### [AUD2-011] [LOW] — Unpinned base images and builder toolchain

- **Category:** Supply chain / reproducibility
- **Location:** `Dockerfile.api:1`, `:10`; `Dockerfile.worker:1`, `:10`; `Dockerfile.web:1-2`; `infra/caddy/Dockerfile:1`; `docker-compose.yml:35`, `:53`
- **Confidence:** High
- **Problem:** `golang:1.27-alpine`, `alpine:3.21`, `node:24-bookworm-slim`, `nginx-unprivileged:stable-alpine`, `caddy:2-alpine`, `postgres:18` and `redis:7-alpine` float. The local toolchain (`go1.27.1`) has 11 standard-library vulnerabilities reachable from this code, according to `govulncheck` (net/http, http2, crypto/tls, crypto/x509, mime/multipart). The deployed `rivosnap-api` binary was built with `go1.27.4`, where all of them are fixed. Safety therefore depends on when an image was built, not on the repository.
- **Recommended fix:** Pin image digests, or at least patch versions such as `golang:1.27.4-alpine`, and update them deliberately. Add `govulncheck` to the CI from `AUD2-006`.

### [AUD2-012] [INFO] — Smaller observations

- `cmd/rivosnap/main.go:133-136`: `http.Server` has no `ReadHeaderTimeout` or `IdleTimeout`. Exposure is low because Nginx buffers requests; set them as defense in depth.
- `internal/api/server.go:1630`: the remote thumbnail body from Google is read with `io.ReadAll` without a size cap. The source is trusted; add an `io.LimitReader` (for example 10 MB).
- `internal/worker/worker.go:767-771`: the heartbeat proves the process is alive, not that work is progressing. A worker stuck on a 600 s transfer, or crash-looping between restarts (`AUD2-003`), still shows "Online". Consider also publishing the time of the last completed dispatch.
- `apps/web/src/main.tsx:223`, `:239`: the "Upload queue" badge reads `/dashboard/stats` only from cache, so it is stale or missing until the dashboard has been visited.
- `AuditLog` (one "Photo synced" row per item) and `UploadAttempt` grow without bound. Only `WebhookEvent` is pruned (`worker.go:708-709`).
- Gallery ordering `ORDER BY "lineEventTimestamp" DESC, id` with `OFFSET` and a `COUNT(*)` per request has no supporting index when no group filter is set (`server.go:1262-1282`). This is fine at current scale; see §3.
- Static analysis: `gofmt -l` reports `internal/crypto/crypto.go`. `staticcheck` reports ST1005 at `internal/media/media.go:70` and `internal/model/model.go:80`.

## 3. Performance & Resource Optimization

- **High impact:** `AUD2-003` (worker decode memory; removing the full decode also removes about half the CPU per item, since inspection runs twice). `AUD2-004` (bounded thumbnail generation).
- **Medium impact:** `AUD2-007` (single-query `/groups`).
- **Low impact:** Dashboard statistics run 7 sequential `COUNT`s every 15 s per tab (`server.go:1846-1864`). One `COUNT(*) FILTER (...)` query would replace them.
- **Benchmark before changing:**
  - Gallery `OFFSET` pagination and its unindexed sort (`server.go:1262-1282`). Measure at 50k–100k `Image` rows before adding an index on `("lineEventTimestamp" DESC, id)` or switching to keyset pagination.
  - The `Cleanup` thumbnail directory scan (`worker.go:679-706`) runs every minute and costs one `stat` per thumbnail. Measure at 100k+ files.
  - Per-upload Google API calls: `albums.get`, `uploads` and `batchCreate` per item, plus paginated `mediaItems:search` on uncertainty. Compare with the project's real quota. A per-album `mediaItemsCount` check once per batch would save one call per item.

## 4. Security Findings

- **Findings:** `AUD2-002` (limiter keyed on proxy peer: login lockout, webhook key bypass), `AUD2-011` (unpinned images and toolchain), `AUD2-009` (silent credential-decrypt fallback), `AUD2-010` (minor sanitization gap).
- **Controls verified by reading:**
  - Webhook HMAC is checked over raw bytes in constant time (`line.go:18-29`), with the destination pinned after credentials are saved.
  - Browser writes require an exact `Origin` and a custom header.
  - Session cookies are signed, HttpOnly, SameSite=Lax and Secure in production; sessions live in Redis with a 12 h TTL and are deleted on logout.
  - OAuth state is single-use (`GETDEL`) and bound to the session.
  - Refresh tokens and LINE secrets are encrypted with AES-256-GCM using random nonces; passwords use Argon2id.
  - Path IDs are UUID-validated before any filesystem access.
  - `ffmpeg`/`ffprobe` run with argument arrays (no shell).
  - Remote media URLs are restricted to `https` on `*.googleusercontent.com` and redirects are not followed.
  - Every route except the webhook, `/ready` and the auth bootstrap requires a session.
  - No request logging; errors are reported by type only.
- **Verification limits:**
  - No live penetration test.
  - The external reverse proxy's configuration is outside the repository and was not reviewed.
  - `pnpm audit --prod` reported no known vulnerabilities. `govulncheck` module results: 2 vulnerabilities in imported packages and 2 in required modules are not called by this code.

## 5. Reliability & Concurrency Findings

- **Findings:** `AUD2-001` (silent drops), `AUD2-003` (OOM loop bypasses retry cap; quarantine instead of delete), `AUD2-004` (API resource exhaustion), `AUD2-005` (album review blocks a whole group), `AUD2-007` (pool self-deadlock), `AUD2-009` (outages reported as success), `AUD2-012` (heartbeat does not measure progress).
- **Verified as sound:**
  - The singleton worker via a session advisory lock held on a dedicated connection.
  - Outbox claim with `SKIP LOCKED` and one-minute re-claim of unacknowledged rows.
  - Compare-and-set state updates.
  - The `SYNCED` ⇒ media ID database check.
  - Reconcile-only handling of uncertain `batchCreate` results.
  - Album creation guarded by a CAS flag.
  - Per-event ingest transactions whose disk-pressure rollback leaves the `WebhookEvent` absent, so redelivery works.
  - Singleflight access-token refresh detached from the caller's cancellation.
  - Migrations serialized with an advisory transaction lock.
- **Residual risk:** On SIGTERM the worker cancels in-flight work immediately. Recovery relies on re-claim plus reconcile, which is correct but produces `NEEDS_REVIEW` items when `batchCreate` was in flight.

## 6. Testing Gaps

1. No test runs against the production timezone configuration (`AUD2-001`). Add Bangkok-TZ Postgres to the integration run, plus a focused test: enable a group, then deliver an image timestamped one minute later and assert an `Image` row exists.
2. No CI at all (`AUD2-006`).
3. No test covers album review recovery (`AUD2-005`): an `ALBUM_REVIEW` cascade followed by `resolve-album`.
4. No test covers suffix or unsatisfiable `Range` requests (`AUD2-008`).
5. No test checks that rate-limit keys are distinct per client behind the proxy (`AUD2-002`). The current unit test locks in the peer-only behavior.
6. `internal/worker`, `internal/google`, `internal/httpclient` and `internal/config` have no unit tests. Their behavior is covered only through the single long integration test, which mocks providers and stubs `ffmpeg` when it is absent. Error classification in `httpclient.Request` (`ALBUM_CAPACITY`/`GOOGLE_STORAGE` regexes, `Retry-After`, `invalid_grant`) deserves table tests.
7. `TestShortVideoThumbnailFallsBackToFirstFrame` was skipped in this environment (no host `ffmpeg`), and the pipeline test then uses a stub `ffmpeg`. Real thumbnailing is not exercised unless `ffmpeg` is installed.
8. `migrate_test.go` claims a Prisma-initialized upgrade path that the script no longer creates (`AUD2-006`).

## 7. Architecture Recommendations

- **Own time at the database boundary (`AUD2-001`):** Use `timestamptz` columns and a UTC session timezone in `db.Connect`. The application then never depends on host or container `TZ` for correctness; Bangkok time becomes a display concern only, as `i18n.ts` already treats it.
- **Separate "can the bytes be stored" from "can they be rendered" (`AUD2-003`, `AUD2-004`):** Staging should validate the header, dimensions, size and hash, never discard bytes, and never decode fully in-process. Rendering (thumbnails) should be bounded, best-effort, and should not block uploads.
- **Make owner recovery actions group-scoped (`AUD2-005`):** Use the same outbox-transaction pattern as `handleRetryJob`, applied to all items that share the resolved cause.

## 8. Recommended Action Plan

- **Immediate:**
  1. `AUD2-001`: set `timezone=UTC` on the pool and make Go timestamps UTC. Before the fix ships, tell the owner that images in the first 7 hours after enabling a group are not collected.
  2. `AUD2-001` step 3: plan the data repair on a restored copy.
  3. `AUD2-006`: add Bangkok-TZ Postgres to the integration script so the fix is regression-tested.
- **Short term:**
  - `AUD2-002` (real client IP, webhook limiter key).
  - `AUD2-005` (re-queue on resolve).
  - `AUD2-006` (CI workflow; gate releases on it).
  - `AUD2-003` (drop the full decode, quarantine instead of delete, cap crash loops).
- **Medium term:**
  - `AUD2-004` (thumbnail semaphore and single-flight).
  - `AUD2-007` (single-query `/groups`).
  - `AUD2-009` (error propagation).
  - `AUD2-011` (pin images, `govulncheck` in CI).
  - `timestamptz` migration (§7).
- **Optional:** `AUD2-008` (`http.ServeContent`), `AUD2-010`, `AUD2-012` items, and the §3 benchmark candidates.

## 9. Audit Coverage

**Status: full file coverage. Behavioral verification is partial, as listed below.** All 91 tracked files are accounted for. `graphify-out/` and `node_modules/` are untracked and outside scope. The local `apps/web/dist/` produced by the build check is git-ignored.

### Reviewed (read in full)

- `cmd/rivosnap/`: `main.go`
- `internal/api/`: `server.go`, `ingest.go`, `pipeline_test.go`, `rate_test.go`
- `internal/config/`: `config.go`
- `internal/crypto/`: `crypto.go`, `crypto_test.go`
- `internal/db/`: `db.go`, `migrate.go`, `migrate_test.go`
- `internal/google/`: `google.go`
- `internal/httpclient/`: `http.go`
- `internal/line/`: `line.go`, `line_test.go`
- `internal/media/`: `media.go`, `media_test.go`
- `internal/model/`: `model.go`, `model_test.go`
- `internal/worker/`: `worker.go`
- `packages/database/migrations/`: `embed.go`, `migration_lock.toml`, `202611190001_initial/migration.sql`, `202611190002_authorization_window/migration.sql`, `202611200001_video_support/migration.sql`
- `packages/ui/`: `button.tsx`, `package.json`
- `apps/web/`: `index.html`, `package.json`, `vite.config.mjs`, `src/data.ts`, `src/i18n.ts`, `src/main.tsx`, `src/onboarding.tsx`, `src/photos.tsx`, `src/workspace.tsx`
- `e2e/`: `gallery.spec.ts`
- `scripts/`: `release.mjs`, `sync-version.mjs`, `version-control.mjs`, `version-targets.mjs`, `test-integration.sh`; `version-control.test.mjs` (executed, structure read)
- `infra/`: `docker/web.conf`, `caddy/Dockerfile`
- `.github/workflows/`: `release-images.yml`
- Root: `Dockerfile.api`, `Dockerfile.worker`, `Dockerfile.web`, `docker-compose.yml`, `docker-compose.override.yml.example`, `Caddyfile`, `.env.example`, `.dockerignore`, `.gitignore`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `playwright.config.ts`, `go.mod`, `VERSION`, `README.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`
- `docs/`: `ARCHITECTURE.md`, `SECURITY.md`, `DOCKER_DEPLOYMENT.md`, `LINE_SETUP.md`, `TROUBLESHOOTING.md`, `OWNER_GUIDE.md`, `GOOGLE_PHOTOS_OAUTH.md`, `GOOGLE_CLOUD_SETUP.md`, `example-deploy/README.md`, `example-deploy/compose.yml`, `example-deploy/env.example`, `plans/README.md`, `plans/completed/*.md` (7 files; read for context), `audit/2026-11-20-audit-report.md` (findings index and remediation plan read to separate new from known issues)

### Reviewed at reduced depth

- `apps/web/src/style.css` (1,297 lines): scanned for imports, external URLs and expressions (only `@import "tailwindcss"`). Presentation rules were not reviewed line by line, because styling has no correctness or security surface here.

### Excluded (non-reviewable or generated)

- `apps/web/public/rivosnap-mark.png`: binary image asset.
- `apps/web/public/rivosnap-mark.svg`, `apps/web/public/rivosnap.svg`: static brand artwork, served same-origin and not user-controlled.
- `pnpm-lock.yaml`, `go.sum`: generated lockfiles. Covered by `pnpm audit --prod` and `govulncheck` instead of line review.

### Flows traced end to end

- LINE webhook: signature → destination pin → ingest transaction → outbox.
- Worker: claim → download/stage → thumbnails → upload → `batchCreate` → reconcile → failure classification and backoff.
- Cleanup and retention.
- Owner auth: setup, login, session, logout.
- CSRF guard and rate limiter.
- Google OAuth connect and callback, and token refresh caching.
- Media serving: local, on-demand thumbnail, remote proxy, Range.
- Discard and retry actions.
- Album resolve.
- Migrations and baseline detection.
- Release and versioning scripts.
- Compose topology and Nginx proxying.

### Checks run (exact commands and outcomes)

| Command | Outcome |
|---|---|
| `go vet ./...` | Pass |
| `go test -count=1 ./...` | Pass (integration tests skipped without services) |
| `gofmt -l cmd internal packages` | `internal/crypto/crypto.go` unformatted |
| `~/go/bin/staticcheck ./...` | 2 × ST1005 (style) |
| `~/go/bin/govulncheck ./...` | 11 reachable stdlib vulnerabilities in local go1.27.1 (fixed ≤ 1.27.4); deployed binary is go1.27.4 |
| `corepack pnpm typecheck` | Pass |
| `corepack pnpm build` | Pass (375 kB JS / 120 kB gzip) |
| `node --test scripts/version-control.test.mjs` | 20/20 pass |
| `node scripts/sync-version.mjs --check` | `Checked 2026.11.5` |
| `corepack pnpm audit --prod` | No known vulnerabilities |
| `docker compose --profile edge config --quiet` | Pass |
| `bash scripts/test-integration.sh` (disposable Postgres/Redis) | All pass; `TestShortVideoThumbnailFallsBackToFirstFrame` skipped (no host `ffmpeg`) |
| Same script with Postgres `-e TZ=Asia/Bangkok` (scratch copy, `-run TestFullPipelineIntegration`) | **Fail:** `expected 1 deduplicated image, got 0` (`AUD2-001`) |
| Disposable `postgres:18 -e TZ=Asia/Bangkok`: `SHOW timezone; NOW()` vs UTC | `Asia/Bangkok`; +7 h offset |
| Production, read-only: `SHOW timezone` on `rivosnap-postgres`; `go version` on a copy of the deployed API binary | `Asia/Bangkok`; `go1.27.4`. No application data was read; nothing was mutated. |

### Not verified

- Real LINE and Google Photos API behavior, quotas and error payloads (all mocked).
- Worker and API memory under maximum-size media (`AUD2-003`, `AUD2-004`: reasoning only).
- Login lockout and pool deadlock (`AUD2-002`, `AUD2-007`): traced in code, not reproduced against a running stack.
- Playwright e2e (`corepack pnpm e2e`): not run.
- External reverse-proxy configuration and host firewall.
- Backup and restore procedures.
