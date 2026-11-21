-- One-off repair (AUD2-001): shift Bangkok-wall-clock timestamps back to UTC.
--
-- Run ONCE, by the owner, while `api` and `worker` are stopped and BEFORE the
-- fixed (UTC-pinned) build starts. Never run it after the fixed build has run:
-- pre-fix Bangkok values and post-fix UTC values overlap for 7 hours and cannot
-- be told apart. Runbook: docs/TROUBLESHOOTING.md.
--
-- Usage:
--   psql -v cutover_bkk='YYYY-MM-DD HH:MM:SS' -U <user> -d <db> -f scripts/repair/2026-11-21-utc-timestamps.sql
-- :cutover_bkk is the Go backend cutover time as Bangkok wall clock. Every
-- listed value >= :cutover_bkk is shifted back by 7 hours.
--
-- Never touched (they come from LINE or UTC Go values): "Image"."lineEventTimestamp",
-- "LineGroup"."membershipAt", "LineGroup"."lastEventAt".
--
-- Assumption to check on a restored copy first: legacy rows before the cutover
-- already look UTC ("Image"."createdAt" within seconds of "lineEventTimestamp").
-- If not, adjust :cutover_bkk or the column list and record why here.
--
-- Idempotency: one transaction; aborts if an "AuditLog" row with action
-- 'UTC timestamp repair' exists, and inserts that row when done.

\set ON_ERROR_STOP on
BEGIN;
-- psql would otherwise inherit the server's Asia/Bangkok and our own NOW() would be +7h.
SET LOCAL timezone = 'UTC';

-- Preview: rows that will be shifted, per column.
SELECT 'LineGroup.enabledSince' AS "column", count(*) AS rows_affected FROM "LineGroup" WHERE "enabledSince" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'LineGroup.createdAt' AS "column", count(*) AS rows_affected FROM "LineGroup" WHERE "createdAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'LineGroup.updatedAt' AS "column", count(*) AS rows_affected FROM "LineGroup" WHERE "updatedAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'Image.uploadedAt' AS "column", count(*) AS rows_affected FROM "Image" WHERE "uploadedAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'Image.createdAt' AS "column", count(*) AS rows_affected FROM "Image" WHERE "createdAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'Image.updatedAt' AS "column", count(*) AS rows_affected FROM "Image" WHERE "updatedAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'UploadAttempt.startedAt' AS "column", count(*) AS rows_affected FROM "UploadAttempt" WHERE "startedAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'UploadAttempt.completedAt' AS "column", count(*) AS rows_affected FROM "UploadAttempt" WHERE "completedAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'WebhookEvent.receivedAt' AS "column", count(*) AS rows_affected FROM "WebhookEvent" WHERE "receivedAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'WebhookEvent.processedAt' AS "column", count(*) AS rows_affected FROM "WebhookEvent" WHERE "processedAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'AuditLog.createdAt' AS "column", count(*) AS rows_affected FROM "AuditLog" WHERE "createdAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'GoogleConnection.connectedAt' AS "column", count(*) AS rows_affected FROM "GoogleConnection" WHERE "connectedAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'GoogleConnection.lastValidatedAt' AS "column", count(*) AS rows_affected FROM "GoogleConnection" WHERE "lastValidatedAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'Owner.createdAt' AS "column", count(*) AS rows_affected FROM "Owner" WHERE "createdAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'Owner.updatedAt' AS "column", count(*) AS rows_affected FROM "Owner" WHERE "updatedAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'OutboxEvent.createdAt' AS "column", count(*) AS rows_affected FROM "OutboxEvent" WHERE "createdAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'OutboxEvent.availableAt' AS "column", count(*) AS rows_affected FROM "OutboxEvent" WHERE "availableAt" >= :'cutover_bkk'::timestamp
UNION ALL
SELECT 'OutboxEvent.publishedAt' AS "column", count(*) AS rows_affected FROM "OutboxEvent" WHERE "publishedAt" >= :'cutover_bkk'::timestamp;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AuditLog" WHERE "action" = 'UTC timestamp repair') THEN
    RAISE EXCEPTION 'UTC timestamp repair already applied; refusing to run twice';
  END IF;
END $$;

UPDATE "LineGroup" SET
    "enabledSince" = CASE WHEN "enabledSince" >= :'cutover_bkk'::timestamp THEN "enabledSince" - interval '7 hours' ELSE "enabledSince" END,
    "createdAt" = CASE WHEN "createdAt" >= :'cutover_bkk'::timestamp THEN "createdAt" - interval '7 hours' ELSE "createdAt" END,
    "updatedAt" = CASE WHEN "updatedAt" >= :'cutover_bkk'::timestamp THEN "updatedAt" - interval '7 hours' ELSE "updatedAt" END
