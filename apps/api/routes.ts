import type { FastifyInstance, FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import { db } from "../../packages/database";
import {
  access,
  clearAccessCache,
  lineCredentials,
} from "../../packages/database/connections";
import { seal } from "../../packages/shared/crypto";
import { env, settings } from "../../packages/shared/config";
import {
  filters,
  Fault,
  limits,
  terminal,
  transition,
} from "../../packages/shared/model";
import { line } from "../../packages/line-client";
import * as google from "../../packages/google-photos";
import {
  dirs,
  usage,
  free,
  pressured,
  pathFor,
  touch,
  thumbnail,
  cacheThumbnail,
} from "../../packages/image-processing";
const id = (q: FastifyRequest) => z.object({ id: z.uuid() }).parse(q.params).id;
const groupInclude = {
  _count: { select: { images: true } },
  images: {
    take: 1,
    orderBy: { lineEventTimestamp: "desc" as const },
    select: { id: true, lineEventTimestamp: true, uploadStatus: true },
  },
};
const audit = (action: string, targetType: string, targetId: string) =>
  db.auditLog.create({ data: { action, targetType, targetId } });
async function prefs() {
  return (await db.owner.findUniqueOrThrow({ where: { id: 1 } })).settings;
}
async function merge(
  data: Record<string, string | number | boolean | undefined>,
) {
  const clean = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined),
  );
  await db.$executeRaw`UPDATE "Owner" SET settings=settings || ${JSON.stringify(clean)}::jsonb WHERE id=1`;
}
const googleStatus = () =>
  db.googleConnection.findUnique({
    where: { id: 1 },
    select: {
      status: true,
      lastValidatedAt: true,
      lastError: true,
      scopes: true,
    },
  });
