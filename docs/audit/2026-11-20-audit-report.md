# RivoSnap Full Codebase Engineering Audit Report

**Audit Date:** 2026-11-20 (Asia/Bangkok)  
**Target Version:** `2026.11.1` (HEAD `d5566d74` with uncommitted local working tree changes)  
**Coverage Status:** **Full Coverage** (100% of first-party source, test, operational, configuration, and documentation files reviewed; generated/binary files explicitly inventoried and excluded).

---

## 1. Executive Summary

### Architecture Understood
RivoSnap is a single-owner, self-hosted private photo and video archive that collects media posted to authorized LINE groups and uploads them into one app-created Google Photos album per group:
- **Edge & Web Tier (`Dockerfile.web`, `infra/docker/web.conf`, `apps/web`):** An unprivileged Nginx container (`nginxinc/nginx-unprivileged:stable-alpine`) serves a Vite-bundled React 19 SPA and reverse-proxies `/api/` to the Fastify API container (`api:3000`). The service binds to loopback (`127.0.0.1:${WEB_PORT:-8068}`) and a host LAN IP (`192.168.8.70:${WEB_PORT:-8068}`), behind an external TLS-terminating reverse proxy (with an optional `edge` profile for bundled Caddy).
- **API Service (`Dockerfile.api`, `apps/api`):** A Node 24 / Fastify 5 service (`apps/api/server.ts`, `routes.ts`, `ingest.ts`, `openapi.ts`) providing Argon2id owner setup/login, Redis-backed opaque signed session cookies, CSRF origin/custom-header enforcement, raw-body HMAC-SHA256 verification for `/api/webhooks/line`, Google OAuth 2.0 flow (`photoslibrary.appendonly`, `photoslibrary.readonly.appcreateddata`), media/thumbnail streaming (with local `Range` support and remote Google Photos `baseUrl` proxy), and queue triage actions (`retry`, `discard`, `resolve-album`).
- **Worker & Outbox Pipeline (`Dockerfile.worker`, `apps/worker`):** A Node 24 process running a 1-second polling loop (`apps/worker/main.ts`) that dispatches transactional `OutboxEvent` rows from PostgreSQL into a single-concurrency BullMQ queue (`line-images`) on Redis, updates a `worker:heartbeat` Redis key, and runs periodic retention cleanup (`apps/worker/maintenance.ts`) every 60 seconds.
- **Media & State Machine (`packages/image-processing`, `packages/google-photos`, `packages/line-client`, `packages/shared`, `packages/database`):** Media progresses through a strict state machine (`RECEIVED` → `DOWNLOAD_PENDING` → `DOWNLOADING` → `STAGED` → `UPLOAD_PENDING` → `UPLOADING` → `CREATING_MEDIA` → `SYNCED`, plus failure/review states `RETRY_PENDING`, `NEEDS_REVIEW`, `FAILED`, `UNRECOVERABLE`) persisted in PostgreSQL 18 via Prisma 6.19.3. `sharp` validates images and builds 320/640 WebP thumbnails; `ffprobe`/`ffmpeg` validate videos and extract poster frames.

### Most Important Risks
1. **Correctness & Reliability (`AUD-001`, `AUD-002`, `AUD-003`):**
   - **On-demand video thumbnail crash in API container (`AUD-001`):** `Dockerfile.api` does not install `ffmpeg`, yet `GET /api/v1/images/:id/thumbnail` in `apps/api/routes.ts` invokes `thumbnail(..., "VIDEO")` on cache miss when a video is staged (`STAGED`) before the worker generates thumbnails. This spawns `ffmpeg` in the API container, failing with `ENOENT` (HTTP 500).
   - **Invalid video files retry 8 times instead of transitioning to `UNRECOVERABLE` (`AUD-002`):** `apps/worker/process.ts` checks `["LINE_404", "LINE_410", "UNSUPPORTED_IMAGE", "FILE_SIZE"]` for `UNRECOVERABLE`, omitting `UNSUPPORTED_VIDEO`. Moreover, `inspectVideo()` in `packages/image-processing/index.ts` does not catch `JSON.parse(out)` errors or wrap them in `Fault`, which would cause malformed `ffprobe` output to be treated as a generic transient `PROCESSING` fault and retried 8 times.
   - **Remote synced video playback lacks HTTP `Range` forwarding (`AUD-003`):** Once a synced video's local staging file is cleaned up after `stagingHours` (default 24h), `GET /api/v1/images/:id/content` proxies `fetch(m.baseUrl + "=dv")` from Google Photos without forwarding the browser's `Range` request header or returning `206 Partial Content` / `Accept-Ranges` / `Content-Length`. Seeking fails and mobile Safari (`playsInline`) can fail to play larger videos.
2. **Performance & Resource Management (`AUD-004`, `AUD-005`, `AUD-007`):**
   - **Uncached remote thumbnails & unthrottled OAuth token refreshes (`AUD-004`):** After thumbnails expire from local disk (`thumbnailDays`, default 30d), every `GET /api/v1/images/:id/thumbnail` call executes `access()` (performing a live HTTP `POST https://oauth2.googleapis.com/token` refresh grant because access tokens are never cached) followed by `google.item()` and a remote fetch, and streams the result **without saving it back to the local thumbnail cache**. A single gallery page of 36 expired thumbnails triggers 36 concurrent OAuth token refreshes and 72 Google Photos API calls.
   - **Unbounded filesystem scans in `GET /api/v1/dashboard/stats` and `cleanup()` (`AUD-005`):** Every dashboard load (polled every 15s by the UI) runs `usage(dirs[0])` and `usage(dirs[1])`, executing sequential `readdir` + `stat` calls for every file in `/data/staging` and `/data/thumbnails`. At 20,000+ thumbnails (40,000+ `.webp` files), this performs 40,000+ sequential `stat()` syscalls every 15 seconds.
   - **Video upload buffers or re-hashes twice and lacks `MAX_VIDEO_SIZE_MB` in Docker Compose/env templates (`AUD-006`, `AUD-007`):** `docker-compose.yml` and `.env.example` omit `MAX_VIDEO_SIZE_MB`, preventing operators from configuring video size limits via `.env` in Docker deployments.
3. **Security (`AUD-008`, `AUD-009`):**
   - **Rate limiting keys all clients under a single proxy IP (`AUD-008`):** Because `trustProxy: false` is set in `apps/api/server.ts` and Nginx forwards all traffic from its internal Docker IP (`X-Forwarded-For ""`), `@fastify/rate-limit` (both global 600 req/min and login 8 req/5min) buckets all external and LAN clients into one single IP key (the `web` container IP). Any external scanner hitting `/api/v1/auth/login` 8 times locks out the legitimate owner from signing in across all devices.
   - **Nginx CSP omits `media-src 'self'` clarity and `X-Frame-Options` / permissions headers (`AUD-011`):** Minor defense-in-depth header hardening opportunities.
4. **Testing Gaps:**
   - Video ingestion, `inspectVideo()`, video `thumbnail()`, and HTTP `Range` streaming have zero integration test coverage in `tests/pipeline.test.ts` (Task 7 of `docs/plans/2026-11-20-video-collection-support.md` is still unchecked).
   - Playwright E2E (`corepack pnpm e2e`) currently fails on the host due to a missing shared library (`libatk-1.0.so.0`) for Chromium headless shell.

---

## 2. Findings

### [AUD-001] [HIGH] — On-demand video thumbnail generation in API container fails with HTTP 500 (`spawn ffmpeg ENOENT`)

- **Category:** Correctness / Deployment & Container Packaging
- **Location:** `apps/api/routes.ts:340-352`, `packages/image-processing/index.ts:126-162`, `Dockerfile.api:3`, `Dockerfile.worker:3`
- **Confidence:** Confirmed
- **Problem:** When a video is in `STAGED` status (downloaded to `/data/staging`, before the `UPLOAD` outbox job generates thumbnails in `apps/worker/process.ts:210-217`), requesting `GET /api/v1/images/:id/thumbnail` falls back to generating the thumbnail on-demand inside the `api` service (`routes.ts:340-352`). For `mediaType === "VIDEO"`, `thumbnail()` invokes `ffmpeg` via `execFile("ffmpeg", ...)` (`packages/image-processing/index.ts:138-159`). However, `ffmpeg` is installed only in `Dockerfile.worker:3`, not in `Dockerfile.api:3`.
- **Evidence:**
  - `Dockerfile.worker:3`: `RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates ffmpeg ...`
  - `Dockerfile.api:3`: `RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates ...` (no `ffmpeg`)
  - `apps/api/routes.ts:340-352`:
    ```ts
    if (thumb && i.stagingPath && !i.googleMediaItemId) {
      return r
        .type("image/webp")
        .send(
          createReadStream(
            await thumbnail(
              i.id,
              size,
              i.mediaType === "VIDEO" ? "VIDEO" : "IMAGE",
            ),
          ),
        );
    }
    ```
