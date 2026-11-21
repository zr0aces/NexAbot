# RivoSnap follow-up audit — 21 Nov 2026

## Executive summary

At revision `8a1cc98`, prioritize the LINE video download, remote thumbnail generation and group authorization window. Existing Go and disposable integration gates pass but do not catch these paths. This is a partial audit, not a production certification. No application changes were made.

## Findings

| ID / severity | Location | Trigger, evidence and impact | Recommended fix and regression proof |
|---|---|---|---|
| F1 **High** · ingestion correctness | `internal/line/line.go:118-120`, `internal/httpclient/http.go:65-68`, `internal/media/media.go:391-400`, `internal/worker/worker.go:584-592` | [LINE documents HTTP 202](https://developers.line.biz/en/reference/messaging-api/nojs/#get-content) while a large video is being prepared. Download accepts every 2xx; the worker stages the non-media response, video inspection fails, and the item becomes UNRECOVERABLE. Even if the video becomes available seconds later, the retry endpoint excludes that state. | Handle 202 in the LINE download adapter: close the body and return a transient preparation fault. Only stage an actual content response. Test a 202 followed by a valid 200; assert there is no staged file after 202 and the original is eventually uploaded once. |
| F2 **High** · availability | `internal/api/server.go:91-107,1726-1744`, `internal/media/media.go:335-354`, `docker-compose.yml:31` | The two-job limit applies to local thumbnail generation only. After synced thumbnails expire, each concurrent gallery cache miss can independently download up to 10 MiB and launch ffmpeg in the 768 MiB API container. Same-image requests also duplicate this work. This can exhaust API resources, including those needed for webhook ingestion. Actual peak memory was not measured. | Put the remote fetch/convert/cache path behind the same bounded admission and per-image/size request sharing. Check the cache again inside the shared operation. Test repeated and distinct cold requests against a mock remote; assert one conversion per key and at most two active conversions total. |
| F3 **Medium** · ingestion correctness | `internal/api/server.go:1047-1052`, `internal/api/ingest.go:136-138` | Repeating an enable request on an already-enabled group resets enabledSince. A legitimately delayed webhook timestamped between the two requests is recorded as processed but its photo is never queued, despite uninterrupted authorization. | Preserve the timestamp on an enabled→enabled update; set it only when collection begins. Test repeated enable plus delayed delivery, and ensure a real pause/re-enable still rejects events from the pause. |
| F4 **Medium** · session revocation | `internal/api/server.go:349-360` | Logout ignores the Redis DEL result. If session lookup succeeds but deletion fails, the browser drops its cookie and receives success while the previous session remains usable until expiration. | Report failure when revocation fails; allow the client to retry rather than confirming logout. Inject a deletion failure after successful session validation. |
| F5 **Medium** · OAuth account continuity | `internal/api/server.go:842-869` | The callback treats every failed mapped-album lookup as “no mapping.” A transient SELECT failure followed by a successful credential upsert can replace the connection without checking access to an existing album. | Only pgx.ErrNoRows means no mapping; abort on other errors. Test that lookup failure preserves the old encrypted credential. |
| F6 **Low** · developer build | `internal/web/web.go:9`, `README.md:23-27`, `.github/workflows/ci.yml:27-33` | The README builds apps/web/dist, but Go embeds internal/web/dist. A clean tracked checkout fails before tests start: `pattern all:dist: no matching files found`. Both CI Go jobs create an untracked placeholder, masking the issue. | Track a minimal embeddable placeholder using a narrow ignore exception; keep the API Docker build overlaying the real bundle. Remove the CI workaround and run the documented checks from a clean checkout. |

Confidence is high for the control flow in F1–F5 (source trace; no live-provider or failure-injection reproduction) and for F6 (reproduced in a temporary Git archive).

## Performance and resource use

F2 is the priority. A warm-cache benchmark would miss it; measure concurrent cold-cache requests and webhook latency together.

## Security

F4 and F5 concern failure handling, not a demonstrated compromise. No production accounts, sessions or provider media were accessed.

## Reliability and concurrency

F1 and F3 can permanently omit eligible media even with a healthy database and worker. F2 can degrade API availability independently of worker health.

## Testing gaps

Add the regression cases in the findings table. The local integration run skipped the short-video ffmpeg test. Playwright failed at browser startup, before any UI assertions.

## Architecture and recommended action order

1. **Immediate:** correct F1 at the LINE adapter and F3 at the group update, retaining existing outbox and authorization checks.
2. **Short term:** extend the existing thumbnail concurrency guard (F2); make F4 and F5 fail explicitly at their existing persistence boundaries.
3. **Next development setup change:** resolve F6. No new service or dependency is necessary for these fixes.

## Audit coverage

Checks passed: `go test ./...`, `go vet ./...`, `bash scripts/test-integration.sh` (disposable PostgreSQL/Redis; mocked providers), `corepack pnpm typecheck`, `corepack pnpm build`, `node --test scripts/version-control.test.mjs` (20 tests), and `node scripts/sync-version.mjs --check`. Playwright used local fixtures only; Chromium could not start because `libatk-1.0.so.0` is missing. No deployment, real OAuth exchange, load benchmark or dependency vulnerability scan was performed.

File inventory below is for the 98 files tracked at the audited revision. “Inspected” includes targeted sections and does not imply line-by-line verification. Other first-party files remain unverified individually; running a build or suite is not a substitute for source review.

### Inspected (some in part)

- `.github/workflows/ci.yml`
- `.github/workflows/release-images.yml`
- `.gitignore`
- `AGENTS.md`
- `Dockerfile.api`
- `Dockerfile.worker`
- `README.md`
- `apps/web/package.json`
- `apps/web/src/data.ts`
- `apps/web/src/photos.tsx`
- `apps/web/vite.config.mjs`
- `cmd/rivosnap/main.go`
- `docker-compose.yml`
- `docs/ARCHITECTURE.md`
- `docs/LINE_SETUP.md`
- `docs/SECURITY.md`
- `docs/audit/2026-11-20-audit-report.md`
- `docs/audit/2026-11-21-audit-report.md`
- `e2e/gallery.spec.ts`
- `infra/docker/web.conf`
- `internal/api/ingest.go`
- `internal/api/pipeline_test.go`
- `internal/api/server.go`
- `internal/config/config.go`
- `internal/crypto/crypto.go`
- `internal/db/db.go`
- `internal/db/migrate.go`
- `internal/google/google.go`
- `internal/httpclient/http.go`
- `internal/line/line.go`
- `internal/media/media.go`
- `internal/media/media_test.go`
- `internal/model/model.go`
- `internal/web/web.go`
- `internal/worker/worker.go`
- `package.json`
- `playwright.config.ts`
- `scripts/test-integration.sh`

### Excluded from source review (binary asset or generated lockfile)

- `apps/web/public/rivosnap-mark.png`
- `go.sum`
- `pnpm-lock.yaml`

### Unverified individually (outside the traced paths)

- `.dockerignore`
- `.env.example`
- `CLAUDE.md`
- `Caddyfile`
- `GEMINI.md`
- `VERSION`
- `apps/web/index.html`
- `apps/web/public/rivosnap-mark.svg`
- `apps/web/public/rivosnap.svg`
- `apps/web/src/i18n.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/onboarding.tsx`
- `apps/web/src/style.css`
- `apps/web/src/workspace.tsx`
- `docker-compose.override.yml.example`
- `docs/DOCKER_DEPLOYMENT.md`
- `docs/GOOGLE_CLOUD_SETUP.md`
- `docs/GOOGLE_PHOTOS_OAUTH.md`
- `docs/OWNER_GUIDE.md`
- `docs/TROUBLESHOOTING.md`
- `docs/example-deploy/README.md`
- `docs/example-deploy/compose.yml`
- `docs/example-deploy/env.example`
- `docs/example-deploy/web.conf`
- `docs/plans/README.md`
- `docs/plans/completed/2026-11-20-audit-remediation.md`
- `docs/plans/completed/2026-11-20-frontend-design-refactor.md`
- `docs/plans/completed/2026-11-20-refresh-line-group-name.md`
- `docs/plans/completed/2026-11-20-sidebar-health-settings-refactor.md`
- `docs/plans/completed/2026-11-20-video-collection-support.md`
- `docs/plans/completed/2026-11-21-audit2-remediation.md`
- `docs/plans/completed/2026-11-21-go-backend-migration.md`
- `docs/plans/completed/2026-11-21-production-auto-migrations.md`
- `docs/plans/roadmap.md`
- `go.mod`
- `infra/caddy/Dockerfile`
- `internal/api/rate_test.go`
- `internal/crypto/crypto_test.go`
- `internal/db/migrate_test.go`
- `internal/line/line_test.go`
- `internal/model/model_test.go`
- `packages/database/migrations/202611190001_initial/migration.sql`
- `packages/database/migrations/202611190002_authorization_window/migration.sql`
- `packages/database/migrations/202611200001_video_support/migration.sql`
- `packages/database/migrations/202611210001_timestamptz/migration.sql`
- `packages/database/migrations/embed.go`
- `packages/database/migrations/migration_lock.toml`
- `packages/ui/button.tsx`
- `packages/ui/package.json`
- `pnpm-workspace.yaml`
- `scripts/release.mjs`
- `scripts/repair/2026-11-21-utc-timestamps.sql`
- `scripts/sync-version.mjs`
- `scripts/version-control.mjs`
- `scripts/version-control.test.mjs`
- `scripts/version-targets.mjs`
- `tsconfig.json`