WHERE "enabledSince" >= :'cutover_bkk'::timestamp OR "createdAt" >= :'cutover_bkk'::timestamp OR "updatedAt" >= :'cutover_bkk'::timestamp;

UPDATE "Image" SET
    "uploadedAt" = CASE WHEN "uploadedAt" >= :'cutover_bkk'::timestamp THEN "uploadedAt" - interval '7 hours' ELSE "uploadedAt" END,
    "createdAt" = CASE WHEN "createdAt" >= :'cutover_bkk'::timestamp THEN "createdAt" - interval '7 hours' ELSE "createdAt" END,
    "updatedAt" = CASE WHEN "updatedAt" >= :'cutover_bkk'::timestamp THEN "updatedAt" - interval '7 hours' ELSE "updatedAt" END
WHERE "uploadedAt" >= :'cutover_bkk'::timestamp OR "createdAt" >= :'cutover_bkk'::timestamp OR "updatedAt" >= :'cutover_bkk'::timestamp;

UPDATE "UploadAttempt" SET
    "startedAt" = CASE WHEN "startedAt" >= :'cutover_bkk'::timestamp THEN "startedAt" - interval '7 hours' ELSE "startedAt" END,
    "completedAt" = CASE WHEN "completedAt" >= :'cutover_bkk'::timestamp THEN "completedAt" - interval '7 hours' ELSE "completedAt" END
WHERE "startedAt" >= :'cutover_bkk'::timestamp OR "completedAt" >= :'cutover_bkk'::timestamp;

UPDATE "WebhookEvent" SET
    "receivedAt" = CASE WHEN "receivedAt" >= :'cutover_bkk'::timestamp THEN "receivedAt" - interval '7 hours' ELSE "receivedAt" END,
    "processedAt" = CASE WHEN "processedAt" >= :'cutover_bkk'::timestamp THEN "processedAt" - interval '7 hours' ELSE "processedAt" END
WHERE "receivedAt" >= :'cutover_bkk'::timestamp OR "processedAt" >= :'cutover_bkk'::timestamp;

UPDATE "AuditLog" SET
    "createdAt" = CASE WHEN "createdAt" >= :'cutover_bkk'::timestamp THEN "createdAt" - interval '7 hours' ELSE "createdAt" END
WHERE "createdAt" >= :'cutover_bkk'::timestamp;

UPDATE "GoogleConnection" SET
    "connectedAt" = CASE WHEN "connectedAt" >= :'cutover_bkk'::timestamp THEN "connectedAt" - interval '7 hours' ELSE "connectedAt" END,
    "lastValidatedAt" = CASE WHEN "lastValidatedAt" >= :'cutover_bkk'::timestamp THEN "lastValidatedAt" - interval '7 hours' ELSE "lastValidatedAt" END
WHERE "connectedAt" >= :'cutover_bkk'::timestamp OR "lastValidatedAt" >= :'cutover_bkk'::timestamp;

UPDATE "Owner" SET
    "createdAt" = CASE WHEN "createdAt" >= :'cutover_bkk'::timestamp THEN "createdAt" - interval '7 hours' ELSE "createdAt" END,
    "updatedAt" = CASE WHEN "updatedAt" >= :'cutover_bkk'::timestamp THEN "updatedAt" - interval '7 hours' ELSE "updatedAt" END
WHERE "createdAt" >= :'cutover_bkk'::timestamp OR "updatedAt" >= :'cutover_bkk'::timestamp;

UPDATE "OutboxEvent" SET
    "createdAt" = CASE WHEN "createdAt" >= :'cutover_bkk'::timestamp THEN "createdAt" - interval '7 hours' ELSE "createdAt" END,
    "availableAt" = CASE WHEN "availableAt" >= :'cutover_bkk'::timestamp THEN "availableAt" - interval '7 hours' ELSE "availableAt" END,
    "publishedAt" = CASE WHEN "publishedAt" >= :'cutover_bkk'::timestamp THEN "publishedAt" - interval '7 hours' ELSE "publishedAt" END
WHERE "createdAt" >= :'cutover_bkk'::timestamp OR "availableAt" >= :'cutover_bkk'::timestamp OR "publishedAt" >= :'cutover_bkk'::timestamp;

INSERT INTO "AuditLog" ("id", "action", "targetType", "targetId", "metadata", "createdAt")
VALUES (gen_random_uuid()::text, 'UTC timestamp repair', 'system', 'timestamps',
        jsonb_build_object('cutover_bkk', :'cutover_bkk', 'shift', '-7 hours'), NOW());

COMMIT;