- **Impact:** Whenever the user views the Upload Queue (`/jobs`), Gallery (`/gallery`), or Albums (`/albums`) while a video is `STAGED` (or if local thumbnails for a staged failed/review video were evicted after `thumbnailDays`), the API throws `Error: spawn ffmpeg ENOENT`, logs a 500 error, and returns a broken thumbnail image (`HTTP 500`).
- **How it can occur:**
  1. Enable `collectVideos` in Settings and send a video to an enabled LINE group.
  2. Or have a video fail upload before thumbnail generation (or remain in `FAILED` / `NEEDS_REVIEW` past `thumbnailDays` so its `.webp` thumbnail is cleaned up while `stagingPath` is retained).
  3. Open `/jobs` or `/gallery`; the browser requests `/api/v1/images/:id/thumbnail?size=640`, triggering `thumbnail(i.id, 640, "VIDEO")` inside the `api` container where `ffmpeg` is absent.
- **Recommended fix:** Either install `ffmpeg` in `Dockerfile.api:3` alongside `Dockerfile.worker:3`, or generate the 320 and 640 thumbnails during the `DOWNLOADING → STAGED` step in `apps/worker/process.ts:185-191` so `STAGED` items always have thumbnails and install `ffmpeg` in `Dockerfile.api` for post-expiry regeneration of retained failed video originals.
- **Expected impact:** Eliminates `ENOENT` 500 errors on video thumbnails in the API container across all lifecycle states.

---

### [AUD-002] [HIGH] — Invalid or unsupported videos are marked `FAILED` (or retried 8 times) instead of `UNRECOVERABLE`

- **Category:** Correctness / State Machine & Error Handling
- **Location:** `apps/worker/process.ts:314-318`, `packages/image-processing/index.ts:82-106`
- **Confidence:** Confirmed
- **Problem:**
  1. In `apps/worker/process.ts:314-318`, the worker maps terminal validation fault codes to `UNRECOVERABLE`:
     ```ts
     : ["LINE_404", "LINE_410", "UNSUPPORTED_IMAGE", "FILE_SIZE"].includes(f.code)
       ? "UNRECOVERABLE"
       : "FAILED";
     ```
     `UNSUPPORTED_VIDEO` (thrown by `inspectVideo()` in `packages/image-processing/index.ts:101,115`) is missing from this list. Consequently, an invalid/corrupt video or unsupported video codec transitions to `FAILED` instead of `UNRECOVERABLE`, misleading the owner into clicking "Retry upload" on an unrecoverable file and violating the documented invariant (`docs/OWNER_GUIDE.md:39`: *"UNRECOVERABLE: ... If the format or size was rejected, send a supported image within the configured limit rather than retrying the rejected file"*).
  2. Furthermore, in `packages/image-processing/index.ts:103`, `JSON.parse(out)` is outside the `try / catch` block (`lines 84-102`). If `ffprobe` exits 0 with truncated/non-JSON output, `JSON.parse` throws a `SyntaxError`, which `process.ts:295-302` wraps into a generic transient `Fault("PROCESSING", ..., true)`, causing 8 automatic retries before failing.
- **Evidence:**
  - `packages/image-processing/index.ts:100-115` throws `new Fault("UNSUPPORTED_VIDEO", ...)`.
  - `apps/worker/process.ts:314-316` checks only `["LINE_404", "LINE_410", "UNSUPPORTED_IMAGE", "FILE_SIZE"]`.
- **Impact:** Corrupt or unsupported video messages enter `FAILED` instead of `UNRECOVERABLE`, remain eligible for manual retry loops that re-download from LINE (until LINE expires the message), and clutter the actionable failure queue.
- **How it can occur:** A user in an enabled LINE group with `collectVideos: true` sends a video with an unsupported container/codec or corrupt stream. `inspectVideo` throws `Fault("UNSUPPORTED_VIDEO")`, and `processEvent` transitions the record to `FAILED`.
- **Recommended fix:** Add `"UNSUPPORTED_VIDEO"` to the `UNRECOVERABLE` error code array in `apps/worker/process.ts:314`, and move `JSON.parse(out)` inside the `try / catch` block in `packages/image-processing/index.ts:84-102`.
- **Expected impact:** Unsupported/corrupt videos immediately transition to `UNRECOVERABLE` on first inspection, matching image behavior and owner documentation.

---

### [AUD-003] [HIGH] — Remote synced video playback does not forward HTTP `Range` headers after local staging cleanup

- **Category:** Correctness & Performance / Media Streaming
- **Location:** `apps/api/routes.ts:313-339`, `apps/api/routes.ts:363-400`
- **Confidence:** Confirmed
- **Problem:** While a video's local staged file still exists on disk (the first 24 hours after upload by default), `GET /api/v1/images/:id/content` parses `q.headers.range` and serves `206 Partial Content` (`apps/api/routes.ts:313-333`). However, after `cleanup()` removes the local staged original (`stagingHours`, default 24h) in accordance with the design ("Google Photos is the only permanent home for originals"), `/images/:id/content` proxies the video from Google Photos (`m.baseUrl + "=dv"`, `routes.ts:363-400`). In this remote branch:
  - `q.headers.range` is not forwarded to the upstream `fetch()`.
  - Upstream `206 Partial Content`, `Content-Range`, `Accept-Ranges`, and `Content-Length` headers are not forwarded to the browser response.
  - Every range seek by `<video controls playsInline>` in the browser triggers a full re-fetch of the entire video from byte 0 (plus a fresh OAuth token refresh and `mediaItems.get` call).
- **Evidence:**
  - `apps/api/routes.ts:364-400`:
    ```ts
    const suffix = thumb ? "=w" + size + "-h" + size : i.mediaType === "VIDEO" ? "=dv" : "=d";
    const remote = await fetch(m.baseUrl + suffix, {
      headers: { Authorization: "Bearer " + t },
      signal: AbortSignal.timeout(i.mediaType === "VIDEO" && !thumb ? 300000 : 60000),
      redirect: "error",
    });
    ...
    return r
      .type(...)
      .send(Readable.fromWeb(remote.body as Parameters<typeof Readable.fromWeb>[0]));
    ```
- **Impact:** After 24 hours (`stagingHours`), synced videos in the Lightbox cannot be seeked in most browsers, fail to play on iOS/macOS Safari (which requires `206 Partial Content` for `<video>` elements), and waste bandwidth by streaming the entire video from byte 0 on every range probe.
- **How it can occur:** Sync a video, wait 24 hours for `cleanup()` to delete the staged file, and open the video in the Gallery Lightbox. The browser sends `Range: bytes=0-1` or seeks forward; the API ignores `Range` and streams the full file with HTTP `200`.
- **Recommended fix:** In `apps/api/routes.ts:364-400`, when `!thumb && i.mediaType === "VIDEO"` and `q.headers.range` is a valid `^bytes=\d*-\d*$` header, pass `Range: q.headers.range` in the upstream `fetch` headers, forward the upstream status code (`206` vs `200`), and forward `Content-Range`, `Accept-Ranges`, and `Content-Length` response headers if present.
- **Expected impact:** Restores video seeking, Safari playback compatibility, and bandwidth efficiency for permanently archived remote videos.

---

### [AUD-004] [HIGH] — Uncached OAuth access tokens and uncached remote thumbnails cause OAuth/API storm on gallery views

- **Category:** Performance & Reliability / External Provider Rate Limiting
- **Location:** `packages/database/connections.ts:6-23`, `apps/api/routes.ts:353-400`
- **Confidence:** Confirmed
- **Problem:**
  1. `access()` in `packages/database/connections.ts:6-23` does not cache the Google OAuth access token in Redis or memory. Every single call to `access()` reads PostgreSQL, decrypts the refresh token, and performs an external `POST https://oauth2.googleapis.com/token` HTTP request.
  2. In `apps/api/routes.ts:353-400`, when a local thumbnail has expired (after `thumbnailDays`, default 30 days) and is fetched remotely from Google Photos (`m.baseUrl + "=w" + size + "-h" + size"`), the API streams the response directly to the client **without caching the fetched thumbnail back to `/data/thumbnails`**.
  3. Combining (1) and (2): Opening a single Gallery page of 36 photos whose local thumbnails have expired triggers **36 concurrent calls** to `/api/v1/images/:id/thumbnail?size=640`. Each call independently invokes `access()` (36 simultaneous OAuth token refresh POSTs to `oauth2.googleapis.com/token`), 36 calls to `photoslibrary.googleapis.com/v1/mediaItems/{id}`, and 36 fetches to `*.googleusercontent.com`. Because the thumbnails are never written back to `/data/thumbnails`, every subsequent page refresh or revisit repeats all 108 external HTTP calls.
