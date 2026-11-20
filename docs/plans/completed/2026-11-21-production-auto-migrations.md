# Production-compatible embedded migration runner (`_prisma_migrations` bridge)

**Status:** 2026-11-21 — Completed and verified (`go test ./...`, `test-integration.sh`, and Docker image build pass).

## Goal

Ensure the Go `rivosnap-api` Docker image embeds the exact ordered SQL migration scripts (`202611190001_initial`, `202611190002_authorization_window`, `202611200001_video_support`, and any future migrations) and automatically detects, validates, applies, and records migrations in PostgreSQL's `_prisma_migrations` ledger on startup without manual intervention—working identically on existing Prisma-migrated production databases, partially migrated databases, and brand-new installations.

## Scrutiny findings & hardening applied to this plan

1. **Session-scoped advisory lock on a pooled connection**:
   - Calling `d.Pool.Exec(ctx, "SELECT pg_advisory_lock(72819054)")` on a `pgxpool.Pool` can run `pg_advisory_lock` on pooled connection A and `pg_advisory_unlock` on pooled connection B (leaving connection A locked and failing to unlock).
   - **Fix**: Acquire a dedicated connection via `conn, err := d.Pool.Acquire(ctx)` (`defer conn.Release()`) and run `pg_advisory_lock`, all migration queries/transactions, and `pg_advisory_unlock` on that single `conn` (with `defer conn.Exec(context.Background(), "SELECT pg_advisory_unlock(72819054)")`).
2. **Exact Prisma `_prisma_migrations` schema & SHA-256 checksum parity**:
   - Live production schema verified:
     ```sql
     CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
         "id" VARCHAR(36) NOT NULL PRIMARY KEY,
         "checksum" VARCHAR(64) NOT NULL,
         "finished_at" TIMESTAMPTZ,
         "migration_name" VARCHAR(255) NOT NULL,
         "logs" TEXT,
         "rolled_back_at" TIMESTAMPTZ,
         "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
         "applied_steps_count" INTEGER NOT NULL DEFAULT 0
     );
     ```
   - Prisma computes `checksum` as the hex SHA-256 of the raw `migration.sql` bytes:
     - `202611190001_initial`: `db8d930f1f8ce52b2bf71ef6c060019ce4b9f07bbb84e74d6037cf848e01ed66`
     - `202611190002_authorization_window`: `4ea50f39fe7ec571be43c919d38b63c80192b1b314e1dbb41b63148adca1c966`
     - `202611200001_video_support`: `47c5467f66d0317d2f13dc80639ff48819e95fe654f887829c6f0177f164f8bf`
   - Embedding those exact byte-for-byte `migration.sql` files produces the exact same SHA-256 checksums.
3. **Handling unfinished / failed or legacy baseline databases**:
   - **Normal production upgrade**: `_prisma_migrations` already has rows for `202611190001_initial`, `202611190002_authorization_window`, and `202611200001_video_support` with `finished_at IS NOT NULL AND rolled_back_at IS NULL`. The runner verifies them, skips them without re-executing (protecting data backfills like `UPDATE "LineGroup" SET "enabledSince" = "membershipAt" WHERE enabled`), and applies only newer migrations.
   - **Unfinished migration safety**: If `_prisma_migrations` has a row with `finished_at IS NULL AND rolled_back_at IS NULL`, the runner returns a clear error (`migration <name> previously failed and was not rolled back`) and blocks `/ready` rather than corrupting production state.
   - **Baseline detection for unrecorded schemas**: If `_prisma_migrations` is empty on a database where `"Owner"` already exists (e.g., created by an earlier `CREATE TABLE IF NOT EXISTS` run without `_prisma_migrations`), detect which migrations' target columns already exist (`"Owner"` table for `202611190001_initial`, `"LineGroup"."enabledSince"` for `202611190002_authorization_window`, `"Image"."mediaType"` for `202611200001_video_support`) and baseline-record them in `_prisma_migrations` before running any unapplied migrations.
4. **Startup connection resilience & observability**:
   - In `db.Connect(ctx, env)`, retry initial `pool.Ping(ctx)` with a 500ms backoff for up to 15 seconds in case PostgreSQL just passed `pg_isready` and is finishing recovery.
   - Log migration discovery and application status (`N migrations found`, `Applying migration <name>`, or `No pending migrations to apply.`) to stdout so `docker compose logs api` gives operators the same clear audit trail Prisma provided.
   - Copy `packages/database/migrations` to `/app/packages/database/migrations` in `Dockerfile.api` as well as embedding them in the binary (`internal/db/migrations/*/migration.sql`) so both `/app/rivosnap migrate` and `node node_modules/prisma/build/index.js migrate deploy` work in container inspection or manual maintenance commands.

## Task list

- [x] **1. Embed exact migration scripts in `internal/db/migrations/`**:
  - Copy byte-identical `202611190001_initial/migration.sql`, `202611190002_authorization_window/migration.sql`, and `202611200001_video_support/migration.sql` into `internal/db/migrations/<name>/migration.sql`.
  - Embed them with `//go:embed migrations/*/migration.sql` in `internal/db/migrate.go`.
- [x] **2. Implement `_prisma_migrations`-compatible runner in `internal/db/migrate.go`**:
  - Acquire a single connection from `d.Pool.Acquire(ctx)` and lock `SELECT pg_advisory_lock(72819054)` (`defer pg_advisory_unlock`).
  - Ensure `_prisma_migrations` table exists with the exact Prisma column definitions.
  - Load existing rows from `_prisma_migrations`:
    - Fail fast if any row has `finished_at IS NULL AND rolled_back_at IS NULL`.
    - Skip any migration with `finished_at IS NOT NULL AND rolled_back_at IS NULL`.
  - Handle baseline backfill if `_prisma_migrations` has 0 rows but `"Owner"` table already exists in `public`.
  - For each pending migration in lexical order:
    - Execute the SQL and insert the completed `_prisma_migrations` row (`id`, `checksum`, `migration_name`, `started_at`, `finished_at`, `applied_steps_count = 1`) inside a single transaction (`tx.Begin` → `tx.Exec(sql)` → `tx.Exec(insert)` → `tx.Commit`).
  - Add bounded connection retry (up to 15s) in `db.Connect`.
- [x] **3. Bundle migration files in Docker images & verify in CI**:
  - Copy `packages/database/migrations` into `/app/packages/database/migrations` in `Dockerfile.api` (and include `!packages/database/migrations/**` in `.dockerignore`).
  - Add unit + integration tests in `internal/db/migrate_test.go`:
    1. **Prisma → Go upgrade test**: Run `prisma migrate deploy` first, then run Go `database.Migrate(ctx)` and verify all 3 checksums match, 0 migrations are re-applied, and `enabledSince` is not overwritten.
    2. **Fresh database test**: Drop/reset schema, run Go `database.Migrate(ctx)` on an empty DB, and verify all 3 migrations are applied and recorded in `_prisma_migrations` with exact SHA-256 checksums.
    3. **Incremental new migration test**: Simulate a 4th migration and verify Go applies only the 4th migration transactionally.
  - Update `.github/workflows/release-images.yml` and `docs/ARCHITECTURE.md` / `docs/DOCKER_DEPLOYMENT.md` to document and verify the embedded migration runner.
