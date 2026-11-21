# Audit 2 Remediation (AUD2-001 to AUD2-012) Implementation Plan

**Status:** 2026-11-21 — planned. Nothing shipped. All tasks below remain.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding in the 2026-11-21 audit, starting with the silent 7-hour ingestion blackout (AUD2-001).

**Architecture:** Time correctness moves to the database boundary: the pgx pool pins `timezone=UTC`, Go writes UTC, and a later migration converts columns to `timestamptz`. The remaining fixes stay inside the layer that owns each behavior: Nginx and the API middleware own client identity, `media` owns staging, the API owns bounded thumbnail rendering, and the resolve-album transaction owns group recovery. A new CI workflow gates releases.

**Tech Stack:** Go 1.27 (pgx v5, go-redis, `golang.org/x/sync`), React 19 + TanStack Query, Nginx unprivileged, PostgreSQL 18, Redis 7, GitHub Actions.

**Spec:** [`docs/audit/2026-11-21-audit-report.md`](../audit/2026-11-21-audit-report.md). Each finding's "Recommended fix" is the requirement; this plan records the decisions the report leaves open.

## Line references

`file:line` references are from `6a19bb0`. Locate each site by the function named next to it, because an uncommitted change in the worktree moves `internal/api/server.go` by about 30 lines. That change makes the API serve the SPA (`internal/web/`, `newSPAHandler`), turns Nginx into a pure proxy (`location /`), and drops `Dockerfile.web`. The `server.go` functions referenced are:

| Line | Function |
|---|---|
| `:84-90` | `peerHost` |
| `:327-337` | `Handler` middleware |
| `:419-428` | `handleAuth` |
| `:477` | `handleHealth` |
| `:616` | `handlePostSettingsLine` |
| `:694-735` | `handleGoogleCallback` |
| `:824-828` | `fetchGroupMap` |
| `:855-881` | `handleGetGroups` |
| `:1005-1050` | `handleRefreshGroup` |
| `:1085-1174` | `handleResolveAlbum` |
| `:1493-1550`, `:1630` | `handleMediaStream` |
| `:1710` | `handleDiscardJob` |
| `:1769-1837` | `handleRetryJob` |
| `:1846-1864` | `handleDashboardStats` |
| about `:1985` | the inline OpenAPI document |

## Global Constraints

- Prefix every shell command with `rtk` (AGENTS.md).
- Go checks: `rtk go vet ./...`, `rtk go test ./...`. Frontend checks: `rtk corepack pnpm typecheck`, `rtk corepack pnpm build`. Pipeline checks: `rtk bash scripts/test-integration.sh`, which uses disposable containers only. Compose checks: `rtk docker compose --profile edge config --quiet`.
- Never run tests, migrations or repair SQL against production. Never remove named volumes. Never print `.env` or expanded Compose config.
- Never silently delete an unuploaded original. Preserve channel/message dedup and the transactional outbox. Reconcile uncertain Google writes; never repeat them.
- Keep one Nginx `web` service, the existing host bindings and the `WEB_PORT` contract.
- New migrations go in `packages/database/migrations/<YYYYMMDDNNNN>_<name>/migration.sql` and must stay compatible with the `_prisma_migrations` ledger runner.
- Do not bump `VERSION` or the OpenAPI version as part of this plan.
- Use one commit per task, in Conventional Commits style.

## Review Focus

1. **A group enabled seconds before an image arrives.** The image must be collected whether Postgres, the containers or the CI runner use UTC or Asia/Bangkok. Task 1 pins this by running the whole integration suite on Bangkok-time Postgres.
2. **An attacker sending bad logins while the owner signs in from another address.** Each client address gets its own login bucket, and a spoofed `X-Real-IP` from a non-private peer is ignored. Task 4 tests both.
3. **An image that Go cannot decode but whose header is valid.** It must stay on disk with a `stagingPath`, show in the queue, and remain discardable. Task 5 tests that the file survives.
4. **A worker killed mid-item, repeatedly.** After 3 abandoned attempts the item must stop looping. It ends in `FAILED`, or in `NEEDS_REVIEW` if a Google create may have happened, so it is never re-uploaded. Task 5 tests both cases with pre-seeded `ACTIVE` attempt rows.
5. **Resolve-album on a group with hundreds of failed images.** One action re-queues all of them, and other groups' `ALBUM_REVIEW` failures stay untouched. Task 7 tests both.

## Execution order

Tasks 1 and 2 ship together, because they stop the ongoing data loss.

- **Before deploying:** prepare and validate Task 2's repair script on a restored copy.
- **During the deploy:**
  1. Stop `api` and `worker`.
  2. Run the repair.
  3. Start the Task 1 build.

