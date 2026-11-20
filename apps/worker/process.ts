import { rm, stat } from "node:fs/promises";
import { db } from "../../packages/database";
import { access, lineCredentials } from "../../packages/database/connections";
import * as google from "../../packages/google-photos";
import { download, line } from "../../packages/line-client";
import {
  stage,
  inspect,
  inspectVideo,
  thumbnail,
  pathFor,
  pressured,
} from "../../packages/image-processing";
import {
  Fault,
  terminal,
  transition,
  backoff,
  type State,
} from "../../packages/shared/model";
import type { Prisma, Image, LineGroup } from "@prisma/client";
export async function resolveAlbum(g: LineGroup, t: string) {
  if (g.googleAlbumId) return g.googleAlbumId;
  const won = await db.lineGroup.updateMany({
    where: { id: g.id, albumCreating: false, googleAlbumId: null },
    data: { albumCreating: true },
  });
  if (!won.count) {
    const fresh = await db.lineGroup.findUniqueOrThrow({ where: { id: g.id } });
    if (fresh.googleAlbumId) return fresh.googleAlbumId;
    throw new Fault(
      "ALBUM_REVIEW",
      "Unconfirmed album creation. Check Google Photos before repairing the mapping.",
    );
  }
  let albumId: string;
  try {
    albumId = await google.createAlbum(
      google.title(g.displayName, g.lineGroupId),
      t,
    );
  } catch (e) {
    if (
      (e instanceof Fault && !e.transient) ||
      (e instanceof Fault && e.code === "GOOGLE_RATE_LIMIT")
    ) {
      await db.lineGroup.update({
        where: { id: g.id },
        data: { albumCreating: false },
      });
      throw e;
    }
    throw new Fault(
      "ALBUM_REVIEW",
      "Album creation was not confirmed. Check the mapping before retrying.",
    );
  }
  await db.lineGroup.update({
    where: { id: g.id },
    data: { googleAlbumId: albumId, albumCreating: false },
  });
  return albumId;
}
export const filename = (i: Image) => {
  const sub = i.mimeType?.split("/")[1];
  const ext = sub === "quicktime" ? "mov" : (sub ?? (i.mediaType === "VIDEO" ? "mp4" : "jpg"));
  return "line-" + i.id + "." + ext;
};
export async function processEvent(outboxId: string) {
  const evt = await db.outboxEvent.findUnique({ where: { id: outboxId } });
  if (!evt) return;
  if (evt.eventType === "DISCARD") {
    const row = await db.image.findUniqueOrThrow({
      where: { id: evt.aggregateId },
    });
    if (!row.stagingPath) await rm(pathFor(row.id), { force: true });
    await db.outboxEvent.deleteMany({ where: { id: evt.id } });
    return;
  }
  if (evt.eventType === "GROUP_SUMMARY") {
    try {
      const info = await (
        await line(
          "group/" + encodeURIComponent(evt.aggregateId) + "/summary",
          (await lineCredentials()).token,
        )
      ).json();
      if (typeof info.groupName === "string")
        await db.lineGroup.updateMany({
          where: { lineGroupId: evt.aggregateId },
          data: { displayName: info.groupName.slice(0, 500) },
        });
    } catch {
      /* A group name is optional; the upload path also attempts lookup. */
    }
    await db.outboxEvent.deleteMany({ where: { id: evt.id } });
    return;
  }
  let i = await db.image.findUniqueOrThrow({ where: { id: evt.aggregateId } });
  const id = i.id;
  const done = () => db.outboxEvent.deleteMany({ where: { id: outboxId } });
  if (
    terminal.includes(i.uploadStatus) &&
    !(evt.eventType === "RECONCILE" && i.uploadStatus === "NEEDS_REVIEW")
  ) {
    await done();
    return;
  }
  const lookupOnly =
    i.uploadStatus === "CREATING_MEDIA" || i.uploadStatus === "NEEDS_REVIEW";
  const n = (await db.uploadAttempt.count({ where: { imageId: id } })) + 1;
  const a = await db.uploadAttempt.create({
    data: { imageId: id, attemptNumber: n, status: "ACTIVE" },
  });
  const move = async (
    next: State,
    data: Prisma.ImageUncheckedUpdateInput = {},
  ) => {
    transition(
      i.uploadStatus,
      next,
      typeof data.googleMediaItemId === "string"
        ? data.googleMediaItemId
        : null,
    );
    i = await db.image.update({
      where: { id, uploadStatus: i.uploadStatus },
      data: { ...data, uploadStatus: next },
    });
  };
  const sync = async (m: { id: string; productUrl?: string }) =>
    move("SYNCED", {
      googleMediaItemId: m.id,
      productUrl: m.productUrl,
      uploadedAt: new Date(),
      lastError: null,
      errorCode: null,
    });
  try {
    let g = await db.lineGroup.findUniqueOrThrow({
      where: { lineGroupId: i.lineGroupId },
    });
    if (
      i.uploadStatus === "CREATING_MEDIA" ||
      i.uploadStatus === "NEEDS_REVIEW"
    ) {
      const m =
        g.googleAlbumId &&
        (await google.reconcile(g.googleAlbumId, filename(i), await access()));
      if (!m)
        throw new Fault(
          "MEDIA_UNCERTAIN",
          "No unique filename match. Inspect the destination album; retry performs lookup only.",
        );
      await sync(m);
    } else {
      if (i.uploadStatus === "RECEIVED" || i.uploadStatus === "RETRY_PENDING")
        await move(i.stagingPath ? "UPLOAD_PENDING" : "DOWNLOAD_PENDING");
      if (i.uploadStatus === "DOWNLOAD_PENDING") await move("DOWNLOADING");
      if (i.uploadStatus === "DOWNLOADING") {
        const path = pathFor(id);
        // The atomic rename can survive a crash before STAGED commits. Never
        // fetch expiring LINE content again when its validated file is present.
        let staged;
        const exists = await stat(path).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return null;
          throw e;
        });
        const mediaKind = i.mediaType === "VIDEO" ? "VIDEO" : "IMAGE";
        if (exists) {
          staged = {
            ...(mediaKind === "VIDEO"
              ? await inspectVideo(path)
              : await inspect(path)),
            stagingPath: path,
          };
        } else {
          if (await pressured(mediaKind === "VIDEO"))
            throw new Fault(
              "DISK_PRESSURE",
              "Free staging disk space.",
              true,
              60000,
            );
          staged = await stage(
            id,
            await download(i.lineMessageId, (await lineCredentials()).token),
            mediaKind,
          );
        }
        await move("STAGED", staged);
        await db.$transaction([
          db.uploadAttempt.update({
            where: { id: a.id },
            data: { status: "STAGED", completedAt: new Date() },
          }),
          db.outboxEvent.create({
            data: { eventType: "UPLOAD", aggregateId: id },
          }),
          done(),
        ]);
        return;
      }
      if (
        i.uploadStatus === "STAGED" ||
        i.uploadStatus === "UPLOAD_PENDING" ||
        i.uploadStatus === "UPLOADING"
      ) {
        const mediaKind = i.mediaType === "VIDEO" ? "VIDEO" : "IMAGE";
        if (!i.thumbnailPath) {
          for (const size of [320, 640] as const)
            await thumbnail(id, size, mediaKind);
          i = await db.image.update({
            where: { id },
            data: { thumbnailPath: pathFor(id, 320) },
          });
        }
        if (i.uploadStatus === "STAGED") await move("UPLOAD_PENDING");
        if (i.uploadStatus === "UPLOAD_PENDING") await move("UPLOADING");
        const path = pathFor(id),
          info =
            mediaKind === "VIDEO"
              ? await inspectVideo(path)
              : await inspect(path);
        if (info.sha256 !== i.sha256 || info.mimeType !== i.mimeType)
          throw new Fault(
            "INTEGRITY",
            "Staged bytes changed; inspect storage.",
          );
        if (!g.displayName) {
          try {
            const summary = await (
              await line(
                "group/" + encodeURIComponent(g.lineGroupId) + "/summary",
                (await lineCredentials()).token,
              )
            ).json();
            if (typeof summary.groupName === "string")
              g = await db.lineGroup.update({
                where: { id: g.id },
                data: { displayName: summary.groupName.slice(0, 500) },
              });
          } catch {
            /* name is optional */
          }
        }
        const t = await access(),
          albumId = await resolveAlbum(g, t);
        if ((await google.album(albumId, t)).mediaItemsCount >= 20000)
          throw new Fault(
            "ALBUM_CAPACITY",
            "Album is full. Free album slots or approve a different strategy.",
          );
        const upload = await google.bytes(path, info.mimeType, t);
        await move("CREATING_MEDIA");
        try {
          const m = await google.createMedia(albumId, upload, filename(i), t);
          await sync(m);
        } catch (e) {
          if (
            e instanceof Fault &&
            (e.code.startsWith("GOOGLE_ITEM_") ||
              [
                "ALBUM_CAPACITY",
                "GOOGLE_STORAGE",
                "GOOGLE_RATE_LIMIT",
                "GOOGLE_AUTH",
                "GOOGLE_400",
              ].includes(e.code))
          )
            throw e;
          const m = await google
            .reconcile(albumId, filename(i), t)
            .catch(() => undefined);
          if (!m)
            throw new Fault(
              "MEDIA_UNCERTAIN",
              "Creation not confirmed. Retry only reconciles the album.",
            );
          await sync(m);
        }
      }
    }
    await db.$transaction([
      db.uploadAttempt.update({
        where: { id: a.id },
        data: { status: "SYNCED", completedAt: new Date() },
      }),
      db.auditLog.create({
        data: { action: "Photo synced", targetType: "image", targetId: id },
      }),
      done(),
    ]);
  } catch (e) {
    const f =
      e instanceof Fault
        ? e
        : new Fault(
            "PROCESSING",
            "Processing interrupted. Check storage and provider availability.",
            true,
          );
    const uncertain =
      lookupOnly ||
      (["NEEDS_REVIEW", "CREATING_MEDIA"].includes(i.uploadStatus) &&
        !/^(GOOGLE_ITEM_|ALBUM_CAPACITY|GOOGLE_STORAGE|GOOGLE_RATE_LIMIT|GOOGLE_AUTH|GOOGLE_400)/.test(
          f.code,
        )) ||
      i.uploadStatus === "NEEDS_REVIEW";
    const next = uncertain
      ? "NEEDS_REVIEW"
      : f.transient && n < 8
        ? "RETRY_PENDING"
        : ["LINE_404", "LINE_410", "UNSUPPORTED_IMAGE", "FILE_SIZE"].includes(
              f.code,
            )
          ? "UNRECOVERABLE"
          : "FAILED";
    if (i.uploadStatus === "SYNCED") throw e;
    if (i.uploadStatus !== next) transition(i.uploadStatus, next);
    await db.$transaction([
      db.image.update({
        where: { id, uploadStatus: i.uploadStatus },
        data: { uploadStatus: next, lastError: f.message, errorCode: f.code },
      }),
      db.uploadAttempt.update({
        where: { id: a.id },
        data: {
          status: next,
          errorCode: f.code,
          errorMessage: f.message,
          completedAt: new Date(),
        },
      }),
      ...(next === "RETRY_PENDING"
        ? [
            db.outboxEvent.create({
              data: {
                eventType: "PROCESS",
                aggregateId: id,
                availableAt: new Date(Date.now() + backoff(n, f.delay)),
              },
            }),
          ]
        : []),
      done(),
    ]);
  }
}