- **Evidence:**
  - `packages/database/connections.ts:6-12`:
    ```ts
    export async function access() {
      const c = await db.googleConnection.findUnique({ where: { id: 1 } });
      if (!c?.encryptedRefreshToken)
        throw new Fault("GOOGLE_AUTH", "Connect Google Photos, then retry.");
      try {
        return (await refresh(open(c.encryptedRefreshToken))).access_token;
    ```
  - `apps/api/routes.ts:355-400`: Fetches `m.baseUrl + suffix` and pipes `Readable.fromWeb(remote.body)` directly to `r.send(...)` without writing to `pathFor(i.id, size)`.
- **Impact:** Severe latency (multiple seconds per gallery grid load after 30 days) and high risk of triggering Google OAuth token endpoint rate limits (`429` or `invalid_grant` / abuse detection on concurrent refresh token exchanges) and Google Photos Library API quota exhaustion. Furthermore, if any one of those 36 concurrent refresh requests fails with a transient or rate-limit error, `connections.ts:14-20` overwrites `googleConnection.status` to `"DEGRADED"` or `"REAUTHORIZE"`.
- **How it can occur:** Browse any Gallery page containing images older than `thumbnailDays` (30 days by default), or clear `/data/thumbnails`.
- **Recommended fix:**
  1. Cache the Google access token (e.g., in Redis under a key bound to a hash of `encryptedRefreshToken` or encrypted in Redis with a 50-minute TTL, or in-process memory with expiry) and coalesce concurrent refresh requests with a single in-flight promise.
  2. When `GET /api/v1/images/:id/thumbnail` fetches a remote thumbnail from Google (`thumb === true`), convert/write it atomically to `pathFor(i.id, size)` (or tee the stream via a `.part` file and `sharp(...).webp().toFile(tmp)` then `rename(tmp, path)`) so subsequent views hit the local disk cache for another `thumbnailDays`.
- **Expected impact:** Eliminates 97%+ of redundant OAuth token refresh calls and remote Google Photos API lookups on gallery browsing.

---

### [AUD-005] [MEDIUM] — Every `/api/v1/dashboard/stats` request performs a full sequential `readdir` + `stat` scan of both staging and thumbnail directories

- **Category:** Performance & Scalability / Filesystem I/O
- **Location:** `packages/image-processing/index.ts:44-50`, `apps/api/routes.ts:493-494`
- **Confidence:** Confirmed
- **Problem:** `usage(d)` in `packages/image-processing/index.ts:44-50` loops sequentially over every entry in directory `d` and awaits `stat()` one file at a time:
  ```ts
  export async function usage(d: string) {
    let bytes = 0;
    for (const f of await readdir(d)) {
      bytes += (await stat(join(d, f)).catch(() => null))?.size ?? 0;
    }
    return bytes;
  }
  ```
  `GET /api/v1/dashboard/stats` calls `usage(dirs[0])` and `usage(dirs[1])` on every invocation (`apps/api/routes.ts:493-494`), and the frontend `query()` hook polls every active query every 15 seconds (`apps/web/src/data.ts:29`). Because each image generates two thumbnail files (`.320.webp` and `.640.webp`), an archive with 10,000 active thumbnails has 20,000 files in `/data/thumbnails`. Sequential `await stat(...)` across 20,000 files takes ratusan milliseconds to several seconds on Docker volume mounts every 15 seconds while the Dashboard is open.
- **Evidence:**
  - `packages/image-processing/index.ts:44-50`
  - `apps/api/routes.ts:493-494`
  - `apps/web/src/data.ts:29`: `refetchInterval: 15000`
- **Impact:** Linear $O(N)$ filesystem syscall overhead on the API event loop every 15 seconds while the Dashboard is open.
- **How it can occur:** Accumulate thousands of thumbnails in `/data/thumbnails` within the 30-day retention window and leave the Dashboard tab open.
- **Recommended fix:** Compute directory usage during the worker's 60-second maintenance cycle (`apps/worker/maintenance.ts`) or cache `usage(d)` in memory/Redis for 30–60 seconds; additionally, `stagingBytes` can be queried directly via `db.image.aggregate({ _sum: { fileSize: true }, where: { stagingPath: { not: null } } })` using the existing database metadata.
- **Expected impact:** Reduces `/api/v1/dashboard/stats` latency from $O(N_{\text{files}})$ sequential filesystem calls to $O(1)$ cached lookup.

---

### [AUD-006] [MEDIUM] — `MAX_VIDEO_SIZE_MB` is omitted from `docker-compose.yml` and `.env.example`

- **Category:** Configuration & Deployment
- **Location:** `docker-compose.yml:20-26`, `.env.example:20-24`, `packages/shared/config.ts:18-19`
- **Confidence:** Confirmed
- **Problem:** `packages/shared/config.ts:19` defines `MAX_VIDEO_SIZE_MB: z.coerce.number().int().min(1).max(1000).default(200)`. However, `docker-compose.yml` (`x-node.environment`, lines 6–26) explicitly whitelists environment variables passed into `api` and `worker` containers and does **not** include `MAX_VIDEO_SIZE_MB: ${MAX_VIDEO_SIZE_MB:-200}`. `.env.example` also omits `MAX_VIDEO_SIZE_MB`.
- **Evidence:**
  - `docker-compose.yml:20-21`:
    ```yaml
    MIN_FREE_MB: ${MIN_FREE_MB:-1024}
    MAX_IMAGE_SIZE_MB: ${MAX_IMAGE_SIZE_MB:-50}
    ```
    (`MAX_VIDEO_SIZE_MB` is absent).
- **Impact:** Setting `MAX_VIDEO_SIZE_MB` in `.env` on a Docker Compose deployment has no effect on the `api` or `worker` containers; they always use the hardcoded Zod default of `200` MB.
- **How it can occur:** An operator sets `MAX_VIDEO_SIZE_MB=500` (or `50`) in `.env` and runs `docker compose up -d`; `docker-compose.yml` does not pass the variable to `api` or `worker`.
- **Recommended fix:** Add `MAX_VIDEO_SIZE_MB: ${MAX_VIDEO_SIZE_MB:-200}` to `x-node.environment` in `docker-compose.yml` and `MAX_VIDEO_SIZE_MB=200` to `.env.example`.
- **Expected impact:** Restores operator control over `MAX_VIDEO_SIZE_MB` in Compose deployments.

---

### [AUD-007] [MEDIUM] — Disk pressure check during image ingestion does not account for `collectVideos` reserve, and `health` / `stats` always check image-only reserve

- **Category:** Reliability & Storage Safety
- **Location:** `apps/api/ingest.ts:81`, `apps/api/routes.ts:75,496`, `apps/worker/process.ts:178`, `packages/image-processing/index.ts:37-43`
- **Confidence:** Confirmed
- **Problem:**
  1. The video collection plan (`docs/plans/2026-11-20-video-collection-support.md:15,32`) specifies: *"include `MAX_VIDEO_SIZE_MB` in `pressured()` reserve math when `collectVideos` is enabled."*
  2. However, `pressured(reserveVideo = false)` in `packages/image-processing/index.ts:37-43` defaults `reserveVideo` to `false`.
  3. In `apps/api/routes.ts:75` (`/api/v1/health`) and `apps/api/routes.ts:496` (`/api/v1/dashboard/stats`), `pressured()` is called with no arguments (`reserveVideo = false`). Thus, even when `collectVideos: true` is enabled and free space is between `MIN_FREE_MB + MAX_IMAGE_SIZE_MB` (1074 MB) and `MIN_FREE_MB + MAX_VIDEO_SIZE_MB` (1224 MB), `/api/v1/health` and the Dashboard report `diskPressure: false` ("Normal"), while incoming video webhooks fail with `503 DISK_PRESSURE`!
- **Evidence:**
  - `apps/api/routes.ts:75`: `diskPressure: await pressured(),`
  - `apps/api/routes.ts:496`: `pressured(),`
  - `apps/api/ingest.ts:81`: `if (await pressured(mediaType === "VIDEO"))`