The repair must not run after the fixed build has started. Once the fixed build writes new UTC rows, they can no longer be told apart by value from the Bangkok-shifted rows. If the repair were skipped, pending outbox rows would stall for up to 7 hours (see Task 2).

Task 8 (CI) lands next, so later tasks are gated. Tasks 4–7 and 9–14 are then independent of each other. Task 3 (`timestamptz`) goes last, because it touches every timestamp column.

## Task list

### Task 1: Pin UTC at the database boundary (AUD2-001, steps 1, 2 and 5)

**Files:**
- Modify: `internal/db/db.go:32-50` (`Connect`)
- Modify: `internal/worker/worker.go:615`, `internal/api/server.go:1853` (`handleDashboardStats`)
- Modify: `scripts/test-integration.sh:3`
- Test: `internal/db/migrate_test.go` (add a test beside the existing integration-gated ones)

**Interfaces:**
- Produces: every pooled connection reports `SHOW timezone` = `UTC`. Every Go `time.Time` written to or compared with the database is `.UTC()`.

- [ ] **Step 1:** Change `scripts/test-integration.sh` so the Postgres container starts with `-e TZ=Asia/Bangkok`.
- [ ] **Step 2:** Add `TestSessionTimezoneIsUTC`, gated on `GALLERY_INTEGRATION` like its neighbours. It calls `db.Connect`, runs `SHOW timezone` and asserts `"UTC"`.
- [ ] **Step 3:** Run `rtk bash scripts/test-integration.sh`. Expected: FAIL. `TestSessionTimezoneIsUTC` reports `Asia/Bangkok`, and `pipeline_test.go:273` reports `expected 1 deduplicated image, got 0`.
- [ ] **Step 4:** In `Connect`, build the pool with `pgxpool.ParseConfig(env.DatabaseURL)`, set `cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"`, then call `pgxpool.NewWithConfig`. The ping loop stays unchanged.
- [ ] **Step 5:** Apply `.UTC()` at `worker.go:615` (`avail`, an `OutboxEvent."availableAt"` parameter) and `server.go:1853` (`warnCutoff`, a SQL parameter). These matter because the containers run with `TZ=Asia/Bangkok`, and pgx writes the local wall clock. Then grep `time.Now()` in `internal/` for any other value bound as a SQL parameter, and apply `.UTC()` there too.

  Leave these alone:
  - `handleDiscardJob`'s `deadline.After(time.Now())`: it compares two Go instants, and becomes correct once stored values are UTC.
  - `media.go:106`/`:419` and the `db.go` token cache: in-process only.
- [ ] **Step 6:** Run `rtk bash scripts/test-integration.sh`. Expected: all PASS on Bangkok-time Postgres.
- [ ] **Step 7:** Run `rtk go vet ./...` and `rtk go test ./...`. Expected: PASS.
- [ ] **Step 8:** Commit `fix(db): pin session timezone to UTC so enabledSince compares correctly`.

### Task 2: One-off repair of Bangkok-shifted timestamps (AUD2-001, step 3)

This task is an operator runbook that runs during the Task 1 deploy window (see Execution order). It is not an automatic migration, because the cutover time and the legacy-row convention must be checked on real data first.

**Files:**
- Create: `scripts/repair/2026-11-21-utc-timestamps.sql`
- Modify: `docs/TROUBLESHOOTING.md` (add a "Timestamps 7 hours ahead / first photos after enabling were missed" entry that links the runbook)

**Decisions:**
- Affected rows are those written by SQL `NOW()`/`CURRENT_TIMESTAMP`, or by Go `time.Now()` inside a Bangkok-TZ container, after the Go backend cutover.
- The script runs while `api` and `worker` are stopped and before the fixed build starts, so no UTC-convention rows exist yet. It takes one psql variable, `:cutover_bkk`: the Go cutover time as Bangkok wall clock. It shifts every listed column value `>= :'cutover_bkk'` back by `interval '7 hours'`.
- A value-range window cannot work after the fixed build has run. Pre-fix Bangkok values and post-fix UTC values overlap for 7 hours and cannot be told apart.
- Columns to repair:
  - `LineGroup."enabledSince"`, `"createdAt"`, `"updatedAt"`
  - `Image."uploadedAt"`, `"createdAt"`, `"updatedAt"`
  - `UploadAttempt."startedAt"`, `"completedAt"`
  - `WebhookEvent."receivedAt"`, `"processedAt"`
  - `AuditLog."createdAt"`
  - `GoogleConnection."connectedAt"`, `"lastValidatedAt"`
  - `Owner."createdAt"`, `"updatedAt"`
  - `OutboxEvent."createdAt"`, `"availableAt"`, `"publishedAt"`

  The outbox columns must be repaired. Without that, after the fix the worker's `"availableAt" <= NOW()` and `"publishedAt" < NOW() - interval '1 minute'` checks in `dispatch` see these rows as 7 hours in the future, so pending and in-flight work stalls for up to 7 hours.