export function routes(
  a: FastifyInstance,
  redis: Redis,
  sid: (q: FastifyRequest) => string | null,
) {
  a.get("/health", async () => {
    await db.$queryRaw`SELECT 1`;
    const owner = await db.owner.findUnique({
      where: { id: 1 },
      select: { settings: true },
    });
    const policy = settings(owner?.settings);
    return {
      database: "Online",
      redis: await redis.ping(),
      worker: (await redis.get("worker:heartbeat"))
        ? "Online"
        : "Heartbeat missing",
      diskPressure: await pressured(policy.collectVideos),
    };
  });
  a.get("/settings", async () => {
    const c = await lineCredentials();
    return {
      ...settings(await prefs()),
      lineConfigured: !!(c.token && c.secret),
      webhook: env.APP_URL + "/api/webhooks/line",
      maxImageMB: env.MAX_IMAGE_SIZE_MB,
      maxVideoMB: env.MAX_VIDEO_SIZE_MB,
    };
  });
  a.patch("/settings", async (q) => {
    await merge(limits.partial().parse(q.body));
    await audit("Settings updated", "owner", "1");
    return { ok: true };
  });
  a.post("/settings/line", async (q) => {
    const b = z
      .object({
        token: z.string().min(5).max(4096),
        secret: z.string().min(10).max(256),
      })
      .parse(q.body);
    const info = z
      .object({ userId: z.string().min(1) })
      .parse(await (await line("info", b.token)).json());
    const existing = await lineCredentials();
    if (
      (existing.destination && existing.destination !== info.userId) ||
      (await db.image.count({ where: { channelId: { not: info.userId } } }))
    )
      throw new Fault("CHANNEL", "Use the original LINE channel.");
    await merge({
      lineToken: seal(b.token),
      lineSecret: seal(b.secret),
      destination: info.userId,
    });
    await audit("LINE credentials updated", "owner", "1");
    return { ok: true };
  });
  a.get(
    "/google/status",
    async () => (await googleStatus()) ?? { status: "DISCONNECTED" },
  );
  a.get("/google/connect", async (q, r) => {
    const state = randomBytes(32).toString("hex");
    await redis.set("oauth:" + state, sid(q)!, "EX", 600);
    return r.redirect(google.consent(state));
  });
  a.get("/google/callback", async (q, r) => {
    const b = z
      .object({ code: z.string().optional(), state: z.string().length(64) })
      .parse(q.query);
    if ((await redis.getdel("oauth:" + b.state)) !== sid(q))
      return r.code(403).send({ error: "OAuth state expired or invalid." });
    if (!b.code)
      throw new Fault(
        "GOOGLE_AUTH",
        "Consent declined. Start connection again.",
      );
    const t = await google.token({
      code: b.code,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    });
    if (
      !t.refresh_token ||
      !google.scopes.every((s) => t.scope?.split(" ").includes(s))
    )
      throw new Fault(
        "GOOGLE_SCOPES",
        "Grant all requested Google Photos permissions and offline access.",
      );
    await google.validate(t.access_token);
    const mapped = await db.lineGroup.findFirst({
      where: { googleAlbumId: { not: null } },
    });
    if (mapped?.googleAlbumId)
      await google.album(mapped.googleAlbumId, t.access_token);
    const data = {
      encryptedRefreshToken: seal(t.refresh_token),
      status: "CONNECTED",
      scopes: t.scope!,
      lastValidatedAt: new Date(),
      lastError: null,
    };
    await db.googleConnection.upsert({
      where: { id: 1 },
      create: { ownerId: 1, ...data },
      update: data,
    });
    clearAccessCache();
    await audit("Google connected", "owner", "1");
    return r.redirect("/settings");
  });
  a.post("/google/validate", async () => {
    await google.validate(await access(true));
    await db.googleConnection.update({
      where: { id: 1 },
      data: {
        status: "CONNECTED",
        lastError: null,
        lastValidatedAt: new Date(),
      },
    });
    return { ok: true };
  });
  a.post("/google/disconnect", async () => {
    await db.googleConnection.updateMany({
      data: {
        status: "DISCONNECTED",
        encryptedRefreshToken: null,
        lastError: null,
      },
    });
    clearAccessCache();
    await audit("Google disconnected", "owner", "1");
    return { ok: true };
  });
  a.get("/groups", async () =>
    db.lineGroup.findMany({
      include: groupInclude,
      orderBy: { lastEventAt: "desc" },
    }),
  );
  a.post("/groups/:id/resolve-album", async (q) => {
    const gid = id(q),
      b = z
        .object({
          albumId: z.string().max(512).optional(),
          confirmation: z.literal("I checked Google Photos"),
        })
        .parse(q.body);
    const group = await db.lineGroup.findUniqueOrThrow({
      where: { id: gid, albumCreating: true },
    });
    if (
      !(await db.image.count({
        where: { lineGroupId: group.lineGroupId, errorCode: "ALBUM_REVIEW" },
      }))
    )
      throw new Fault(
        "ALBUM_BUSY",
        "Wait until the album creation attempt finishes.",
      );
    if (b.albumId) await google.album(b.albumId, await access());
    await db.$transaction([
      db.lineGroup.update({
        where: { id: gid, albumCreating: true },
        data: { albumCreating: false, googleAlbumId: b.albumId || null },
      }),
      audit("Owner resolved uncertain album", "group", gid),
    ]);
    return { ok: true };
  });
  a.get("/groups/:id", async (q) =>
    db.lineGroup.findUniqueOrThrow({
      where: { id: id(q) },
      include: groupInclude,
    }),
  );
  a.patch("/groups/:id", async (q) => {
    const b = z.object({ enabled: z.boolean() }).parse(q.body);
    await db.$transaction([
      db.lineGroup.update({
        where: {
          id: id(q),
          ...(b.enabled ? { membershipStatus: "JOINED" } : {}),
        },
        data: { ...b, enabledSince: b.enabled ? new Date() : null },
      }),
      audit(
        b.enabled ? "Collection enabled" : "Collection paused",
        "group",
        id(q),
      ),
    ]);
    return { ok: true };
  });
  a.post("/groups/:id/refresh", async (q) => {
    const gid = id(q),
      g = await db.lineGroup.findUniqueOrThrow({ where: { id: gid } });
    if (g.membershipStatus !== "JOINED")
      throw new Fault(
        "GROUP_LEFT",
        "Bot is not a member of this LINE group.",
      );
    const { token } = await lineCredentials();
    if (!token)
      throw new Fault("LINE_CONFIG", "Configure LINE credentials first.");
    const info = z
      .object({ groupName: z.string().min(1) })
      .parse(
        await (
          await line(
            "group/" + encodeURIComponent(g.lineGroupId) + "/summary",
            token,
          )
        ).json(),
      );
    const displayName = info.groupName
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 500);
    if (!displayName)
      throw new Fault("LINE_SUMMARY", "LINE did not return a group name.");
    await db.lineGroup.update({
      where: { id: g.id },
      data: { displayName },
    });
    let albumUpdated = false,
      albumError: string | undefined;
    if (g.googleAlbumId) {
      const conn = await db.googleConnection.findUnique({ where: { id: 1 } });
      if (
        conn?.status === "CONNECTED" &&
        conn.scopes.split(" ").includes(google.editScope)
      ) {
        try {
          await google.renameAlbum(
            g.googleAlbumId,
            google.title(displayName, g.lineGroupId),
            await access(),
          );
          albumUpdated = true;
        } catch (e) {
          albumError =
            e instanceof Fault
              ? e.message
              : "Could not update Google Photos album title.";
        }
      } else if (conn?.status === "CONNECTED") {
        albumError =
          "Reconnect Google Photos in Settings to sync the album title.";
      } else {
        albumError =
          "Connect Google Photos in Settings to sync the album title.";
      }
    }
    await audit(
      albumUpdated
        ? "Group and Google album name refreshed"
        : "Group name refreshed",
      "group",
      g.id,
    );
    return { ok: true, displayName, albumUpdated, albumError };
  });
  for (const route of ["/images", "/jobs"])
    a.get(route, async (q) => {
      const f = filters.parse(q.query);
      const start = (s: string) => new Date(s + "T00:00:00+07:00");
      const where = {
        lineGroupId: f.group,
        uploadStatus:
          f.status ??
          (route === "/jobs" ? { not: "SYNCED" as const } : undefined),
        lineEventTimestamp: {
          gte: f.from ? start(f.from) : undefined,
          lt: f.to ? new Date(+start(f.to) + 86400000) : undefined,
        },
      };
      const [items, total] = await db.$transaction([
        db.image.findMany({
          where,
          include: { group: { select: { displayName: true } } },
          omit: { thumbnailPath: true },
          orderBy: [{ lineEventTimestamp: "desc" }, { id: "asc" }],
          skip: (f.page - 1) * 36,
          take: 36,
        }),
        db.image.count({ where }),
      ]);
      return {
        items: items.map(({ stagingPath, ...i }) => ({
          ...i,
          hasStaging: !!stagingPath,
        })),
        total,
        page: f.page,
      };
    });
  a.get("/images/:id", async (q) =>
    db.image.findUniqueOrThrow({
      where: { id: id(q) },
      omit: { stagingPath: true, thumbnailPath: true },
      include: { attempts: { orderBy: { attemptNumber: "desc" }, take: 20 } },
    }),
  );
  for (const kind of ["thumbnail", "content"])
    a.get("/images/:id/" + kind, async (q, r) => {
      const i = await db.image.findUniqueOrThrow({ where: { id: id(q) } });
      const size =
        z.object({ size: z.enum(["320", "640"]).default("320") }).parse(q.query)
          .size === "320"
          ? 320
          : 640;
      const thumb = kind === "thumbnail";
      const path = pathFor(i.id, thumb ? size : undefined);
      const info = (thumb || i.stagingPath)
        ? await stat(path).catch(() => null)
        : null;
      if (info) {
        if (thumb) await touch(path);
        const contentType = thumb
          ? "image/webp"
          : (i.mimeType ?? "application/octet-stream");
        if (!thumb && i.mediaType === "VIDEO" && q.headers.range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(q.headers.range);
          if (m) {
            const start = m[1] ? Number(m[1]) : 0;
            const end = m[2]
              ? Math.min(Number(m[2]), info.size - 1)
              : info.size - 1;
            if (start <= end && end < info.size) {
              return r
                .code(206)
                .header("Accept-Ranges", "bytes")
                .header(
                  "Content-Range",
                  `bytes ${start}-${end}/${info.size}`,
                )
                .header("Content-Length", end - start + 1)
                .type(contentType)
                .send(createReadStream(path, { start, end }));
            }
          }
        }
        return r
          .header("Accept-Ranges", !thumb && i.mediaType === "VIDEO" ? "bytes" : "none")
          .header("Content-Length", info.size)
          .type(contentType)
          .send(createReadStream(path));
      }
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
      if (!i.googleMediaItemId)
        return r.code(404).send({ error: "Image not available yet." });
      const t = await access(),
        m = await google.item(i.googleMediaItemId, t);
      if (
        !m.baseUrl ||
        new URL(m.baseUrl).protocol !== "https:" ||
        !new URL(m.baseUrl).hostname.endsWith(".googleusercontent.com")
      )
        throw new Fault("GOOGLE_MEDIA", "Invalid remote media URL.");
      const suffix = thumb ? "=w" + size + "-h" + size : i.mediaType === "VIDEO" ? "=dv" : "=d";
      const rangeHeader =
        !thumb &&
        i.mediaType === "VIDEO" &&
        typeof q.headers.range === "string" &&
        /^bytes=\d*-\d*$/.test(q.headers.range)
          ? q.headers.range
          : undefined;
      const remote = await fetch(m.baseUrl + suffix, {
        headers: {
          Authorization: "Bearer " + t,
          ...(rangeHeader ? { Range: rangeHeader } : {}),
        },
        signal: AbortSignal.timeout(i.mediaType === "VIDEO" && !thumb ? 300000 : 60000),
        redirect: "error",
      });
      if (!remote.ok || !remote.body)
        throw new Fault("GOOGLE_MEDIA", "Google media is unavailable.", true);
      const mime = (remote.headers.get("content-type") ?? "")
        .split(";")[0]
        .toLowerCase();
      if (
        ![
          "image/jpeg",
          "image/webp",
          "image/png",
          "image/gif",
          "image/avif",
          "video/mp4",
          "video/quicktime",
          "video/webm",
          "application/octet-stream",
        ].includes(mime)
      ) {
        await remote.body.cancel();
        throw new Fault("GOOGLE_MEDIA", "Unexpected content type from Google.");
      }
      if (thumb) {
        const buf = Buffer.from(await remote.arrayBuffer());
        try {
          const cachedPath = await cacheThumbnail(i.id, size, buf);
          return r.type("image/webp").send(createReadStream(cachedPath));
        } catch {
          return r
            .type(
              mime === "application/octet-stream"
                ? (i.mimeType ?? "image/jpeg")
                : mime,
            )
            .send(buf);
        }
      }
      if (remote.status === 206) r.code(206);
      const contentRange = remote.headers.get("content-range");
      if (contentRange) r.header("Content-Range", contentRange);
      const acceptRanges = remote.headers.get("accept-ranges");
      if (acceptRanges || i.mediaType === "VIDEO")
        r.header("Accept-Ranges", acceptRanges ?? "bytes");
      const contentLength = remote.headers.get("content-length");
      if (contentLength && /^\d+$/.test(contentLength))
        r.header("Content-Length", Number(contentLength));
      return r
        .type(
          mime === "application/octet-stream"
            ? (i.mimeType ?? "image/jpeg")
            : mime,
        )
        .send(
          Readable.fromWeb(
            remote.body as Parameters<typeof Readable.fromWeb>[0],
          ),
        );
    });
  a.post("/jobs/:id/discard", async (q) => {
    const imageId = id(q);
    z.object({ confirmation: z.literal("Discard staged original") }).parse(
      q.body,
    );
    const i = await db.image.findUniqueOrThrow({ where: { id: imageId } });
    const policy = settings(await prefs());
    if (
      !i.stagingPath ||
      !["FAILED", "NEEDS_REVIEW", "UNRECOVERABLE"].includes(i.uploadStatus) ||
      +i.createdAt + policy.failedDays * 86400000 > Date.now()
    )
      throw new Fault(
        "RETENTION",
        "Only expired, stopped uploads can be discarded.",
      );
    const next =
      i.uploadStatus === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : "UNRECOVERABLE";
    if (i.uploadStatus !== next) transition(i.uploadStatus, next);
    await db.$transaction([
      db.image.update({
        where: {
          id: imageId,
          uploadStatus: i.uploadStatus,
          stagingPath: i.stagingPath,
        },
        data: {
          uploadStatus: next,
          stagingPath: null,
          lastError: "Owner discarded the expired staged original.",
        },
      }),
      db.outboxEvent.create({
        data: { eventType: "DISCARD", aggregateId: imageId },
      }),
      audit("Discard of expired staged original authorized", "image", imageId),
    ]);
    return { ok: true };
  });
  a.post("/jobs/:id/retry", async (q) => {
    const i = await db.image.findUniqueOrThrow({ where: { id: id(q) } });
    if (!["FAILED", "NEEDS_REVIEW"].includes(i.uploadStatus))
      throw new Fault(
        "NOT_RETRYABLE",
        "Only failed or uncertain jobs can be retried.",
      );
    if (i.uploadStatus === "FAILED") transition("FAILED", "RETRY_PENDING");
    await db.$transaction([
      db.image.update({
        where: { id: i.id, uploadStatus: i.uploadStatus },
        data: {
          uploadStatus:
            i.uploadStatus === "FAILED" ? "RETRY_PENDING" : "NEEDS_REVIEW",
        },
      }),
      db.outboxEvent.create({
        data: {
          eventType: i.uploadStatus === "FAILED" ? "PROCESS" : "RECONCILE",
          aggregateId: i.id,
        },
      }),
      audit("Retry requested", "image", i.id),
    ]);
    return { ok: true };
  });
  a.get("/dashboard/stats", async () => {
    const s = settings(await prefs());
    const [
      total,
      synced,
      failed,
      pending,
      groups,
      stagingBytes,
      thumbnailBytes,
      freeBytes,
      diskPressure,
      oldest,
      warnings,
      recent,
      connection,
    ] = await Promise.all([
      db.image.count(),
      db.image.count({ where: { uploadStatus: "SYNCED" } }),
      db.image.count({
        where: {
          uploadStatus: { in: ["FAILED", "NEEDS_REVIEW", "UNRECOVERABLE"] },
        },
      }),
      db.image.count({ where: { uploadStatus: { notIn: terminal } } }),
      db.lineGroup.count({ where: { enabled: true } }),
      usage(dirs[0]),
      usage(dirs[1]),
      free(),
      pressured(s.collectVideos),
      db.image.findFirst({
        where: { uploadStatus: { not: "SYNCED" } },
        select: { createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      db.image.count({
        where: {
          uploadStatus: { not: "SYNCED" },
          stagingPath: { not: null },
          createdAt: {
            lte: new Date(Date.now() - (s.failedDays - 1) * 86400000),
          },
        },
      }),
      db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
      googleStatus(),
    ]);
    return {
      total,
      synced,
      failed,
      pending,
      groups,
      stagingBytes,
      thumbnailBytes,
      freeBytes,
      diskPressure,
      oldest: oldest?.createdAt,
      warnings,
      recent,
      google: connection?.status ?? "DISCONNECTED",
    };
  });
}
