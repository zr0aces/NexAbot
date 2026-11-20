ALTER TABLE "LineGroup" ADD COLUMN "enabledSince" TIMESTAMP(3);
UPDATE "LineGroup" SET "enabledSince" = "membershipAt" WHERE enabled;
