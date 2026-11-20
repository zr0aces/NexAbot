# Audit Remediation (`AUD-001` through `AUD-013`)

**Status:** 2026-11-20 — Shipped. All 13 findings (`AUD-001` through `AUD-013`) remediated and verified (`typecheck`, `build`, `vitest`, `version-control.test.mjs`, `sync-version --check`, `docker compose config`, and `test-integration.sh` pass).

## Goal

Remediate all 13 findings (`AUD-001` through `AUD-013`) from the [2026-11-20 Full Codebase Engineering Audit](../audit/2026-11-20-audit-report.md) with minimal, verifiable changes that preserve existing architecture invariants, security controls, and test contracts.

## Scrutiny & Design Notes

1. **`AUD-001` (API on-demand video thumbnail `ENOENT`):**
   - Install `ffmpeg` in `Dockerfile.api` (matching `Dockerfile.worker`) so on-demand `thumbnail(i.id, size, "VIDEO")` in `apps/api/routes.ts` always has `ffmpeg` available when a staged video's thumbnail is requested before the `UPLOAD` job runs or after `thumbnailDays` cache eviction.
   - Also generate 320 and 640 thumbnails immediately before/after transitioning to `STAGED` in `apps/worker/process.ts` so newly staged items in the Upload Queue have pre-generated thumbnails without blocking API requests.
2. **`AUD-002` (`UNSUPPORTED_VIDEO` not mapped to `UNRECOVERABLE` & unguarded `JSON.parse`):**
   - In `packages/image-processing/index.ts`, move `JSON.parse(out)` inside the `try / catch` block in `inspectVideo()` so malformed `ffprobe` output throws `Fault("UNSUPPORTED_VIDEO", ...)`.
   - In `apps/worker/process.ts`, include `"UNSUPPORTED_VIDEO"` in the `UNRECOVERABLE` error code list (`["LINE_404", "LINE_410", "UNSUPPORTED_IMAGE", "UNSUPPORTED_VIDEO", "FILE_SIZE"]`).
3. **`AUD-003` (Remote synced video playback HTTP `Range` support):**
   - In `apps/api/routes.ts`, when proxying remote video (`!thumb && i.mediaType === "VIDEO"`) and `q.headers.range` matches `/^bytes=\d*-\d*$/`, forward `Range: q.headers.range` in the upstream `fetch` headers to Google (`m.baseUrl + "=dv"`).
   - Accept HTTP `200` or `206` from upstream (`remote.ok`), forward status `remote.status` (`206` when partial), and forward `Content-Range`, `Accept-Ranges`, and `Content-Length` headers if returned by upstream.
4. **`AUD-004` (OAuth access token caching & remote thumbnail disk caching):**
   - **Access token cache (`packages/database/connections.ts`):** Cache `{ token: string, encryptedRefreshToken: string, expiresAt: number }` in process memory along with an `inflight: Promise<string> | null` single-flight promise. Bind the cache entry to `c.encryptedRefreshToken` so disconnecting or reconnecting Google in `GoogleConnection` automatically invalidates any cached token from a previous refresh token. Set TTL to 45 minutes (`Date.now() + 45 * 60_000`), and expose `clearAccessCache()` (or automatically invalidate when `c.encryptedRefreshToken` changes or when an upstream call fails with `GOOGLE_AUTH`).
   - **Remote thumbnail read-through disk cache (`apps/api/routes.ts`):** When `thumb === true` and a remote thumbnail is fetched from `m.baseUrl + "=w" + size + "-h" + size"`, read the buffer (bounded, since it is a `320` or `640` thumbnail), convert/transcode via `sharp(buf, { limitInputPixels: 100000000 }).rotate().resize({ width: size, height: size, fit: "inside", withoutEnlargement: true }).webp().toFile(tmp)` and atomically `rename(tmp, path)` before serving `path` as `image/webp`. This guarantees `/data/thumbnails` only ever stores validated `.webp` files matching `pathFor(i.id, size)`.