- Columns never to touch, because they come from LINE or from UTC Go values: `Image."lineEventTimestamp"`, `LineGroup."membershipAt"`, `"lastEventAt"`.
- Idempotency: the script runs in one transaction. It aborts with `RAISE EXCEPTION` if an `AuditLog` row with action `'UTC timestamp repair'` already exists, and inserts that row when it finishes.

- [ ] **Step 1:** Write the script as decided above. Start it with a `SELECT` preview that counts the rows affected per column.
- [ ] **Step 2:** Verify on a disposable Postgres:
  1. Restore a copy of the production backup into it. Never use the live database.
  2. Stop nothing in production.
  3. Run the preview. For a few post-cutover `Image` rows, confirm that `createdAt` is about 7 hours after `lineEventTimestamp`.
  4. Run the script. The same rows now differ by seconds.
  5. Confirm that legacy pre-cutover rows already have `createdAt` within seconds of `lineEventTimestamp`, so they look UTC. If they do not, adjust `:cutover_bkk` or the column list, and record why in the script header.
- [ ] **Step 3:** Run the script a second time on the restored copy. Expected: it aborts with the idempotency exception and changes nothing.
- [ ] **Step 4:** Add the runbook steps to `docs/TROUBLESHOOTING.md`:
  1. Back up the database.
  2. Stop `api` and `worker`.
  3. Run the script with `psql -v cutover_bkk='YYYY-MM-DD HH:MM:SS' -f`.
  4. Deploy and start the Task 1 build.
  
  Also state that the script must never be run after the fixed build has started. The production run is the owner's action and is out of scope for the executor.
- [ ] **Step 5:** Commit `docs(ops): add one-off UTC timestamp repair runbook`.

### Task 3: Convert all timestamp columns to `timestamptz` (AUD2-001, step 4; report §7)

**Files:**
- Create: `packages/database/migrations/202611210001_timestamptz/migration.sql`
- Test: `internal/db/migrate_test.go`

**Decisions:** The migration runs `ALTER COLUMN ... TYPE TIMESTAMPTZ(3) USING <col> AT TIME ZONE 'UTC'` on every `TIMESTAMP(3)` column in the three existing migrations. Enumerate the columns from the files; Step 1's test proves none are missed. Defaults stay `CURRENT_TIMESTAMP`. The migration is safe only after Tasks 1 and 2 have been deployed, because it relies on stored values being UTC wall-clock. Migrations run automatically at startup, so do not release this task before the repair has run in production.

