-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UploadState" AS ENUM ('RECEIVED', 'DOWNLOAD_PENDING', 'DOWNLOADING', 'STAGED', 'UPLOAD_PENDING', 'UPLOADING', 'CREATING_MEDIA', 'SYNCED', 'RETRY_PENDING', 'NEEDS_REVIEW', 'FAILED', 'UNRECOVERABLE');

-- CreateTable
CREATE TABLE "Owner" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Owner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleConnection" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "ownerId" INTEGER NOT NULL,
    "googleAccountId" TEXT,
    "encryptedRefreshToken" TEXT,
    "scopes" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastValidatedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "GoogleConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineGroup" (
    "id" TEXT NOT NULL,
    "lineGroupId" TEXT NOT NULL,
    "displayName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "membershipStatus" TEXT NOT NULL DEFAULT 'JOINED',
    "membershipAt" TIMESTAMP(3) NOT NULL,
    "googleAlbumId" TEXT,
    "albumCreating" BOOLEAN NOT NULL DEFAULT false,
    "lastEventAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LineGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Image" (
    "id" TEXT NOT NULL,
    "lineGroupId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "lineMessageId" TEXT NOT NULL,
    "lineEventTimestamp" TIMESTAMP(3) NOT NULL,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT,
    "googleMediaItemId" TEXT,
    "productUrl" TEXT,
    "uploadStatus" "UploadState" NOT NULL DEFAULT 'RECEIVED',
    "stagingPath" TEXT,
    "thumbnailPath" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadAttempt" (
    "id" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "UploadAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "webhookEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "processingStatus" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Owner_email_key" ON "Owner"("email");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleConnection_ownerId_key" ON "GoogleConnection"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "LineGroup_lineGroupId_key" ON "LineGroup"("lineGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "LineGroup_googleAlbumId_key" ON "LineGroup"("googleAlbumId");

-- CreateIndex
CREATE UNIQUE INDEX "Image_googleMediaItemId_key" ON "Image"("googleMediaItemId");

-- CreateIndex
CREATE INDEX "Image_uploadStatus_createdAt_idx" ON "Image"("uploadStatus", "createdAt");

-- CreateIndex
CREATE INDEX "Image_lineGroupId_lineEventTimestamp_idx" ON "Image"("lineGroupId", "lineEventTimestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Image_channelId_lineMessageId_key" ON "Image"("channelId", "lineMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadAttempt_imageId_attemptNumber_key" ON "UploadAttempt"("imageId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_webhookEventId_key" ON "WebhookEvent"("webhookEventId");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_availableAt_idx" ON "OutboxEvent"("publishedAt", "availableAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "GoogleConnection" ADD CONSTRAINT "GoogleConnection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_lineGroupId_fkey" FOREIGN KEY ("lineGroupId") REFERENCES "LineGroup"("lineGroupId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadAttempt" ADD CONSTRAINT "UploadAttempt_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "Owner" ADD CHECK (id = 1);
ALTER TABLE "Image" ADD CHECK ("uploadStatus" <> 'SYNCED' OR length(trim("googleMediaItemId")) > 0 AND "googleMediaItemId" IS NOT NULL);