5. **`AUD-005` (`usage()` sequential `readdir` + `stat` in `/api/v1/dashboard/stats`):**
   - Add a 15-second in-memory TTL cache per directory path inside `usage(d)` in `packages/image-processing/index.ts` (and run `stat` calls concurrently in bounded batches or `Promise.all`), plus export `clearUsageCache()` if needed. Because `dirs` are temp paths in tests (`mkdtemp`), keying the cache by directory path `d` with a short TTL (or invalidating on `cleanup()`) keeps `tests/pipeline.test.ts` deterministic while preventing repeated $O(N)$ directory scans on 15s dashboard polling.
6. **`AUD-006` (`MAX_VIDEO_SIZE_MB` missing in `docker-compose.yml` and `.env.example`):**
   - Add `MAX_VIDEO_SIZE_MB: ${MAX_VIDEO_SIZE_MB:-200}` to `x-node.environment` in `docker-compose.yml` and `MAX_VIDEO_SIZE_MB=200` to `.env.example`.
7. **`AUD-007` (`pressured()` reserve math in `/health`, `/dashboard/stats`, and `ingest.ts`):**
   - In `apps/api/routes.ts` (`/health` and `/dashboard/stats`) and `apps/api/ingest.ts`, pass `policy.collectVideos` into `pressured(policy.collectVideos)` so disk pressure consistently reflects the active collection policy across webhook ingestion, dashboard warnings, and system health.
8. **`AUD-008` (Rate-limit bucket sharing behind Nginx `web` container):**
   - In `apps/api/server.ts`, configure `@fastify/rate-limit` with a `keyGenerator` that keys authenticated requests by their verified session cookie ID (`sid(req)`), `/api/webhooks/line` by `"webhook:" + (req.headers["x-line-signature"] ?? "anon")` (so unauthenticated browser traffic cannot starve signed LINE webhooks), and unauthenticated requests by `req.ip`. Keep `/api/v1/auth/login` and `/api/v1/auth/setup` at `max: 8, timeWindow: "5 minutes"` as a brute-force guard.
9. **`AUD-009` (Outbox dispatcher 60s republication vs. active long-running jobs):**
   - In `apps/worker/dispatch.ts`, before re-adding an already-published event (`e.publishedAt !== null`), check `const job = await q.getJob(e.id);` and if `job && (await job.isActive() || await job.isWaiting() || await job.isDelayed())`, simply refresh `publishedAt: now` in PostgreSQL without calling `q.add` again.
10. **`AUD-010` (`location.search` in `Dashboard`):**
    - In `apps/web/src/workspace.tsx`, use `useSearchParams()` from `react-router-dom` (`const [sp] = useSearchParams();`) and check `(!d.synced || sp.has("setup"))`.
11. **`AUD-011` (Fastify `FSTDEP023` `disableRequestLogging` deprecation):**
    - Keep request logging disabled in `apps/api/server.ts` while suppressing/replacing the deprecated `disableRequestLogging` option if Fastify 5.12 supports `loggerInstance` / `disableRequestLogging` cleanly, or verify Fastify's exact TypeScript types so zero deprecation warnings are emitted.
12. **`AUD-012` (`WebhookEvent` pruning in `maintenance.ts`):**
    - In `apps/worker/maintenance.ts`, delete `WebhookEvent` rows where `receivedAt < new Date(now - 90 * 86400000)` to bound operational deduplication table growth while keeping 90 days of webhook history.
13. **`AUD-013` (Unreferenced `/rivosnap-mark.png` in `apps/web/index.html`):**
    - Add `<link rel="apple-touch-icon" href="/rivosnap-mark.png" />` in `apps/web/index.html` so the existing PNG asset serves as the iOS/macOS web clip icon.

## Security Verification Plan

- **Input & Command Execution Safety (`AUD-001`, `AUD-002`):** `ffmpeg` and `ffprobe` are invoked strictly via `execFile` (`node:child_process`) with hardcoded argument arrays and paths derived from `pathFor(id)` which validates `/^[a-f0-9-]{36}$/i`.
- **SSRF & Content-Type Validation (`AUD-003`, `AUD-004`):** Remote Google Photos fetches strictly enforce `https:` and `.googleusercontent.com` hostname checks, `redirect: "error"`, strict `Range` header regex `/^bytes=\d*-\d*$/`, and `sharp` transcode validation before writing cached thumbnails to disk.
- **Session & Rate-Limit Isolation (`AUD-008`):** Rate limiting separates authenticated owner sessions, webhook calls, and unauthenticated login attempts without trusting spoofable client `X-Forwarded-For` headers.
- **Test Binding:** All test servers use Fastify `app.inject()` or loopback `127.0.0.1` bindings.