- [ ] **Step 1:** Add `TestAllTimestampColumnsAreTimestamptz`. After migrating, it queries `information_schema.columns` with `data_type = 'timestamp without time zone'` in schema `public`, excluding `_prisma_migrations`, and asserts zero rows.
- [ ] **Step 2:** Run `rtk bash scripts/test-integration.sh`. Expected: the new test FAILs and lists the columns.
- [ ] **Step 3:** Write the migration.
- [ ] **Step 4:** Grep for SQL casts `::timestamp` and for code formatting DB times without a zone. Fix any that would change meaning. JSON output does not change, because `fmtTime` (`server.go:185`) already formats with `.UTC()` and `Z`. Check that every API time goes through `fmtTime`/`fmtTimePtr`.
- [ ] **Step 5:** Run `rtk bash scripts/test-integration.sh`, `rtk go test ./...`, `rtk corepack pnpm typecheck` and `rtk corepack pnpm build`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(db): store timestamps as timestamptz`.

### Task 4: Per-client rate limiting behind Nginx (AUD2-002)

**Files:**
- Modify: `infra/docker/web.conf` (the `location` block that proxies to `$gallery_api`: `/api/` at `6a19bb0`, `/` after the uncommitted SPA change)
- Modify: `internal/api/server.go` (`peerHost`, the `Handler` middleware key selection, `handleAuth`)
- Test: `internal/api/rate_test.go`

**Interfaces:**
- Produces:
  - `func clientHost(r *http.Request) string`: returns `X-Real-IP` only when `peerHost(r.RemoteAddr)` parses as a loopback or private IP (`netip.Addr.IsLoopback() || IsPrivate()`) and the header parses as an IP. Otherwise it returns `peerHost(r.RemoteAddr)`.
  - `func rateKey(r *http.Request, sid string) string`: the middleware's key selection, extracted as a pure function so it can be tested without a database.

**Decisions:**
- Nginx trusts forwarding from private ranges only: `set_real_ip_from 10.0.0.0/8; set_real_ip_from 172.16.0.0/12; set_real_ip_from 192.168.0.0/16; set_real_ip_from 127.0.0.0/8; real_ip_header X-Forwarded-For; real_ip_recursive on;`. In the proxy location, add `proxy_set_header X-Real-IP $remote_addr;` and keep clearing `X-Forwarded-For`. Nginx overwrites `X-Real-IP` on every request, and the API publishes no host port, so a client cannot inject the header directly.
- Accepted residual risk: a LAN client hitting `192.168.8.70:WEB_PORT` directly can spoof its own key. That only bypasses its own limit.
- `rateKey` returns:
  - `"webhook:" + clientHost(r)` for the webhook. The signature is no longer used as a key.
  - `"session:" + sid` when there is a session.
  - `"ip:" + clientHost(r)` otherwise.

  After the SPA change, static asset loads also pass through this limiter. Per-client keys keep that within 600/min per visitor.
- The `handleAuth` bucket key becomes `mode + ":" + clientHost(r)`.

- [ ] **Step 1:** Replace the peer-only assertion in `rate_test.go` with these table tests:
  - `clientHost`: peer `172.18.0.5:1234` with `X-Real-IP: 203.0.113.1` returns `203.0.113.1`. Peer `203.0.113.9:1` with `X-Real-IP: 10.0.0.1` returns `203.0.113.9`. A private peer with `X-Real-IP: garbage` returns the peer.
  - `rateKey`: two webhook requests from the same client with different `X-Line-Signature` values return the same key. Two clients behind the same peer with different `X-Real-IP` values return different `ip:` keys. A session id wins over IP for non-webhook paths.
  - `checkRate` with an auth key: the 9th call for `login:203.0.113.1` within 5 minutes is refused, while `login:203.0.113.2` is still allowed.
- [ ] **Step 2:** Run `rtk go test ./internal/api -run Rate`. Expected: FAIL (undefined `clientHost`/`rateKey`).
- [ ] **Step 3:** Implement `clientHost` and `rateKey`, then switch the middleware and `handleAuth` to them. Update `web.conf`.
- [ ] **Step 4:** Run `rtk go test ./internal/api -run Rate` and `rtk docker compose --profile edge config --quiet`. Expected: PASS. Then validate the config with the image Compose uses for `web`:

  ```bash
  rtk proxy docker run --rm -v "$PWD/infra/docker/web.conf:/etc/nginx/conf.d/default.conf:ro" <web image> nginx -t
  ```

  Use `Dockerfile.web`'s build output instead if the SPA change has not landed. Expected: `syntax is ok`.
- [ ] **Step 5:** Update the rate-limit paragraph in `docs/SECURITY.md`. Commit `fix(api): key rate limits on real client address`.

### Task 5: Bounded staging inspection, quarantine instead of delete, crash-loop cap (AUD2-003)

**Files:**
- Modify: `internal/media/media.go:169-226` (`Inspect`), `:370-416` (`Stage`)
- Modify: `internal/worker/worker.go:229-242` (attempt start) and the failure path at `:560-615`
- Modify: `apps/web/src/i18n.ts` (label for the new error code)
- Test: `internal/media/media_test.go`, `internal/api/pipeline_test.go`

**Interfaces:**
- Produces:
  - `Inspect` keeps its signature. It validates the magic bytes, `DecodeConfig`, the 100 MP limit and computes `Digest`; it no longer fully decodes.
  - When inspection fails, `Stage` renames the temporary file to `target` and returns `MediaInfo{StagingPath: target}` together with the fault. Size and download faults still delete the `.part` file.
  - New fault code `WORKER_INTERRUPTED`, non-retryable.

**Decisions:**
- **Crash-loop cap.** Before inserting the new attempt, count this image's `UploadAttempt` rows with `status = 'ACTIVE' AND "completedAt" IS NULL`. Every normal path completes its attempt (`worker.go:417`, `:541`, `:608`), so only killed runs leave such rows.
  - If the count is 3 or more, mark those rows `status = 'ABANDONED'` and set `completedAt`.
  - Then insert the new attempt as usual. Instead of invoking the `runErr := func() error {...}()` closure (`:324`), set `runErr` to the `WORKER_INTERRUPTED` fault (non-transient).
  - The existing classification at `:565-578` then sends `CREATING_MEDIA`/`NEEDS_REVIEW` items to `NEEDS_REVIEW` (reconcile, never re-upload) and everything else to `FAILED`. Do not bypass it.
  - The owner's Retry still works, because `ABANDONED` rows are no longer counted.
- **Keeping undecodable files.** `UNSUPPORTED_IMAGE` maps to `UNRECOVERABLE` (`:571`, `:577`). When `Stage` returns a fault with a non-empty `StagingPath`, the failure update also sets `"stagingPath"`. The queue then shows the item and Discard can delete it (`handleDiscardJob` already allows `UNRECOVERABLE`). Cleanup prunes only `SYNCED` originals (`:651`), so the file stays until the owner discards it.
- **Second inspection.** Keep the inspection before upload (`:464-475`). It is the integrity check (SHA-256 and MIME against the staged row) and becomes cheap once `Inspect` no longer decodes. The re-stage branch at `:377-386` also keeps calling `Inspect`.

- [ ] **Step 1:** Write the media tests:
  - `TestInspectDoesNotFullyDecode`: a valid JPEG header followed by truncated scan data returns no error.
  - `TestStageKeepsFileOnInspectFailure`: random bytes declared as an image return a fault, `info.StagingPath` exists on disk, and no `.part` file remains.
  - `TestStageDeletesPartOnOversize`: unchanged behavior.
- [ ] **Step 2:** Write two pipeline tests.
  - `TestCrashLoopEndsInFailed`: seed an image in `DOWNLOAD_PENDING` plus 3 `ACTIVE` attempt rows with a `PROCESS` outbox row, then run `ProcessEvent`. Assert `uploadStatus = 'FAILED'`, `errorCode = 'WORKER_INTERRUPTED'`, and that the 3 rows are `ABANDONED`.
  - `TestCrashLoopInCreatingMediaGoesToReview`: the same setup in `CREATING_MEDIA`. Assert `uploadStatus = 'NEEDS_REVIEW'`.
- [ ] **Step 2b:** Extend `TestFullPipelineIntegration`. With the existing `mode = "invalid"` LINE mock (`pipeline_test.go:358`, `:585`), deliver an image message as well as the video. Assert for both items that the status is `UNRECOVERABLE`, `stagingPath` is non-null, and the file exists. Quarantine applies to `InspectVideo` failures too.
- [ ] **Step 3:** Run the tests. Expected: FAIL.
- [ ] **Step 4:** Implement as decided. Add the `WORKER_INTERRUPTED` label in `i18n.ts` in both locales.
- [ ] **Step 5:** Run `rtk go test ./...`, `rtk bash scripts/test-integration.sh` and `rtk corepack pnpm typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit `fix(worker): keep undecodable originals and stop crash loops`.

