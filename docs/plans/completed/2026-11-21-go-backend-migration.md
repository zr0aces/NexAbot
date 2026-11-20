# Migrate API & Worker services to Go (Way 1: Separate `api` + `worker` Go containers, keep `web` Nginx)

**Status:** 2026-11-21 — Completed and verified (`go test ./...`, `test-integration.sh`, `typecheck`, `build`, and Docker image builds pass; image size reduced from 1.56 GB to 158 MB).

## Goal

Replace the Node 24 / TypeScript / Fastify / Prisma / BullMQ / Sharp runtime in `rivosnap-api` and `rivosnap-worker` with a single compiled Go codebase (`cmd/rivosnap` supporting `api` and `worker` modes) while keeping `rivosnap-web` (React + Vite + Nginx), `docker-compose.yml` service names, GHCR image names, PostgreSQL database state, encrypted secrets, signed session cookies, and volume layouts 100% backwards-compatible.

## Scrutiny findings & hardening applied to this plan

1. **Docker healthcheck exec without a shell**:
   - `docker-compose.yml` and `docs/example-deploy/compose.yml` use `test: [CMD, node, -e, ...]` and `test: [CMD, node, --input-type=module, -e, ...]` (`execve` directly, not `/bin/sh`).
   - A shell script at `/usr/local/bin/node` works only if it starts with `#!/bin/sh` and has `0755` permissions, **or** better: make `/usr/local/bin/node` a symlink to `/app/rivosnap`! When `filepath.Base(os.Args[0]) == "node"` (or `os.Args[1]` starts with `-e` / `--input-type=module`), `cmd/rivosnap/main.go` inspects the arguments: if the argument string contains `worker:heartbeat`, it runs `healthcheck-worker` (checks `EXISTS worker:heartbeat` in Redis); if it contains `/ready`, it runs `healthcheck-api` (HTTP GET `http://127.0.0.1:3000/ready`). Zero shell overhead, zero Node.js binary, 100% compatible with existing unedited `compose.yml` files!
2. **Nullable vs non-null JSON slice serialization in Go**:
   - In Go, a `nil` slice serializes to `null` instead of `[]`. The React frontend (`q.data?.map`, `g.images[0]`, `d.items.map`, `d.recent.map`) expects JSON arrays (`[]`), never `null`.
   - Every slice returned in JSON (`groups`, `g.Images`, `items`, `attempts`, `recent`) must be initialized to an empty slice (`make([]T, 0)`).
   - Every omitted field (`stagingPath` and `thumbnailPath` on `/images`, `/jobs`, `/images/:id`) must be excluded from those response structs, while `hasStaging: bool` is computed on `/images` and `/jobs`.
