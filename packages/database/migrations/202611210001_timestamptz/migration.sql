-- Stored values are UTC wall-clock (session pinned to UTC); reinterpret them as UTC instants.

ALTER TABLE "Owner"
    ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "GoogleConnection"
    ALTER COLUMN "connectedAt" TYPE TIMESTAMPTZ(3) USING "connectedAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "lastValidatedAt" TYPE TIMESTAMPTZ(3) USING "lastValidatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "LineGroup"
    ALTER COLUMN "membershipAt" TYPE TIMESTAMPTZ(3) USING "membershipAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "lastEventAt" TYPE TIMESTAMPTZ(3) USING "lastEventAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "enabledSince" TYPE TIMESTAMPTZ(3) USING "enabledSince" AT TIME ZONE 'UTC';

ALTER TABLE "Image"
    ALTER COLUMN "lineEventTimestamp" TYPE TIMESTAMPTZ(3) USING "lineEventTimestamp" AT TIME ZONE 'UTC',
    ALTER COLUMN "uploadedAt" TYPE TIMESTAMPTZ(3) USING "uploadedAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "UploadAttempt"
    ALTER COLUMN "startedAt" TYPE TIMESTAMPTZ(3) USING "startedAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "completedAt" TYPE TIMESTAMPTZ(3) USING "completedAt" AT TIME ZONE 'UTC';

ALTER TABLE "WebhookEvent"
    ALTER COLUMN "receivedAt" TYPE TIMESTAMPTZ(3) USING "receivedAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "processedAt" TYPE TIMESTAMPTZ(3) USING "processedAt" AT TIME ZONE 'UTC';

ALTER TABLE "OutboxEvent"
    ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "availableAt" TYPE TIMESTAMPTZ(3) USING "availableAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "publishedAt" TYPE TIMESTAMPTZ(3) USING "publishedAt" AT TIME ZONE 'UTC';

ALTER TABLE "AuditLog"
    ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';