### Task 6: Bounded on-demand thumbnails (AUD2-004)

**Files:**
- Modify: `internal/api/server.go:1530-1550` and the `Server` struct
- Test: `internal/api/pipeline_test.go` (integration-gated, because the route needs a session). It uses a stub `ffmpeg` on `PATH`, following the existing stub pattern; `media` calls `exec.CommandContext(ctx, "ffmpeg", ...)`.

**Decisions:**
- `Server` gets `thumbSem chan struct{}` (capacity 2) and `thumbFlight singleflight.Group`, keyed `id + ":" + strconv.Itoa(size)`. Acquire the semaphore inside the `singleflight` function, so callers for the same key share one result and one slot.
- If the semaphore is not free immediately (`select` with `default`), the function returns a sentinel error that the handler maps to `503` with `Retry-After: 5`.
- On a cache hit, call `media.Touch(path)` so thumbnails the owner is viewing are not evicted by age. Do not change cleanup logic.

- [ ] **Step 1:** Write `TestThumbnailConcurrencyBounded`. A stub `ffmpeg` sleeps 500 ms and appends to a counter file. Ten parallel requests for distinct ids give at most 2 concurrent stub runs, and the rest return 503 with `Retry-After`. Ten parallel requests for the same id produce exactly one stub run.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement as decided.
- [ ] **Step 4:** Run `rtk go test ./internal/api`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(api): bound on-demand thumbnail generation`.

### Task 7: Resolve-album re-queues the group's blocked images (AUD2-005)

**Files:**
- Modify: `internal/api/server.go:1142-1174` (`handleResolveAlbum` transaction)
- Modify: `apps/web/src/workspace.tsx:382` (the `resolve-album` call; show the re-queued count after success)
- Modify: `docs/TROUBLESHOOTING.md` (replace "Retry the failed image")
- Test: `internal/api/pipeline_test.go`

**Decisions:**
- Inside the existing transaction, after the `LineGroup` update, run one `UPDATE "Image" SET "uploadStatus" = 'RETRY_PENDING', "updatedAt" = NOW() WHERE "lineGroupId" = (SELECT "lineGroupId" FROM "LineGroup" WHERE id = $1) AND "uploadStatus" = 'FAILED' AND "errorCode" = 'ALBUM_REVIEW' RETURNING id`.
- Then run one `INSERT INTO "OutboxEvent" ... SELECT` that creates a `PROCESS` row for each returned id. This mirrors `handleRetryJob` at `server.go:1785-1835`.
- Put the count in the audit metadata as `{"requeued": n}`. The response becomes `{"ok": true, "requeued": n}`. This is additive, so update the inline OpenAPI document in `server.go` without a version bump.

- [ ] **Step 1:** Write `TestResolveAlbumRequeuesGroup`. Seed group A with 3 `FAILED/ALBUM_REVIEW` images and 1 `FAILED/GOOGLE_STORAGE` image, and group B with 1 `FAILED/ALBUM_REVIEW` image. Resolve A. Assert: A's 3 `ALBUM_REVIEW` images are `RETRY_PENDING` with one outbox row each; A's `GOOGLE_STORAGE` image and B's image are unchanged; the response has `requeued` = 3.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement. Show "N photos re-queued" in the existing resolve success message, with i18n keys in both locales.
- [ ] **Step 4:** Run `rtk bash scripts/test-integration.sh`, `rtk corepack pnpm typecheck` and `rtk corepack pnpm build`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(api): re-queue album-blocked images on resolve`.