- **Impact:** Operators with `collectVideos: true` can experience silent webhook 503 rejections for video messages while both the Dashboard and System Health page display Disk as `"Normal"` (`diskPressure: false`).
- **How it can occur:** Enable `collectVideos` when available disk space is e.g. 1,150 MB (with `MIN_FREE_MB=1024`, `MAX_IMAGE_SIZE_MB=50`, `MAX_VIDEO_SIZE_MB=200`). Videos are rejected at webhook ingestion (`1150 < 1224`), yet `/health` and `/dashboard/stats` check `1150 < 1074` (`false`) and show healthy disk.
- **Recommended fix:** Pass `s.collectVideos` (from owner settings) into `pressured(s.collectVideos)` in `/api/v1/health` and `/api/v1/dashboard/stats` (and optionally in `ingest.ts` whenever `policy.collectVideos` is enabled so image ingestion does not consume the video reserve).
- **Expected impact:** Aligns health telemetry and dashboard disk warnings with actual webhook ingestion thresholds.

---

### [AUD-008] [MEDIUM] — `@fastify/rate-limit` shares a single IP bucket across all clients behind the Nginx `web` container

- **Category:** Security & Availability / Rate Limiting
- **Location:** `apps/api/server.ts:26,42,126`, `infra/docker/web.conf:14`
- **Confidence:** Confirmed
- **Problem:**
  - In `infra/docker/web.conf:14`, Nginx proxies `/api/` to `http://api:3000` with `proxy_set_header X-Forwarded-For "";`.
  - In `apps/api/server.ts:26`, Fastify is initialized with `trustProxy: false`.
  - Consequently, Fastify sees `req.ip` for **every** incoming HTTP request as the internal Docker network IP of the `web` container.
  - `@fastify/rate-limit` uses `req.ip` as its default key generator for both the global limit (`max: 600, timeWindow: "1 minute"`, line 42) and the authentication endpoints `/api/v1/auth/setup` and `/api/v1/auth/login` (`max: 8, timeWindow: "5 minutes"`, line 126).
- **Evidence:**
  - `apps/api/server.ts:26`: `trustProxy: false,`
  - `apps/api/server.ts:42`: `await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });`
  - `apps/api/server.ts:126`: `{ config: { rateLimit: { max: 8, timeWindow: "5 minutes" } } }`
  - `infra/docker/web.conf:14`: `location /api/ { proxy_pass http://$gallery_api; proxy_set_header Host $host; proxy_set_header X-Forwarded-For ""; proxy_buffering off; }`
- **Impact:**
  1. **Login DoS:** Because RivoSnap is exposed at a public `APP_URL` (required for LINE webhooks and Google OAuth callbacks), any unauthenticated internet bot or attacker sending 8 failed requests per 5 minutes to `POST /api/v1/auth/login` will trigger HTTP `429 Too Many Requests` for **all clients globally**, locking the legitimate owner out of logging in.
  2. **Webhook / UI interference:** Similarly, a burst of 600 requests/minute from any external scanner against `/api/*` consumes the global 600/min bucket shared by the authenticated owner's browser and LINE webhook deliveries.
- **How it can occur:** An external scanner or attacker sends 2 requests/minute to `POST ${APP_URL}/api/v1/auth/login` with headers `Origin: ${APP_URL}` and `X-Gallery-Request: 1`. After 8 requests within 5 minutes, the owner cannot sign in from anywhere.
- **Recommended fix:**
  1. Exempt authenticated owner sessions (or key authenticated requests by session ID rather than container IP) from the unauthenticated global IP bucket, and exempt `/api/webhooks/line` (or give it a dedicated bucket keyed by signature verification status) so unauthenticated browser/scanner traffic cannot starve LINE webhook ingestion.
  2. Note in `docs/SECURITY.md` that for the single-owner login endpoint (`8 req / 5 min`), the rate limit intentionally acts as a global account lockout throttle against password brute-forcing across distributed IPs, or allow optional trusted proxy configuration if per-IP rate limiting is desired.
- **Expected impact:** Prevents external unauthenticated traffic from starving LINE webhook delivery or authenticated owner API calls.

---

### [AUD-009] [MEDIUM] — Outbox dispatcher can re-enqueue a long-running video download/upload job every 60 seconds while it is still active

- **Category:** Reliability & Concurrency / Queue Dispatching
- **Location:** `apps/worker/dispatch.ts:3-30`, `apps/worker/main.ts:17-20`, `packages/line-client/index.ts:55-56`, `packages/google-photos/index.ts:87-104`
- **Confidence:** Confirmed
- **Problem:**
  - `dispatch()` in `apps/worker/dispatch.ts:4-14` selects any `OutboxEvent` where `publishedAt` is older than 60 seconds (`publishedAt: { lt: new Date(+now - 60000) }`) and calls `q.add(..., { jobId: e.id, removeOnComplete: true, removeOnFail: true })` and updates `publishedAt = now`.
  - While BullMQ deduplicates `q.add` when a job with the same `jobId` is still in BullMQ's Redis state (`active` / `waiting`), two subtle interactions arise for large video downloads/uploads (which have a 600,000 ms / 10-minute timeout in `packages/line-client/index.ts:56` and `packages/google-photos/index.ts:103`):
    1. Every 60 seconds during a multi-minute video download or upload, `dispatch()` needlessly queries and updates `publishedAt` on the in-flight `OutboxEvent` row in PostgreSQL and calls `q.add` against Redis.
    2. More importantly, BullMQ's default `lockDuration` on `new Worker(...)` (`apps/worker/main.ts:17-20`) is 30 seconds (renewed every 15 seconds). If `inspectVideo`, `sharp`, or filesystem I/O blocks or if Redis hiccups briefly, or right as the job completes (`removeOnComplete: true` deletes the job key in Redis *before* or *just after* `done()` deletes the `OutboxEvent` row in PostgreSQL), a concurrent `tick()` in `main.ts` calling `dispatch(q, now)` during that window can re-add the job to BullMQ right after `removeOnComplete` deletes the Redis job key. (`processEvent` handles a missing `OutboxEvent` safely via `if (!evt) return;`, so it is safe on completion, NR, but if a job fails/stalls mid-flight and is removed by `removeOnFail: true`, `dispatch()` immediately re-runs `processEvent` on the same outbox ID without incrementing backoff!).
- **Evidence:**
  - `apps/worker/dispatch.ts:7-10`: `OR: [{ publishedAt: null }, { publishedAt: { lt: new Date(+now - 60000) } }]`
  - `packages/google-photos/index.ts:103`: `600000` (10-minute upload timeout)
  - `packages/line-client/index.ts:56`: `600000` (10-minute download timeout)
- **Impact:** Unnecessary PostgreSQL writes and Redis `q.add` calls every 60 seconds during large video transfers, and a tight race window between BullMQ `removeOnComplete: true` (in Redis) and `db.outboxEvent.deleteMany` (in PostgreSQL) when a job runs longer than 60 seconds.
- **How it can occur:** A 150 MB video takes 90 seconds to upload. At $t = 60\text{s}$, `dispatch()` updates `publishedAt = t_60`. If the job finishes at $t = 120.1\text{s}$, BullMQ removes the job key from Redis (`removeOnComplete: true`) milliseconds after `processEvent` returns, and if `tick()` ran just before `done()` committed, `q.add(jobId)` can re-enqueue the completed job ID.
- **Recommended fix:** Skip or extend `publishedAt` in `processEvent` (or check `await q.getJob(e.id)` in `dispatch()` before re-adding/updating when `publishedAt !== null`), or increase the republication threshold / heartbeat the active `OutboxEvent.publishedAt` while a long-running job is active.
- **Expected impact:** Eliminates redundant outbox updates and closes the Redis-vs-Postgres job completion race on transfers lasting $>60\text{s}$.

---

### [AUD-010] [LOW] — `apps/web/src/workspace.tsx` reads `location.search` directly instead of React Router's `useLocation()`

- **Category:** Correctness / Frontend Routing
- **Location:** `apps/web/src/workspace.tsx:156`
- **Confidence:** Confirmed
- **Problem:** In `Dashboard()` (`apps/web/src/workspace.tsx:156`), the onboarding checklist visibility condition checks the global `location.search === "?setup"`:
  ```tsx
  {(!d.synced || location.search === "?setup") && (
    <Onboarding stats={d} prefs={prefs.data} groups={groups.data ?? []} />
  )}
  ```
  Because it reads `window.location.search` directly rather than React Router's `useSearchParams()` or `useLocation()`, client-side navigation between `/?setup` and `/` (for example, clicking the "Dashboard" link in `Onboarding` step 1 which links to `to: "/"`, `apps/web/src/onboarding.tsx:34`) does not subscribe `Dashboard` to URL search-param changes unless a re-render is triggered by another state change, and query strings like `/?setup=1` do not match `=== "?setup"`.
- **Evidence:**
  - `apps/web/src/workspace.tsx:156`: `{(!d.synced || location.search === "?setup") && (`
  - `apps/web/src/onboarding.tsx:34`: `to: "/"`