## Task list

- [x] **1. Fix `AUD-001` & `AUD-002` (Video thumbnailing in API/Worker & `UNSUPPORTED_VIDEO` handling)** (`Dockerfile.api`, `packages/image-processing/index.ts`, `apps/worker/process.ts`):
  - Add `ffmpeg` to `Dockerfile.api`.
  - Move `JSON.parse(out)` inside `try / catch` in `inspectVideo()` (`packages/image-processing/index.ts`).
  - Add `"UNSUPPORTED_VIDEO"` to the `UNRECOVERABLE` error code list in `apps/worker/process.ts`.
- [x] **2. Fix `AUD-003` & `AUD-004` (Remote video HTTP `Range` support, OAuth access token caching, and remote thumbnail disk caching)** (`packages/database/connections.ts`, `apps/api/routes.ts`):
  - Add single-flight, refresh-token-bound access token caching in `packages/database/connections.ts` and invalidate on auth error.
  - Cache remotely fetched thumbnails to `pathFor(i.id, size)` via `sharp` WebP atomic write in `apps/api/routes.ts`.
  - Forward validated `Range` request headers and `206` / `Content-Range` / `Accept-Ranges` / `Content-Length` response headers for remote video streams in `apps/api/routes.ts`.
- [x] **3. Fix `AUD-005`, `AUD-006`, & `AUD-007` (Disk usage caching, `MAX_VIDEO_SIZE_MB` config, and `pressured()` video reserve consistency)** (`packages/image-processing/index.ts`, `docker-compose.yml`, `.env.example`, `apps/api/routes.ts`, `apps/api/ingest.ts`):
  - Add parallel `stat` and short-lived caching to `usage(d)` in `packages/image-processing/index.ts`.
  - Add `MAX_VIDEO_SIZE_MB` to `docker-compose.yml` and `.env.example`.
  - Pass `collectVideos` into `pressured()` in `/api/v1/health`, `/api/v1/dashboard/stats`, and `ingest()`.
- [x] **4. Fix `AUD-008`, `AUD-009`, & `AUD-011` (Rate-limit key isolation, active outbox job guard, and Fastify deprecation)** (`apps/api/server.ts`, `apps/worker/dispatch.ts`):
  - Add `keyGenerator` to `@fastify/rate-limit` in `apps/api/server.ts` separating authenticated sessions, webhook requests, and unauthenticated requests.
  - Check active/waiting BullMQ job state in `apps/worker/dispatch.ts` before re-adding an already-published outbox event.
  - Resolve Fastify `FSTDEP023` deprecation warning in `apps/api/server.ts`.
- [x] **5. Fix `AUD-010`, `AUD-012`, & `AUD-013` (React Router `useSearchParams`, `WebhookEvent` 90d pruning, and `apple-touch-icon`)** (`apps/web/src/workspace.tsx`, `apps/worker/maintenance.ts`, `apps/web/index.html`):
  - Replace `location.search === "?setup"` with `useSearchParams()` `sp.has("setup")` in `apps/web/src/workspace.tsx`.
  - Prune `WebhookEvent` rows older than 90 days in `apps/worker/maintenance.ts`.
  - Link `/rivosnap-mark.png` as `apple-touch-icon` in `apps/web/index.html`.
- [x] **6. Expand tests & verify all checks (`tests/pipeline.test.ts`, `tests/model.test.ts`)**:
  - Add integration tests in `tests/pipeline.test.ts` covering `collectVideos: true` ingestion, `UNSUPPORTED_VIDEO` → `UNRECOVERABLE`, remote thumbnail caching, and local/remote video HTTP `Range` (`206 Partial Content`) playback.
  - Run `corepack pnpm typecheck`, `corepack pnpm build`, `corepack pnpm test`, `node --test scripts/version-control.test.mjs`, `node scripts/sync-version.mjs --check`, `docker compose --profile edge config --quiet`, `bash scripts/test-integration.sh`, and `rtk proxy graphify update .`.