### Task 8: CI gate for pull requests and releases (AUD2-006, plus `govulncheck` from AUD2-011)

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release-images.yml`
- Modify: `internal/db/migrate_test.go:49-50` (stale Prisma comment)

**Decisions:**
- `ci.yml` triggers on `pull_request`, `push` to `main`, and `workflow_call`. It has three jobs:
  - `go`: `setup-go` with an exact `go-version`: the newest `1.27.x` patch at execution time, at least `1.27.4`. Task 13 pins the `golang` builder image to the same patch, and the two must be updated together from then on. Do not use `go-version-file`: `go.mod` says `go 1.26.0`, and `govulncheck` would then report standard-library vulnerabilities fixed in the shipped toolchain. Run `go vet ./...`, `test -z "$(gofmt -l cmd internal packages)"`, `go test ./...`, and `go run golang.org/x/vuln/cmd/govulncheck@<pinned release tag> ./...`. Look the tag up at execution time; do not use `@latest`.
  - `web`: Node 24, `corepack pnpm install --frozen-lockfile`, `typecheck`, `build`, `node --test scripts/version-control.test.mjs`, `node scripts/sync-version.mjs --check`.
  - `integration`: `sudo apt-get install -y ffmpeg` (which provides `ffprobe`), then `bash scripts/test-integration.sh`. Docker is available on `ubuntu-24.04`, the runner `release-images.yml` already uses.
- All jobs run with `permissions: contents: read`.
- `release-images.yml` adds a job `ci: uses: ./.github/workflows/ci.yml`, and the `publish` job gets `needs: ci`.
- Make the `migrate_test.go` comment describe what the test does now: re-running Go migrations on a Go-migrated database. Do not invent a Prisma fixture.

- [ ] **Step 1:** Write both workflow changes and fix the comment.
- [ ] **Step 2:** Run each job's commands locally in sequence. Expected: PASS. This depends on Task 14's `gofmt` fix; if Task 14 has not landed, include that one-file `gofmt -w internal/crypto/crypto.go` here.
- [ ] **Step 3:** Validate the workflow syntax with the `rhysd/actionlint` Docker image at a pinned release tag, looked up at execution time. If it cannot be pulled, review the syntax by hand and say so in the commit body.
- [ ] **Step 4:** Commit `ci: run tests on PRs and gate image releases`.

### Task 9: Single-query `/groups` (AUD2-007)

**Files:**
- Modify: `internal/api/server.go:824-828` (`fetchGroupMap` per-row query), `:855-881`
- Test: existing `/groups` coverage in `pipeline_test.go`; add an assertion if the latest-image fields are not asserted yet

**Decisions:**
- `fetchGroupMap` has two callers: `handleGetGroups` (`rows`) and a single-group query at about `server.go:920` (`row`). Both SQL statements gain the same `LEFT JOIN LATERAL (SELECT "id", "lineEventTimestamp", "uploadStatus"::text FROM "Image" WHERE "lineGroupId" = g."lineGroupId" ORDER BY "lineEventTimestamp" DESC LIMIT 1) li ON true`, selecting the three `li` columns last.
- `fetchGroupMap` scans those columns into nullable variables, and drops its nested `QueryRow` and its `ctx` use.
- The existing index `Image_lineGroupId_lineEventTimestamp_idx` serves the join. The JSON shape stays the same, including `images: []` when a group has no image.

- [ ] **Step 1:** Make sure a test asserts the latest-image fields for two groups with different latest images. Run it. Expected: PASS (it guards the refactor).
- [ ] **Step 2:** Refactor.
- [ ] **Step 3:** Run `rtk bash scripts/test-integration.sh`. Expected: PASS.
- [ ] **Step 4:** Commit `perf(api): load groups with one query`.

### Task 10: Standard Range handling for local media (AUD2-008)

**Files:**
- Modify: `internal/api/server.go:1493-1517`
- Test: `internal/api/` unit test with `httptest`

**Decisions:** Replace the manual parsing with `http.ServeContent(w, r, "", fi.ModTime(), f)`. Set `Content-Type` before the call. Keep the existing `Cache-Control` behavior.

- [ ] **Step 1:** Write `TestLocalMediaRange` against a 1000-byte file:
  - `bytes=-10` returns 206 with `Content-Range: bytes 990-999/1000` and the last 10 bytes.
  - `bytes=5000-` returns 416.
  - `bytes=0-9` returns 206 with 10 bytes.
  - No `Range` header returns 200 with 1000 bytes.
- [ ] **Step 2:** Run it. Expected: FAIL on the first two cases.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `fix(api): use http.ServeContent for local media ranges`.

### Task 11: Stop reporting failures as success (AUD2-009, plus the dashboard query from report §3)

**Files:**
- Modify: `internal/api/server.go`: `handleDashboardStats`, `handleAuth` (login lookup), `handlePostSettingsLine` (mismatch count), `handleGoogleCallback`, `handleHealth`
- Modify: `internal/db/db.go:156-166` (credential decrypt fallback)
- Modify: `apps/web/src/data.ts:31`
- Modify: `apps/web/src/workspace.tsx` (Settings page: read `google_error`)
- Test: `internal/api/pipeline_test.go`

**Decisions:**
- Dashboard: replace the 7 `COUNT`s with one `SELECT COUNT(*) FILTER (WHERE ...) ...` query, and return 5xx through `writeErr` on error.
- Login: only `pgx.ErrNoRows` yields 401. Any other error goes through `writeErr`, which returns 5xx.
- `:616`: propagate the error.
- Credential decrypt failure: log `{"level":50,"msg":"saved LINE credentials could not be decrypted; using environment values"}` once per process, never with the secret. Set a flag that `handleHealth` adds to its JSON as `"lineCredentials": "Undecryptable"`, omitted when the credentials are fine. Keep the environment fallback.
- OAuth callback failure: replace each `writeErr`/`writeJSON` exit with a `302` to `/settings?google_error=<code>`:
  - `state`: bad request or invalid/expired state.
  - `denied`: `GOOGLE_AUTH`.
  - `scopes`: `GOOGLE_SCOPES`.
  - `exchange`: any other error.

  The Settings page reads `google_error` with `useSearchParams` and shows the matching i18n message in both locales.
- `data.ts` `api()`: read `content-type` first. If it lacks `application/json`, skip `r.json()`. For `!r.ok`, throw `Error("Request failed.")`, keeping the existing 401 redirect. For a 2xx response, throw `Error("Unexpected response.")`.

- [ ] **Step 1:** Write the tests. The first two each build their own `Server` on a second `db.Connect` pool and close that pool, so the shared test pool stays usable.
  - Login with the pool closed returns 500, not 401.
  - The dashboard with the pool closed returns 500.
  - An OAuth callback with a bad state returns 302 with `Location` `/settings?google_error=state`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement all the decisions above.
- [ ] **Step 4:** Run `rtk bash scripts/test-integration.sh`, `rtk corepack pnpm typecheck` and `rtk corepack pnpm build`. Expected: PASS.
- [ ] **Step 5:** Commit `fix: surface database and OAuth failures instead of false success`.

### Task 12: One sanitized group-name fetch (AUD2-010)

**Files:**
- Modify: `internal/line/line.go` (new helpers)
- Modify: `internal/worker/worker.go:195-214` (`GROUP_SUMMARY` event), `:476-492` (display name on first upload)
- Modify: `internal/api/server.go` (`handleRefreshGroup`; move `ctrlCharsRe` to `line` if nothing else in `api` uses it)
- Test: `internal/line/line_test.go`

**Interfaces:**
- Produces:
  - `line.CleanGroupName(s string) string`: replaces `[\x00-\x1f\x7f]` with a space, trims, and truncates to 500 runes. It is the API's current logic, moved here unchanged.
  - `line.GroupName(ctx context.Context, token, groupID string) (string, error)`: calls `line.Call(ctx, "group/"+url.PathEscape(groupID)+"/summary", token, false, 90*time.Second)`, decodes `groupName`, closes the body, and returns `CleanGroupName` of it. It returns an error when the name is empty or cannot be decoded.

  All three call sites (`handleRefreshGroup` and the two worker blocks) replace their inline call, decode and truncate with `line.GroupName`. Each caller keeps its own error handling: the API maps errors as it does today, and the worker ignores them as it does today.

- [ ] **Step 1:** Write table tests for `CleanGroupName`: control characters, tabs and newlines become spaces; plain Thai text is unchanged; 600 runes are truncated to 500. Add an `httptest` test for `GroupName` with an id containing `/`, asserting that the escaped path is requested. If `line.Call`'s base URL is not overridable, test only `CleanGroupName` and say so.
- [ ] **Step 2:** Move the logic, and switch all three call sites.
- [ ] **Step 3:** Run `rtk go test ./...`. Expected: PASS.
- [ ] **Step 4:** Commit `refactor(line): share group-name sanitization between API and worker`.

### Task 13: Pin base images (AUD2-011)

**Files:**
- Modify every floating `FROM` and `image:` that exists when this task runs:
  - `Dockerfile.api` (including the new `node:24-bookworm-slim` web-build stage from the SPA change)
  - `Dockerfile.worker`
  - `Dockerfile.web`, if it still exists
  - `infra/caddy/Dockerfile`
  - `docker-compose.yml` (`postgres`, `redis`, and `web`'s `nginxinc/nginx-unprivileged` once it is an `image:`)
  - `docs/example-deploy/compose.yml`

  Find them with `rtk grep -nE '^FROM|image:' Dockerfile.* infra docker-compose.yml docs/example-deploy/compose.yml`.
- Modify: `docs/DOCKER_DEPLOYMENT.md` (a short "updating base images" note)

**Decisions:** Pin exact patch tags at execution time, looked up from the registry and never guessed: `golang:<same 1.27.x patch as CI's setup-go (Task 8)>-alpine`; the current `alpine:3.21.x`; `node:24.x.y-bookworm-slim`; `nginxinc/nginx-unprivileged:<x.y.z>-alpine`; `caddy:2.x.y-alpine`; `postgres:18.x`, keeping major 18 so the data volume stays compatible; `redis:7.x.y-alpine`. Use tags, not digests, so that a deliberate update is a one-line diff.