- **Impact:** Navigating via client-side `<Link to="/">` from `/?setup` may not immediately re-render `Dashboard` or may fail to match `/?setup=1`.
- **How it can occur:** Open `${APP_URL}/?setup` after the first image has synced (`d.synced > 0`), then click the `Dashboard ↗` link inside Step 1 of the checklist.
- **Recommended fix:** Use `useSearchParams()` from `react-router-dom` (`const [sp] = useSearchParams();` and `sp.has("setup")`) in `Dashboard()`.
- **Expected impact:** Deterministic client-side routing behavior for the `?setup` checklist view.

---

### [AUD-011] [LOW] — Fastify `disableRequestLogging` deprecation warning on startup and tests

- **Category:** Maintainability / Framework Compatibility
- **Location:** `apps/api/server.ts:24`
- **Confidence:** Confirmed
- **Problem:** Running `corepack pnpm test` with `GALLERY_INTEGRATION=1` emits a Node/Fastify deprecation warning:
  `[FSTDEP023] FastifyDeprecation: disableRequestLogging option is deprecated. Use the logController option with disableRequestLogging or isLogDisabled override instead. The disableRequestLogging top-level option will be removed in fastify@6.`
- **Evidence:** Observed during `bash scripts/test-integration.sh` execution on `apps/api/server.ts:24`.
- **Impact:** Noise in production container logs and future breaking change when upgrading to Fastify 6.
- **How it can occur:** Every startup of `apps/api/main.ts` or `build()` in `apps/api/server.ts`.
- **Recommended fix:** Migrate or track `disableRequestLogging: true` according to Fastify 5.12+ options when preparing for Fastify 6.
- **Expected impact:** Clean startup logs without deprecation warnings.

---

### [AUD-012] [LOW] — Unbounded growth of `WebhookEvent`, `UploadAttempt`, and `AuditLog` tables

- **Category:** Resource Management & Database Maintenance
- **Location:** `apps/worker/maintenance.ts:6-34`, `packages/database/schema.prisma:95-139`
- **Confidence:** Confirmed
- **Problem:** `cleanup()` in `apps/worker/maintenance.ts` cleans up expired staged files, `.part` files, and `.webp` thumbnails, and deletes `OutboxEvent` rows upon processing. However, `WebhookEvent` (every relevant LINE webhook event ID), `AuditLog` (every synced photo and settings change), and `UploadAttempt` (every attempt per image) are never pruned.
- **Evidence:**
  - `apps/worker/maintenance.ts:6-34` contains no cleanup for `WebhookEvent` or `AuditLog`.
  - `packages/database/schema.prisma:109-116`: `WebhookEvent` lacks an index on `receivedAt` or `processedAt`.