3. **Settings JSONB partial merge preserve**:
   - `"Owner".settings` stores both retention/collection flags (`stagingHours`, `failedDays`, `thumbnailDays`, `collectVideos`) **and** encrypted LINE credentials (`lineToken`, `lineSecret`, `destination`).
   - `PATCH /api/v1/settings` and `POST /api/v1/settings/line` must use `UPDATE "Owner" SET settings = settings || $1::jsonb WHERE id = 1` (just like [routes.ts](file:///home/san/workspace/RivoSnap/apps/api/routes.ts#L55)) so updating retention never wipes `lineToken`/`lineSecret` and vice versa.
4. **Prisma enum & timestamp compatibility**:
   - PostgreSQL column `"Image"."uploadStatus"` has enum type `"UploadState"`. SQL queries in `pgx` must cast string parameters with `$1::"UploadState"` (or use `pgx` text protocol / explicit casts) so PostgreSQL never rejects `text` vs `"UploadState"` comparisons.
   - All timestamps written to `"updatedAt"` must be explicitly set to `NOW()` in `INSERT` and `UPDATE` statements because Prisma managed `@updatedAt` in the client rather than via a SQL `DEFAULT` on `"updatedAt"`.
5. **Dual-runtime verification**:
   - Keep `packages/shared/*` (or TypeScript types used by `apps/web`) intact so `corepack pnpm typecheck` and `corepack pnpm build` for `apps/web` continue to pass with zero frontend regressions, while `go test -v ./...` tests the Go packages and end-to-end API + worker pipeline against disposable Postgres + Redis.

## Compatibility & preservation invariants (Zero data loss / Zero re-login)

1. **PostgreSQL schema & Prisma migration compatibility**:
   - All existing table and column names (`"Owner"`, `"GoogleConnection"`, `"LineGroup"`, `"Image"`, `"UploadAttempt"`, `"WebhookEvent"`, `"OutboxEvent"`, `"AuditLog"`, `"UploadState"` enum) remain identical.
   - Startup migrator checks `_prisma_migrations` / applies the original embedded Prisma SQL exactly once (~~recreating tables with idempotent DDL~~ recording each checksum and completed migration in the same transaction) so an existing database migrated by Prisma or a fresh database both boot cleanly without conflict.
2. **AES-256-GCM token encryption (`seal` / `open`)**:
   - Format in [packages/shared/crypto.ts](file:///home/san/workspace/RivoSnap/packages/shared/crypto.ts#L13-L32): `<base64(iv_12_bytes)>.<base64(auth_tag_16_bytes)>.<base64(ciphertext)>` using the 32-byte key decoded from the 64-char hex `TOKEN_ENCRYPTION_KEY`.
   - Go's `cipher.NewGCM` appends the 16-byte tag to the end of `ciphertext` (`ciphertext || tag`). The Go `Open` / `Seal` functions must split/join `iv`, `tag`, and `ciphertext` in the exact `<iv_b64>.<tag_b64>.<data_b64>` wire format so existing `GoogleConnection.encryptedRefreshToken` and `Owner.settings.lineToken` / `lineSecret` in Postgres decrypt seamlessly.
3. **Argon2id password verification & hashing**:
   - Node's `argon2` package stores PHC strings (`$argon2id$v=19$m=...,t=...,p=...$<salt_b64>$<hash_b64>`).
   - Go parser must parse `$argon2id$v=%d$m=%d,t=%d,p=%d$...` with `base64.RawStdEncoding` and verify via `golang.org/x/crypto/argon2.IDKey`, and generate standard PHC `$argon2id$v=19$m=65536,t=3,p=4$...` strings on setup.
4. **Fastify signed session cookie (`@fastify/cookie`)**:
   - `@fastify/cookie` signs cookie value `val` as `<val>.<base64_hmac_sha256(val, SESSION_SECRET)>` where padding `=` is stripped from the base64 HMAC (`strings.TrimRight(base64.StdEncoding.EncodeToString(mac), "=")`).
   - Supporting this exact signature format in Go means even active browser sessions remain logged in across the Node → Go container swap, and Redis `session:<id>` keys (12h TTL) remain identical.
5. **Staging & thumbnail filesystem layout**:
   - `STAGING_PATH/<image_uuid>.image` and `THUMBNAIL_PATH/<image_uuid>.320.webp` / `.640.webp` remain unchanged.
   - `ffmpeg` and `ffprobe` (already installed in the slim container) handle both image and video inspection + WebP thumbnail generation with EXIF auto-orientation, eliminating `sharp` / `libvips` C++ dependencies while supporting JPEG, PNG, WebP, GIF, MP4, MOV, and WebM.
6. **Outbox dispatch & Redis**:
   - `rivosnap-worker` polls `"OutboxEvent"` in PostgreSQL (ordered by `"availableAt" ASC`, prioritizing `PROCESS` over `UPLOAD`/`GROUP_SUMMARY`/`RECONCILE`/`DISCARD`), claims/acknowledges rows transactionally, and writes `worker:heartbeat` (90s TTL) to Redis every second.
7. **Container healthchecks & `/app/VERSION`**:
   - Both `Dockerfile.api` and `Dockerfile.worker` copy `VERSION` to `/app/VERSION` (required by `.github/workflows/release-images.yml` verification).
   - To keep existing `docker-compose.yml` and `docs/example-deploy/compose.yml` healthchecks working without edits (which invoke `node -e "fetch('http://127.0.0.1:3000/ready')..."` in `api` and `node --input-type=module -e "import Redis from 'ioredis'..."` in `worker`), **and** support native `rivosnap healthcheck`, provide a tiny `/usr/local/bin/node` shim in the slim Go runtime image that delegates healthcheck invocations to `/app/rivosnap healthcheck-api` / `healthcheck-worker`! That way, even an unedited `compose.yml` running the old `CMD ["node", ...]` healthcheck passes with zero Node.js installed.

## Architecture & module layout

```text
go.mod
go.sum
cmd/
  rivosnap/
    main.go              # subcommands: api, worker, migrate, healthcheck-api, healthcheck-worker
internal/
  config/
    config.go            # env parsing & validation (matching packages/shared/config.ts)
  crypto/
    crypto.go            # AES-256-GCM (iv.tag.data), Argon2id PHC, HMAC-SHA256, Fastify cookie sign/unsign
  model/
    model.go             # UploadState machine, transition(), backoff(), Fault, Settings limits, Filters
  db/
    db.go                # pgxpool connection, schema migration runner, queries & transactional outbox
    connections.go       # cached Google OAuth access token refresh & LINE credentials loader
  media/
    media.go             # dirs, pathFor, free/pressured (syscall.Statfs), usage cache, sha256, inspect, inspectVideo, thumbnail, stage
  line/
    line.go              # webhook HMAC signature verification, event parsing, relevant(), API & content download
  google/
    google.go            # OAuth consent/token/refresh, title(), album, createAlbum, renameAlbum, bytes upload, createMedia, reconcile
  api/
    server.go            # HTTP server, security headers, rate limiter, CSRF Origin + X-Gallery-Request guard, session auth, OpenAPI
    ingest.go            # LINE webhook transactional ingestion
    routes.go            # /ready, /api/v1/auth/*, /health, /settings, /google/*, /groups/*, /images/*, /jobs/*, /dashboard/stats
  worker/
    worker.go            # 1s dispatcher + sequential outbox processor + 60s maintenance cleanup + Redis heartbeat
    process.go           # processEvent(), resolveAlbum(), filename()
    maintenance.go       # cleanup() for expired synced staging, thumbnails, .part files, and 90d webhook events
```

## Task list

- [x] **1. Go module & core domain packages (`internal/config`, `internal/crypto`, `internal/model`)**:
  - Initialize `go.mod` (`rivosnap`, Go 1.24+) with `github.com/jackc/pgx/v5`, `github.com/redis/go-redis/v9`, `golang.org/x/crypto`, and `github.com/google/uuid`.
  - Implement `internal/config`: validate `APP_URL` (`https://` in production), `REDIS_URL`, `DATABASE_URL`, `SESSION_SECRET` (>=32), `BOOTSTRAP_SECRET` (>=24), `TOKEN_ENCRYPTION_KEY` (64 hex chars), `GOOGLE_REDIRECT_URI`, size/retention defaults, and `Settings(custom)`.
  - Implement `internal/crypto`: `Equal`, `Seal`/`Open` (`<iv_b64>.<tag_b64>.<data_b64>`), `HashPassword`/`VerifyPassword` (Argon2id PHC format compatible with Node `argon2`), and `SignCookie`/`UnsignCookie` (compatible with `@fastify/cookie`).
  - Implement `internal/model`: `UploadState` enum, `Terminal` states, `Transition(a, b, mediaID)`, `Backoff(n, min)`, `Fault` error type, `Limits`, and `Filters`.
  - Add unit tests in `internal/crypto/crypto_test.go` and `internal/model/model_test.go` verifying cross-compatibility with Node outputs.
- [x] **2. Database & provider clients (`internal/db`, `internal/line`, `internal/google`, `internal/media`)**:
  - Implement `internal/db`: `pgxpool.Pool` initialization, idempotent SQL migration runner (compatible with existing Prisma-migrated DBs and fresh DBs), and token/credential helper (`Access(ctx, forceRefresh)` with 45m cache + singleflight and `LineCredentials(ctx)`).
  - Implement `internal/line`: `Signed(body, signature, secret)`, `Envelope`/`Event` structs, `Relevant(e)`, `Call(ctx, path, token, isData, timeout)`, and `Download(ctx, messageID, token)`.
  - Implement `internal/google`: `Scopes` (including `edit.appcreateddata`), `Consent(state)`, `Token`, `Refresh`, `Title`, `Album`, `CreateAlbum`, `RenameAlbum`, `Item`, `Bytes`, `CreateMedia`, `Reconcile`, and `Validate`.
  - Implement `internal/media`: `InitDirs`, `PathFor`, `Free`/`Pressured` (`syscall.Statfs`), `Usage` (with 10s TTL cache), `Digest`, `Inspect` (magic-byte + `image.DecodeConfig` / `ffprobe` for JPEG/PNG/WebP/GIF with 100MP pixel guard), `InspectVideo` (`ffprobe` for MP4/MOV/WebM), `Thumbnail` & `CacheThumbnail` (`ffmpeg` auto-rotated fit-inside 320/640 `.webp` with atomic `.part` rename), `Stage` (streaming size-bounded atomic `.part` writer), and `Touch`.
- [x] **3. Worker pipeline (`internal/worker`)**:
  - Implement `ProcessEvent(ctx, outboxID)` and `ResolveAlbum(ctx, group, token)` matching every state transition, integrity hash check, Google reconciliation fallback, and transient/permanent error classification in [apps/worker/process.ts](file:///home/san/workspace/RivoSnap/apps/worker/process.ts).
  - Implement `Cleanup(ctx, now)` matching [apps/worker/maintenance.ts](file:///home/san/workspace/RivoSnap/apps/worker/maintenance.ts).
  - Implement `Run(ctx)` loop: poll due `"OutboxEvent"` rows (`PROCESS` priority 1, others priority 2), set `"publishedAt"`, execute sequentially (concurrency 1), update Redis `worker:heartbeat` (`EX 90`), and run `Cleanup` every 60s.
- [x] **4. API server & routes (`internal/api`, `cmd/rivosnap`)**:
  - Implement HTTP server with security headers, per-minute rate limiting (600/min general, 8/5min on `/api/v1/auth/setup` and `/api/v1/auth/login`), CSRF Origin + `X-Gallery-Request: 1` check on non-GET/HEAD/OPTIONS routes, and Redis session validation.
  - Implement `POST /api/webhooks/line` with raw-byte HMAC verification, channel destination guard, and transactional `Ingest(ctx, payload)`.
  - Implement all `/api/v1/*` routes (`/auth/status`, `/auth/setup`, `/auth/login`, `/auth/logout`, `/health`, `/settings`, `/settings/line`, `/google/status`, `/google/connect`, `/google/callback`, `/google/validate`, `/google/disconnect`, `/groups`, `/groups/:id`, `/groups/:id/refresh`, `/groups/:id/resolve-album`, `/images`, `/jobs`, `/images/:id`, `/images/:id/thumbnail`, `/images/:id/content` with HTTP `Range` `206 Partial Content`, `/jobs/:id/discard`, `/jobs/:id/retry`, `/dashboard/stats`), `/ready`, and `/api/openapi.json`.
  - Ensure all JSON field names, status codes (`400`, `401`, `403`, `404`, `409`, `429`, `503`), and ISO-8601 UTC millisecond timestamps (`2006-01-02T15:04:05.000Z`) match the React frontend and integration test expectations.
- [x] **5. Dockerfiles, healthcheck compatibility & integration tests**:
  - Update [Dockerfile.api](file:///home/san/workspace/RivoSnap/Dockerfile.api) and [Dockerfile.worker](file:///home/san/workspace/RivoSnap/Dockerfile.worker) to multi-stage Go builds (`golang:1.27-alpine` builder → `alpine:3.21` runtime with `ca-certificates`, `ffmpeg`, `tzdata`, `/app/rivosnap`, `/app/VERSION`, non-root user `node` UID 1000, and a `/usr/local/bin/node` healthcheck compatibility symlink so existing `compose.yml` healthchecks work unchanged).
  - Add comprehensive Go unit + integration test suite (`go test ./...`) covering the entire pipeline (setup, login, webhook HMAC, group enable, image/video ingestion, Google OAuth, album creation, album title refresh, reconciliation, Range streaming, retention cleanup, and rate-limit backoff) **and** keep `scripts/test-integration.sh` passing.
  - Build and verify `docker compose build api worker` and confirm image size, startup time, and live healthchecks.
