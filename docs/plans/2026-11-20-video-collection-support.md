# Video collection support (LINE group videos → Google Photos)

**Status:** 2026-11-20 — Implemented Tasks 1–6 and doc updates (`prisma generate`, `typecheck`, `build`, `vitest` pass). Pending `prisma migrate deploy` and `bash scripts/test-integration.sh` in Task 7.

## Goal

Extend RivoSnap to ingest, stage, thumbnail, upload, and privately play back `video` messages (`MP4`, `MOV`, `WebM`) from enabled LINE groups alongside images, gated by an opt-in `collectVideos` setting (default `false`), while preserving channel/message deduplication, transactional outbox, and zero silent deletion of unuploaded originals.

## Key constraints & design notes

- **Settings persistence**: RivoSnap stores runtime preferences as JSON via `prefs()` / `merge()` in `packages/database/connections.ts`, validated by `limits` in `packages/shared/model.ts` and `settings()` in `packages/shared/config.ts` (no Prisma table for settings).
- **LINE Messaging API**: `message.type === "video"` uses `/v2/bot/message/{messageId}/content`, but files can exceed 50 MB and take longer than `request()`'s 90s timeout.
- **Google Photos Library API**: `photoslibrary.appendonly` supports video uploads via `uploads` + `mediaItems:batchCreate`; remote playback uses `baseUrl + "=dv"` (with `60m` expiry, resolved server-side).
- **Worker runtime**: `sharp` cannot decode video; `ffmpeg`/`ffprobe` in `Dockerfile.worker` is needed to validate video streams, extract `width`/`height`/`durationMs`, and generate `320`/`640` `.webp` poster thumbnails.
- **Staging & Disk**: Keep internal staging filenames (`pathFor(id)`) intact so existing staged files never break; pass `maxMB` to `stage()` (`MAX_VIDEO_SIZE_MB` for videos, `MAX_IMAGE_SIZE_MB` for images) and include `MAX_VIDEO_SIZE_MB` in `pressured()` reserve math when `collectVideos` is enabled.

## Task list

- [x] **1. Database schema & migration** (`packages/database/schema.prisma`, `packages/database/migrations/`):
  - Add `mediaType` (`"IMAGE" | "VIDEO"`, default `"IMAGE"`) and `durationMs Int?` to `Image` model.
  - Create Prisma migration (`packages/database/migrations/202611200001_video_support/migration.sql`).
- [x] **2. Config, shared models & HTTP timeout** (`packages/shared/config.ts`, `packages/shared/http.ts`, `packages/shared/model.ts`, `apps/api/routes.ts`):
  - Add `MAX_VIDEO_SIZE_MB` env setting (default `200`, bounded) and expose `maxVideoMB` + `collectVideos` in `GET /settings`.
  - Add `collectVideos: z.boolean().default(false)` to `limits` / `settings()` and allow `PATCH /settings` to update retention numbers and/or `collectVideos` cleanly without breaking existing retention-only payloads.
  - Add optional `timeoutMs` parameter to `request()` in `packages/shared/http.ts` (e.g., `600000` for video download/upload streams).
- [x] **3. LINE webhook & ingestion** (`packages/line-client/index.ts`, `apps/api/ingest.ts`):
  - Update `relevant()` to accept `e.type === "message" && (e.message?.type === "image" || e.message?.type === "video")`.
  - In `ingest.ts`, check `settings(owner?.settings).collectVideos` before accepting `video` events (ignore videos when `false`).
  - Persist `mediaType: e.message!.type === "video" ? "VIDEO" : "IMAGE"` in `ingest.ts` while preserving `[channelId, lineMessageId]` deduplication and `pressured()` check.
- [x] **4. Worker container & video processing** (`Dockerfile.worker`, `packages/image-processing/index.ts`, `apps/worker/process.ts`, `packages/google-photos/index.ts`):
  - Install `ffmpeg` in `Dockerfile.worker` (`apt-get install -y --no-install-recommends ffmpeg`).
  - Parameterize `stage(stream, maxMB)` so images use `MAX_IMAGE_SIZE_MB` and videos use `MAX_VIDEO_SIZE_MB`; update `pressured()` reserve math when `collectVideos` is enabled.
  - Add `inspectVideo()` (`ffprobe` for `mp4`/`mov`/`webm` codec, dimensions, `durationMs`) and `thumbnail(..., mediaType)` (`ffmpeg` single-frame poster → `sharp` `320`/`640` `.webp`).
  - Update `process.ts` and `google-photos/index.ts` to branch on `mediaType === "VIDEO"` for inspection, deterministic filename extension (`.mp4`/`.mov`/`.webm`), upload timeout, and Google upload MIME type.
- [x] **5. API content & Range playback** (`apps/api/routes.ts`, `packages/google-photos/index.ts`):
  - Serve local staged video with HTTP `Range` (`206 Partial Content`) support (or `=dv` stream/redirect for synced remote videos) on `/images/:id/content`.
  - Include `mediaType` and `durationMs` in `/images` and `/jobs` responses.
- [x] **6. Web UI settings, gallery & lightbox** (`apps/web/src/data.ts`, `apps/web/src/workspace.tsx`, `apps/web/src/photos.tsx`, `apps/web/src/style.css`):
  - Add `collectVideos` and `maxVideoMB` to `Settings` type; add an **Enable video collection** toggle in `Settings` that sends `PATCH /settings` with `{ collectVideos }` (separate from the `Number(v)` retention form handler).
  - Add `mediaType` and `durationMs` to `Photo` type.
  - Render a video badge/duration pill on `.photo` contact-sheet cards for videos (preserving `Photo from <group>` button accessible name).
  - Render `<video controls playsInline>` inside `Lightbox` when `p.mediaType === "VIDEO"`.
- [ ] **7. Docs & verification**:
  - Update `README.md`, `docs/OWNER_GUIDE.md`, `docs/LINE_SETUP.md`, and `docs/SECURITY.md` to document `collectVideos` (off by default), supported video formats, size limits, and disk impact.
  - Add unit/integration tests for `collectVideos` gating, video ingestion, `ffprobe`/`ffmpeg` thumbnailing, and `Range` streaming; run `corepack pnpm typecheck`, `corepack pnpm build`, `corepack pnpm test`, and `bash scripts/test-integration.sh`.