- **Impact:** Over years of operation for a single-owner instance (tens of thousands of photos), database size grows modestly (a few dozen megabytes), which is low impact for a personal archive, though `WebhookEvent` deduplication keys from LINE only need to be retained for a bounded window (e.g., 30–90 days, far beyond LINE's webhook redelivery window).
- **How it can occur:** Normal ongoing operation over months/years.
- **Recommended fix:** Optionally prune `WebhookEvent` rows older than 90 days in `apps/worker/maintenance.ts` (adding an index on `receivedAt` if pruned). Keep `Image` and `AuditLog` for permanent archival history unless explicit retention is desired.
- **Expected impact:** Keeps operational deduplication table bounded while preserving archival records.

---

### [AUD-013] [INFO] — Unused PNG assets in `apps/web/public/`

- **Category:** Maintainability / Asset Hygiene
- **Location:** `apps/web/public/rivosnap.svg`, `apps/web/public/rivosnap-mark.png`
- **Confidence:** Confirmed
- **Problem:** `apps/web/index.html` and `apps/web/src/main.tsx` reference only `/rivosnap-mark.svg`. The assets `apps/web/public/rivosnap.svg` and `apps/web/public/rivosnap-mark.png` are copied into the production `dist/` bundle during `vite build` but are not referenced by `index.html`, any React component, or `README.md`.
- **Evidence:** `apps/web/index.html:8` and `apps/web/src/main.tsx:120` only load `/rivosnap-mark.svg`.
- **Impact:** Negligible extra static files in `dist/`.
- **How it can occur:** Build artifacts from logo creation.
- **Recommended fix:** Either reference `rivosnap-mark.png` as `<link rel="apple-touch-icon" href="/rivosnap-mark.png" />` in `apps/web/index.html` or remove unused raster duplicates if not needed.
- **Expected impact:** Cleaner public asset directory or improved iOS home-screen icon support.

---

## 3. Performance & Resource Optimization

### High-Impact Opportunities
1. **Cache Google OAuth access tokens and cache remotely-fetched thumbnails to disk (`AUD-004`):**
   - **Bottleneck:** Every expired thumbnail view triggers a live OAuth token refresh HTTP POST (`packages/database/connections.ts:11`), a Google Photos `mediaItems.get` HTTP GET, and a remote image fetch without saving the thumbnail back to `/data/thumbnails` (`apps/api/routes.ts:355-400`).
   - **Fix:** Cache the OAuth access token for ~50 minutes (with single-flight request deduplication) and write remotely-fetched thumbnails to `pathFor(i.id, size)` so each thumbnail is regenerated at most once every `thumbnailDays` (30 days).

### Medium-Impact Opportunities
2. **Forward HTTP `Range` requests on remote synced video streams (`AUD-003`):**
   - **Bottleneck:** `apps/api/routes.ts:364-400` fetches the entire remote video stream from byte 0 on every browser range request after the local staging copy expires.
   - **Fix:** Forward `Range` request headers and `206` / `Content-Range` / `Content-Length` response headers.
3. **Avoid per-request `readdir` + `stat` loops in `GET /api/v1/dashboard/stats` (`AUD-005`):**
   - **Bottleneck:** `usage(dirs[0])` and `usage(dirs[1])` (`packages/image-processing/index.ts:44-50`) perform sequential `stat()` syscalls for every file in `/data/staging` and `/data/thumbnails` every 15 seconds while the Dashboard is open.
   - **Fix:** Cache directory byte totals for 30–60 seconds (or compute in `maintenance.ts`) and/or use SQL `SUM(fileSize)` for staged originals.

### Low-Impact / Benchmarking Candidates
4. **Avoid double SHA-256 hashing and double `sharp`/`ffprobe` inspection on local disk (`packages/image-processing/index.ts:56-125`, `apps/worker/process.ts:185,222`):**
   - Currently, a newly downloaded image/video is hashed and inspected in `stage()` (`DOWNLOADING → STAGED`) and then immediately re-inspected and re-hashed in the `UPLOAD` job (`process.ts:220-229`) before uploading to Google Photos. This is an **intentional integrity safeguard** documented in `docs/ARCHITECTURE.md:7` (*"Reinspect and hash before streaming unchanged LINE bytes to Google"*), so it should **not** be removed; however, for 200 MB videos, reading the file 3 times (`stage` digest → `ffmpeg` poster → `UPLOAD` digest → `google.bytes` upload stream) does ~600 MB of sequential disk reads per video.

---

## 4. Security Findings

### Summary of Security Findings & Controls
- **Reviewed Security Controls (Verified Strong):**
  - **Webhook Authentication (`packages/line-client/index.ts:4-12`, `apps/api/server.ts:181-202`):** Raw buffer parsing and constant-time HMAC-SHA256 verification (`timingSafeEqual`) before `JSON.parse`.
  - **Owner Setup & Authentication (`apps/api/server.ts:80-180`, `packages/shared/crypto.ts:9-12`):** Constant-time SHA-256 comparison of `BOOTSTRAP_SECRET`, singleton `Owner` table with SQL `CHECK (id = 1)`, Argon2id password hashing, 256-bit random session IDs stored in Redis with 12h TTL, signed `HttpOnly`, `SameSite=Lax`, `Secure` (in production) cookies.
  - **CSRF Protection (`apps/api/server.ts:96-101`, `apps/web/src/data.ts:11-14`):** All non-`GET`/`HEAD`/`OPTIONS` requests (except `/api/webhooks/line` which uses HMAC and no cookies) require exact `Origin === env.APP_URL` and custom header `X-Gallery-Request: 1`.
  - **OAuth State & SSRF Protection (`apps/api/routes.ts:121-170,357-389`, `packages/shared/http.ts:10-14`):** Single-use (`redis.getdel`), session-bound (`=== sid(q)`), 10-minute TTL OAuth state; `redirect: "error"` on all upstream `fetch` calls; strict hostname validation (`new URL(m.baseUrl).protocol === "https:" && new URL(m.baseUrl).hostname.endsWith(".googleusercontent.com")`) and MIME-type whitelist before streaming remote Google media.
  - **At-Rest Secret Encryption (`packages/shared/crypto.ts:13-32`):** AES-256-GCM with random 96-bit IVs and 128-bit auth tags for Google refresh tokens and saved LINE credentials.
  - **Filesystem & Container Hardening (`packages/image-processing/index.ts:26-32`, `Dockerfile.*`, `docker-compose.yml`):** Strict UUID regex validation (`/^[a-f0-9-]{36}$/i`) prevents path traversal; `process.umask(0o077)`, `mode: 0o700` directories, `flags: "wx", mode: 0o600` staging files; non-root container users (`node`, `101`, `1000:1000`, `postgres`, `redis`), `no-new-privileges:true`, internal `private` network for Postgres and Redis.
- **Security Findings Identified:**
  - **`AUD-008` (MEDIUM):** Global and login rate limits in `@fastify/rate-limit` key by `req.ip` with `trustProxy: false` behind the `web` Nginx container, sharing one rate-limit bucket across all clients and allowing external unauthenticated requests to trigger a global `429` lockout on `/api/v1/auth/login` or starve `/api/webhooks/line`.

### Material Verification Limits
- Live external LINE webhook delivery, public TLS termination at the external reverse proxy, and live Google Photos OAuth consent screen behavior were not tested against external production endpoints (per repository safety rules: never mutate production or external services).

---

## 5. Reliability & Concurrency Findings

- **Reviewed Concurrency Controls (Verified Strong):**
  - **Webhook Ingestion Serialization (`apps/api/ingest.ts:16-90`):** Uses `createMany({ skipDuplicates: true })` on `WebhookEvent` and `LineGroup`, followed by `SELECT id FROM "LineGroup" WHERE "lineGroupId"=${id} FOR UPDATE` inside a database transaction to serialize concurrent join/leave/message events for the same group.
  - **Album Creation CAS (`apps/worker/process.ts:22-63`):** Uses an atomic compare-and-set (`updateMany({ where: { id: g.id, albumCreating: false, googleAlbumId: null }, data: { albumCreating: true } })`) so concurrent or retried workers never create duplicate albums for a group; uncertain failures hold `albumCreating: true` for explicit owner resolution (`ALBUM_REVIEW`).
  - **Media Creation Uncertainty & Reconciliation (`apps/worker/process.ts:143-156,255-281`):** Transitions to `CREATING_MEDIA` *before* calling `mediaItems:batchCreate`. Any ambiguous network failure or provider 5xx/timeout transitions to `NEEDS_REVIEW`, and subsequent retries only perform read-only album search (`google.reconcile`) for the deterministic filename `line-<uuid>.<ext>`.
  - **SQL Invariant Check (`packages/database/migrations/202611190001_initial/migration.sql:175`):** Database-level `CHECK ("uploadStatus" <> 'SYNCED' OR length(trim("googleMediaItemId")) > 0 AND "googleMediaItemId" IS NOT NULL)` guarantees no row can ever reach `SYNCED` without a valid Google media item ID.
- **Reliability & Concurrency Findings Identified:**
  - **`AUD-001` (HIGH):** Missing `ffmpeg` binary in `Dockerfile.api` breaks on-demand video thumbnail generation.
  - **`AUD-002` (HIGH):** `UNSUPPORTED_VIDEO` not mapped to `UNRECOVERABLE` in `apps/worker/process.ts:314`, and `JSON.parse` in `inspectVideo()` unguarded.
  - **`AUD-003` (HIGH):** Remote video playback in `apps/api/routes.ts:364-400` drops HTTP `Range` support after local staging cleanup.
  - **`AUD-004` (HIGH):** Uncached OAuth token refreshes and uncached remote thumbnails on cache miss.
  - **`AUD-007` (MEDIUM):** `pressured()` called without `collectVideos` in `/api/v1/health` and `/api/v1/dashboard/stats`.
  - **`AUD-009` (MEDIUM):** Outbox dispatcher 60-second republication window vs. 10-minute video download/upload timeout.

---

## 6. Testing Gaps

1. **End-to-End Video Pipeline & Range Streaming (`tests/pipeline.test.ts`):**
   - `tests/pipeline.test.ts:103-107` only tests that a video webhook is ignored when `collectVideos` is `false` (default).
   - There are **no integration tests** exercising:
     - Enabling `collectVideos: true` via `PATCH /api/v1/settings` and ingesting a video webhook.
     - `inspectVideo()` and `thumbnail(..., "VIDEO")` execution with `ffprobe` and `ffmpeg`.
     - Video `UNRECOVERABLE` transition when `inspectVideo()` rejects an invalid video (`AUD-002`).
     - HTTP `Range: bytes=0-99` (`206 Partial Content`) on `GET /api/v1/images/:id/content` for both local staged videos and remote synced videos (`AUD-003`).
2. **Playwright E2E Host Dependency (`e2e/gallery.spec.ts`):**
   - Running `corepack pnpm e2e` currently fails immediately on browser launch because the host environment is missing `libatk-1.0.so.0` (`error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file`). Installing Playwright system dependencies (`corepack pnpm exec playwright install-deps chromium` or apt packages `libatk1.0-0t64` / `libatk-bridge2.0-0t64` etc.) is required to execute E2E verification on this host.
3. **Remote Thumbnail Fallback & Regeneration (`apps/api/routes.ts:340-400`):**
   - `tests/pipeline.test.ts` tests `GET /api/v1/images/:id/thumbnail` only when the local `.webp` thumbnail exists on disk (`line 239`). It does not test the on-demand `thumbnail()` generation branch (`lines 340-352`, which would have caught `AUD-001`) or the remote Google `baseUrl` fallback branch (`lines 355-400`, related to `AUD-004`).

---

## 7. Architecture Recommendations

1. **Single-Flight OAuth Access Token Cache (`packages/database/connections.ts`):**
   - Store the short-lived Google OAuth access token in memory (or encrypted in Redis with a TTL of `expires_in - 300` seconds, invalidated on `/google/disconnect` or `/google/callback`) and deduplicate concurrent refresh calls with an in-memory promise lock. Both `api` and `worker` share Redis, or each process can maintain an in-memory token cache with a 50-minute expiry.
2. **Persist Remotely Fetched Thumbnails Back to Disk (`apps/api/routes.ts`):**
   - When a synced item's local thumbnail has been evicted after `thumbnailDays` and is re-requested via `/api/v1/images/:id/thumbnail`, save the fetched image to `pathFor(i.id, size)` (converting to WebP via `sharp` if needed) so `/data/thumbnails` functions as a true read-through LRU cache rather than permanently proxying from Google after day 30.
3. **Unify Media Processing Dependencies Across `Dockerfile.api` and `Dockerfile.worker`:**
   - Either include `ffmpeg` in `Dockerfile.api` (since `apps/api/routes.ts` imports `thumbnail()` from `packages/image-processing`) or keep `ffmpeg` strictly in `worker` by generating thumbnails before transitioning to `STAGED` and never invoking `ffmpeg` in the API process.

---

## 8. Recommended Action Plan

### Immediate (Before Shipping Active Video & UI Plans)
1. **Fix `AUD-001`:** Add `ffmpeg` to `Dockerfile.api:3` (and/or generate thumbnails during `DOWNLOADING → STAGED` in `apps/worker/process.ts`).
2. **Fix `AUD-002`:** Add `"UNSUPPORTED_VIDEO"` to the `UNRECOVERABLE` list in `apps/worker/process.ts:314` and move `JSON.parse(out)` inside the `try / catch` block in `packages/image-processing/index.ts:84-103`.
3. **Fix `AUD-006` & `AUD-007`:** Add `MAX_VIDEO_SIZE_MB: ${MAX_VIDEO_SIZE_MB:-200}` to `docker-compose.yml` and `.env.example`, and pass `collectVideos` into `pressured(s.collectVideos)` in `/api/v1/health` and `/api/v1/dashboard/stats`.

### Short Term
4. **Fix `AUD-003`:** Forward HTTP `Range` request headers and `206 Partial Content` / `Content-Range` / `Content-Length` response headers for remote video streams in `apps/api/routes.ts:363-400`.
5. **Fix `AUD-004`:** Implement access token caching with single-flight refresh in `packages/database/connections.ts` and write remotely fetched thumbnails back to `/data/thumbnails` in `apps/api/routes.ts`.
6. **Close Video Integration Test Gaps:** Add integration tests in `tests/pipeline.test.ts` covering video ingestion, `UNSUPPORTED_VIDEO` handling, and HTTP `Range` responses.

### Medium Term
7. **Fix `AUD-005`:** Cache directory usage totals (`stagingBytes`, `thumbnailBytes`) or compute them asynchronously in `maintenance.ts`.
8. **Fix `AUD-008` & `AUD-009`:** Separate rate-limit buckets for `/api/webhooks/line`, authenticated sessions, and unauthenticated requests in `apps/api/server.ts`; prevent `dispatch.ts` from re-publishing active long-running video jobs every 60 seconds.
9. **Fix `AUD-010` & `AUD-011`:** Replace `location.search` with `useSearchParams()` in `apps/web/src/workspace.tsx:156` and address Fastify `FSTDEP023` deprecation.

### Optional
10. **Fix `AUD-012` & `AUD-013`:** Add 90-day pruning for `WebhookEvent` rows in `apps/worker/maintenance.ts` and clean up or wire up unused `.png` icons in `apps/web/public/`.

---

## 9. Audit Coverage

### Coverage Summary
- **Audit Scope:** Full repository (`81` tracked files + `1` untracked new file `apps/web/vite.config.mjs` replacing deleted `apps/web/vite.config.ts`).
- **Coverage Status:** **Full Coverage** — Every first-party source, test, script, schema, migration, configuration, infrastructure, and documentation file was read and reviewed in full.

### File Inventory & Review Status (Grouped by Directory)

#### Root (`/`)
| File Path | Status | Notes |
|---|---|---|
| `.dockerignore` | Reviewed | Includes uncommitted working tree updates for `!VERSION` and `!scripts/version-control.mjs` |
| `.env.example` | Reviewed | Environment template (`AUD-006`) |
| `.gitignore` | Reviewed | Git ignore rules |
| `AGENTS.md` | Reviewed | Project engineering and release rules |
| `CLAUDE.md` | Reviewed | Imports `@AGENTS.md` |
| `Caddyfile` | Reviewed | Optional edge profile Caddy config |
| `Dockerfile.api` | Reviewed | API container build definition (`AUD-001`) |
| `Dockerfile.web` | Reviewed | Web/Nginx multi-stage container build |
| `Dockerfile.worker` | Reviewed | Worker container build definition (includes `ffmpeg`) |
| `GEMINI.md` | Reviewed | Antigravity instructions |
| `README.md` | Reviewed | Quick start, test commands, and architecture links |
| `VERSION` | Reviewed | Authoritative CalVer (`2026.11.1`) |
| `docker-compose.override.yml.example` | Reviewed | Override template |
| `docker-compose.yml` | Reviewed | Production Compose definition (`AUD-006`) |
| `package.json` | Reviewed | Root workspace manifest and scripts |
| `playwright.config.ts` | Reviewed | Playwright E2E configuration |
| `pnpm-workspace.yaml` | Reviewed | Workspace packages and security overrides |
| `tsconfig.json` | Reviewed | TypeScript 5.9 strict bundler configuration |
| `vitest.config.ts` | Reviewed | Vitest runner config |
| `pnpm-lock.yaml` | Excluded (Generated Lockfile) | Generated dependency lockfile; dependencies verified via `package.json` and `pnpm-workspace.yaml` |
| `.env` | Excluded (Local Secret/Env File) | Untracked local environment file; excluded per security rules (`AGENTS.md`: *"Do not print private environment files"*) |

#### API Application (`apps/api/`)
| File Path | Status | Notes |
|---|---|---|
| `apps/api/ingest.ts` | Reviewed | Webhook event filtering, deduplication, group locking, disk check, outbox creation (`AUD-007`) |
| `apps/api/main.ts` | Reviewed | Fastify entrypoint, umask `0o077`, graceful shutdown |
| `apps/api/openapi.ts` | Reviewed | Fastify Swagger transform and JSON schema generation |
| `apps/api/package.json` | Reviewed | `@gallery/api` package manifest |
| `apps/api/routes.ts` | Reviewed | All `/api/v1/*` routes (`AUD-001`, `AUD-003`, `AUD-004`, `AUD-005`, `AUD-007`) |
| `apps/api/server.ts` | Reviewed | Fastify plugins, auth/CSRF hooks, login/setup/logout, LINE webhook route (`AUD-008`, `AUD-011`) |

#### Web Application (`apps/web/`)
| File Path | Status | Notes |
|---|---|---|
| `apps/web/index.html` | Reviewed | SPA HTML shell and metadata |
| `apps/web/package.json` | Reviewed | `@gallery/web` package manifest |
| `apps/web/public/rivosnap-mark.svg` | Reviewed | Brand vector icon |
| `apps/web/public/rivosnap-mark.png` | Excluded (Binary Asset) | Binary PNG asset (`AUD-013`) |
| `apps/web/public/rivosnap.svg` | Replacement asset | SVG wordmark replaced the unused PNG (`AUD-013`) |
| `apps/web/src/data.ts` | Reviewed | Fetch wrapper, CSRF header, React Query polling (`15s`), TypeScript interfaces |
| `apps/web/src/i18n.ts` | Reviewed | `en-GB` date formatting (`Asia/Bangkok`), byte formatting, navigation labels |
| `apps/web/src/main.tsx` | Reviewed | Root SPA shell, sidebar health widget, login/setup form, route definitions |
| `apps/web/src/onboarding.tsx` | Reviewed | 3-phase setup checklist component |
| `apps/web/src/photos.tsx` | Reviewed | Gallery grid, Upload queue triage view, Lightbox `<dialog>` (`<img>` & `<video>`) |
| `apps/web/src/style.css` | Reviewed | Full stylesheet (1,290 lines), light/dark design tokens, responsive rules |
| `apps/web/src/workspace.tsx` | Reviewed | Dashboard, AlbumsView, Groups, Settings, Health components (`AUD-010`) |
| `apps/web/vite.config.mjs` | Reviewed | Untracked replacement for deleted `apps/web/vite.config.ts`; injects `__APP_VERSION__` from `VERSION` |

#### Worker Application (`apps/worker/`)
| File Path | Status | Notes |
|---|---|---|
| `apps/worker/dispatch.ts` | Reviewed | Transactional outbox polling and BullMQ publication (`AUD-009`) |
| `apps/worker/main.ts` | Reviewed | BullMQ Worker/Queue setup, 1s tick loop, Redis heartbeat, graceful shutdown |
| `apps/worker/maintenance.ts` | Reviewed | Synced staging file expiry, `.part` cleanup, `.webp` thumbnail expiry (`AUD-012`) |
| `apps/worker/package.json` | Reviewed | `@gallery/worker` package manifest |
| `apps/worker/process.ts` | Reviewed | Album CAS resolution, download/stage, thumbnail generation, Google upload, reconciliation, retry/failure transitions (`AUD-002`) |

#### Shared Packages (`packages/`)
| File Path | Status | Notes |
|---|---|---|
| `packages/database/connections.ts` | Reviewed | Google OAuth token refresh (`access()`) and LINE credential decryption (`AUD-004`) |
| `packages/database/index.ts` | Reviewed | PrismaClient singleton |
| `packages/database/migrations/202611190001_initial/migration.sql` | Reviewed | Initial PostgreSQL schema, indexes, foreign keys, and `CHECK` constraints |
| `packages/database/migrations/202611190002_authorization_window/migration.sql` | Reviewed | Adds `enabledSince` column to `LineGroup` |
| `packages/database/migrations/202611200001_video_support/migration.sql` | Reviewed | Adds `mediaType` and `durationMs` columns to `Image` |
| `packages/database/migrations/migration_lock.toml` | Reviewed | Prisma migration lock |
| `packages/database/package.json` | Reviewed | `@gallery/database` package manifest |
| `packages/database/schema.prisma` | Reviewed | Complete Prisma data model |
| `packages/google-photos/index.ts` | Reviewed | Google OAuth URL/token exchange, album creation, raw upload, `batchCreate`, and pagination search reconciliation |
| `packages/google-photos/package.json` | Reviewed | `@gallery/google-photos` package manifest |
| `packages/image-processing/index.ts` | Reviewed | Disk space/usage checks, `sharp` image inspection & WebP thumbnailing, `ffprobe`/`ffmpeg` video inspection & poster thumbnailing, atomic `.part` staging (`AUD-001`, `AUD-002`, `AUD-005`) |
| `packages/image-processing/package.json` | Reviewed | `@gallery/image-processing` package manifest |
| `packages/line-client/index.ts` | Reviewed | Webhook HMAC-SHA256 verification, Zod event envelope, LINE Bot API and content download client |
| `packages/line-client/package.json` | Reviewed | `@gallery/line-client` package manifest |
| `packages/shared/config.ts` | Reviewed | Zod environment validation and runtime settings parser |
| `packages/shared/crypto.ts` | Reviewed | Constant-time string comparison and AES-256-GCM `seal`/`open` |
| `packages/shared/http.ts` | Reviewed | Upstream `fetch` wrapper with timeout, `redirect: "error"`, `Retry-After` parsing, and provider fault classification |
| `packages/shared/model.ts` | Reviewed | Upload state machine, valid transitions, Zod schemas (`limits`, `filters`), `Fault`, exponential backoff with jitter |
| `packages/shared/package.json` | Reviewed | `@gallery/shared` package manifest |
| `packages/ui/button.tsx` | Reviewed | Shared React `Button` component with `class-variance-authority` |
| `packages/ui/package.json` | Reviewed | `@gallery/ui` package manifest |

#### Infrastructure, Scripts, Tests & Documentation (`infra/`, `scripts/`, `tests/`, `e2e/`, `docs/`)
| File Path | Status | Notes |
|---|---|---|
| `infra/caddy/Dockerfile` | Reviewed | Optional non-root Caddy image build |
| `infra/docker/web.conf` | Reviewed | Nginx reverse-proxy, security headers, CSP, and SPA fallback config |
| `scripts/release.mjs` | Reviewed | CalVer release preparation CLI entrypoint |
| `scripts/sync-version.mjs` | Reviewed | CalVer check/sync CLI entrypoint |
| `scripts/test-integration.sh` | Reviewed | Disposable Docker Postgres 18 + Redis 7 integration test runner |
| `scripts/version-control.mjs` | Reviewed | CalVer parser, monotonic target calculation, atomic file sync/rollback, Git tag preflight |
| `scripts/version-control.test.mjs` | Reviewed | Node test suite (17 tests) for `version-control.mjs` |
| `scripts/version-targets.mjs` | Reviewed | Repository version target configuration |
| `tests/model.test.ts` | Reviewed | Unit tests for HMAC signature, event filtering, state transitions, backoff, and `collectVideos` |
| `tests/pipeline.test.ts` | Reviewed | Full integration test across setup, auth, webhook ingestion, album CAS, upload, reconciliation, retry, and cleanup |
| `e2e/gallery.spec.ts` | Reviewed | Playwright E2E tests for gallery filtering, version display, lightbox dialog, and deployed owner session |
| `docs/ARCHITECTURE.md` | Reviewed | System architecture, state machine, storage, and migration specifications |
| `docs/DOCKER_DEPLOYMENT.md` | Reviewed | Docker Compose deployment, proxy bindings, operations, and backup/restore guide |
| `docs/GOOGLE_CLOUD_SETUP.md` | Reviewed | Google Cloud project and OAuth client setup guide |
| `docs/GOOGLE_PHOTOS_OAUTH.md` | Reviewed | OAuth flow and 2025 Google Photos Library API scope restrictions |
| `docs/LINE_SETUP.md` | Reviewed | LINE Official Account and Messaging API setup guide |
| `docs/OWNER_GUIDE.md` | Reviewed | End-user setup and operational handbook |
| `docs/SECURITY.md` | Reviewed | Security model and privacy controls |
| `docs/TROUBLESHOOTING.md` | Reviewed | Symptom-to-action troubleshooting matrix |
| `docs/plans/README.md` | Reviewed | Plan index and filing rules |
| `docs/plans/2026-11-20-frontend-design-refactor.md` | Reviewed | Active UI refactor plan |
| `docs/plans/2026-11-20-video-collection-support.md` | Reviewed | Active video collection support plan |
| `docs/plans/completed/2026-11-20-sidebar-health-settings-refactor.md` | Reviewed | Completed sidebar health and settings layout plan |
| `graphify-out/**`, `node_modules/**`, `apps/web/dist/**`, `test-results/**` | Excluded (Generated / Third-Party) | Generated build output, test artifacts, knowledge graph cache, and third-party dependencies |

### Components & Flows Traced End-to-End
1. **Owner Claim & Session Lifecycle:** `POST /api/v1/auth/setup` & `/login` → CSRF check → rate limit → `BOOTSTRAP_SECRET` SHA-256 constant-time check → Argon2id hash/verify → Redis `session:<id>` (`EX 43200`) → signed cookie → `onRequest` auth hook → `POST /api/v1/auth/logout`.
2. **LINE Webhook Ingestion:** `POST /api/webhooks/line` → raw Buffer parser → `lineCredentials()` decryption → `signed()` HMAC-SHA256 verification → channel `destination` guard → `ingest()` → `WebhookEvent` deduplication → `LineGroup` creation & `SELECT ... FOR UPDATE` row lock → `join`/`leave` state transitions & `GROUP_SUMMARY` outbox → authorization window (`enabled`, `JOINED`, `membershipAt`, `enabledSince`) and `collectVideos` checks → `Image` deduplication → `pressured()` check → `OutboxEvent("PROCESS")` commit.
3. **Worker Outbox Dispatch & Media Pipeline:** `tick()` → `dispatch()` → BullMQ `line-images` (`concurrency: 1`) → `processEvent()` → `UploadAttempt` tracking → `DOWNLOAD_PENDING` → `DOWNLOADING` → crash-safe existing-file check → `download()` stream → `stage()` byte limit (`MAX_IMAGE_SIZE_MB` / `MAX_VIDEO_SIZE_MB`) + `wx` `0o600` `.part` file + `inspect()` (`sharp`) / `inspectVideo()` (`ffprobe`) + atomic `rename()` → `STAGED` + `OutboxEvent("UPLOAD")`.
4. **Thumbnailing, Album CAS, Google Upload & Reconciliation:** `UPLOAD` event → `thumbnail()` (320 & 640 WebP via `sharp` / `ffmpeg`) → pre-upload SHA-256 integrity re-verification → optional LINE group summary fetch → `access()` OAuth refresh → `resolveAlbum()` CAS (`albumCreating`) → `google.album()` 20,000-item capacity check → `google.bytes()` raw stream upload → `CREATING_MEDIA` checkpoint → `google.createMedia()` (`mediaItems:batchCreate`) → automatic `google.reconcile()` fallback on ambiguous error → `SYNCED` (or `NEEDS_REVIEW` / `RETRY_PENDING` / `FAILED` / `UNRECOVERABLE`).
5. **Media Serving & Retention Cleanup:** `GET /api/v1/images/:id/thumbnail` & `/content` → local disk check (`touch()` on thumbnail, HTTP `206` `Range` on local video) → on-demand thumbnail generation for unuploaded staged files → Google Photos `mediaItems.get` + `*.googleusercontent.com` stream proxy → `cleanup()` every 60s for expired synced originals, `.part` files, and `.webp` thumbnails → explicit owner `POST /api/v1/jobs/:id/discard` with confirmation literal and `DISCARD` outbox event.

### Practical Checks Executed & Outcomes
| Command | Outcome |
|---|---|
| `corepack pnpm typecheck` (`tsc --noEmit`) | **PASS** (exit code 0, zero type errors) |
| `corepack pnpm test` (`vitest run`) | **PASS** (exit code 0; `tests/model.test.ts` 5 passed, `tests/pipeline.test.ts` 1 skipped without `GALLERY_INTEGRATION`) |
| `node --test scripts/version-control.test.mjs` | **PASS** (exit code 0; 17/17 tests passed in 1,105 ms) |
| `node scripts/sync-version.mjs --check` | **PASS** (exit code 0; `Checked 2026.11.1`) |
| `corepack pnpm build` (`vite build apps/web`) | **PASS** (exit code 0; built `dist/index.html`, `dist/assets/index-*.css` 22.45 kB, `dist/assets/index-*.js` 461.56 kB in 2.10s) |
| `docker compose --profile edge config --quiet` | **PASS** (exit code 0; Compose configuration valid across default and `edge` profiles) |
| `bash scripts/test-integration.sh` | **PASS** (exit code 0; disposable `postgres:18` and `redis:7-alpine` started, all 3 Prisma migrations applied cleanly, `tests/model.test.ts` 5/5 passed, `tests/pipeline.test.ts` 1/1 passed in 1.17s) |
| `corepack pnpm e2e` (`playwright test`) | **FAIL (Host Environment Limit)** (exit code 1; Chromium headless shell failed to launch due to missing shared library `libatk-1.0.so.0` on the host OS) |

### Behaviors Not Verified at Runtime
- **Browser E2E & Visual Rendering (`e2e/gallery.spec.ts`):** Not executed at runtime because the host environment lacks `libatk-1.0.so.0` required by Playwright's Chromium binary (verified via code inspection of `apps/web/src/*` and `e2e/gallery.spec.ts`).
- **Live External Provider Endpoints:** Live LINE Platform webhook delivery, external TLS reverse-proxy routing, and live Google Photos OAuth consent/upload endpoints were evaluated via source inspection and mocked integration tests rather than live external traffic.
