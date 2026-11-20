import { z } from "zod";
import { limits } from "./model";
export const env = z
  .object({
    APP_URL: z.url().transform((s) => new URL(s).origin),
    NODE_ENV: z.string().default("development"),
    REDIS_URL: z.url(),
    SESSION_SECRET: z.string().min(32),
    BOOTSTRAP_SECRET: z.string().min(24),
    TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
    LINE_CHANNEL_ACCESS_TOKEN: z.string().optional(),
    LINE_CHANNEL_SECRET: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.url(),
    STAGING_PATH: z.string().default("/data/staging"),
    THUMBNAIL_PATH: z.string().default("/data/thumbnails"),
    MAX_IMAGE_SIZE_MB: z.coerce.number().int().min(1).max(200).default(50),
    MIN_FREE_MB: z.coerce.number().int().min(1).default(1024),
    STAGING_RETENTION_HOURS: z.coerce.number().default(24),
    FAILED_RETENTION_DAYS: z.coerce.number().default(7),
    THUMBNAIL_RETENTION_DAYS: z.coerce.number().default(30),
  })
  .parse(process.env);
if (env.NODE_ENV === "production" && !env.APP_URL.startsWith("https://"))
  throw Error("HTTPS required");
export const settings = (custom: unknown) =>
  limits.parse({
    stagingHours: env.STAGING_RETENTION_HOURS,
    failedDays: env.FAILED_RETENTION_DAYS,
    thumbnailDays: env.THUMBNAIL_RETENTION_DAYS,
    ...(typeof custom === "object" ? custom : {}),
  });