- [ ] **Step 1:** Look up the current patch tags and apply them.
- [ ] **Step 2:** Run `rtk docker compose --profile edge config --quiet`, then build the `api`, `worker` and `web` images locally. Expected: success. Running `go version` in the built API image prints at least `go1.27.4`.
- [ ] **Step 3:** Commit `build: pin base image versions`.

### Task 14: Small observations (AUD2-012)

**Files:**
- Modify: `cmd/rivosnap/main.go:133-136`
- Modify: `internal/api/server.go:1630`
- Modify: `internal/worker/worker.go:767-771`, `:708-709`, `dispatch` (`:716-735`)
- Modify: `handleHealth` in `internal/api/server.go`; the `Health` page in `apps/web/src/workspace.tsx` (or wherever the `health` route component lives)
- Modify: `apps/web/src/main.tsx:223`, `:239`
- Modify: `internal/crypto/crypto.go` (gofmt), `internal/media/media.go:70`, `internal/model/model.go:80` (ST1005)

**Decisions:**
- `http.Server`: set `ReadHeaderTimeout: 10 * time.Second` and `IdleTimeout: 120 * time.Second`. Leave `WriteTimeout` unset, because media streaming needs it unset.
- Wrap the Google thumbnail read in `io.LimitReader(body, 10<<20)`.
- After `ProcessEvent` returns in `dispatch`, the worker sets the Redis key `worker:lastProgress` (UTC RFC3339Nano, no TTL). `handleHealth` adds it to its JSON as `"workerLastProgressAt"`, omitted when missing. The Health page shows it as one extra row under Worker, with i18n in both locales.
- The Upload queue badge replaces `useQueryClient().getQueryData<Stats>(["/dashboard/stats"])` with `query<Stats>("/dashboard/stats")` from `data.ts`. It uses the same key, so it shares the dashboard's cache and its 15 s polling.
- Retention, using the existing cleanup loop: delete `UploadAttempt` rows of `SYNCED` images older than 90 days, and `AuditLog` rows older than 365 days. Use fixed constants next to the `WebhookEvent` pruning, not new settings.
- Make the ST1005 error strings lowercase without trailing punctuation. Only internal error strings change; user-facing `Fault` messages are untouched.
- The gallery index and keyset pagination remain benchmark candidates (report §3). They are out of scope here; add them to `docs/plans/roadmap.md`, creating that file.

- [ ] **Step 1:** Write a cleanup test: seed an old `SYNCED` image's attempts and an old `AuditLog` row, run `Cleanup`, and assert both are pruned while recent rows remain.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement all the decisions above.
- [ ] **Step 4:** Run:
  - `rtk go vet ./...`
  - `test -z "$(gofmt -l cmd internal packages)"`
  - `~/go/bin/staticcheck ./...` (expected: clean)
  - `rtk bash scripts/test-integration.sh`
  - `rtk corepack pnpm typecheck`
  - `rtk corepack pnpm build`

  Expected: all PASS.
- [ ] **Step 5:** Commit `chore: server timeouts, bounded reads, progress heartbeat, retention`.

### Closeout

- [ ] Run the full check set from Global Constraints, plus Playwright e2e (`rtk corepack pnpm e2e`, per README.md).
- [ ] Update this plan's **Status:** line, move the file to `docs/plans/completed/`, and update `docs/plans/README.md`.
