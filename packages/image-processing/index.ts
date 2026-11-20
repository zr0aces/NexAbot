import {
  mkdir,
  statfs,
  readdir,
  stat,
  rename,
  rm,
  utimes,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { env } from "../shared/config";
import { Fault } from "../shared/model";

const runFile = promisify(execFile);

export const dirs = [env.STAGING_PATH, env.THUMBNAIL_PATH];
export const initDirs = () =>
  Promise.all(dirs.map((d) => mkdir(d, { recursive: true, mode: 0o700 })));
export function pathFor(id: string, size?: 320 | 640) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error("Invalid image ID");
  return join(
    dirs[size ? 1 : 0],
    id + (size ? "." + size + ".webp" : ".image"),
  );
}
export async function free() {
  const s = await statfs(dirs[0]);
  return s.bavail * s.bsize;
}
export const pressured = async (reserveVideo = false) =>
  (await free()) <
  (env.MIN_FREE_MB +
    (reserveVideo
      ? Math.max(env.MAX_IMAGE_SIZE_MB, env.MAX_VIDEO_SIZE_MB)
      : env.MAX_IMAGE_SIZE_MB)) *
    1048576;
const usageCache = new Map<string, { bytes: number; expiresAt: number }>();
export const clearUsageCache = () => usageCache.clear();
export async function usage(d: string) {
  const now = Date.now();
  const cached = usageCache.get(d);
  if (cached && cached.expiresAt > now) return cached.bytes;
  const files = await readdir(d);
  const sizes = await Promise.all(
    files.map(async (f) => (await stat(join(d, f)).catch(() => null))?.size ?? 0),
  );
  const bytes = sizes.reduce((sum, s) => sum + s, 0);
  usageCache.set(d, { bytes, expiresAt: now + 10000 });
  return bytes;
}
export async function digest(path: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
export async function inspect(path: string) {
  let m;
  try {
    m = await sharp(path, { limitInputPixels: 100000000 }).metadata();
  } catch {
    throw new Fault("UNSUPPORTED_IMAGE", "Invalid or oversized image.");
  }
  const mime = (
    {
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
    } as Record<string, string>
  )[m.format ?? ""];
  if (!mime || !m.width || !m.height)
    throw new Fault("UNSUPPORTED_IMAGE", "Unsupported image format.");
  return {
    mimeType: mime,
    width: m.width,
    height: m.height,
    durationMs: null as number | null,
    fileSize: (await stat(path)).size,
    sha256: await digest(path),
  };
}
export async function inspectVideo(path: string) {
  let parsed: {
    streams?: { width?: number; height?: number }[];
    format?: { format_name?: string; duration?: string };
  };
  try {
    const { stdout: out } = await runFile(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=format_name,duration",
        "-of",
        "json",
        path,
      ],
      { timeout: 30000 },
    );
    parsed = JSON.parse(out);
  } catch {
    throw new Fault("UNSUPPORTED_VIDEO", "Invalid or unreadable video.");
  }
  const s = parsed.streams?.[0];
  const fmt = parsed.format?.format_name ?? "";
  const mime = fmt.includes("webm")
    ? "video/webm"
    : fmt.includes("mp4") || fmt.includes("mov") || fmt.includes("m4a")
      ? "video/mp4"
      : "";
  if (!mime || !s?.width || !s?.height)
    throw new Fault("UNSUPPORTED_VIDEO", "Unsupported video format.");
  const durSec = Number(parsed.format?.duration ?? 0);
  return {
    mimeType: mime,
    width: s.width,
    height: s.height,
    durationMs: Number.isFinite(durSec) && durSec > 0 ? Math.round(durSec * 1000) : null,
    fileSize: (await stat(path)).size,
    sha256: await digest(path),
  };
}
export async function thumbnail(
  id: string,
  size: 320 | 640,
  mediaType: "IMAGE" | "VIDEO" = "IMAGE",
) {
  const target = pathFor(id, size),
    tmp = target + "." + randomUUID() + ".part",
    poster = mediaType === "VIDEO" ? target + "." + randomUUID() + ".png" : null;
  try {
    let source = pathFor(id);
    if (poster) {
      try {
        await runFile(
          "ffmpeg",
          [
            "-y",
            "-ss",
            "00:00:01",
            "-i",
            source,
            "-frames:v",
            "1",
            "-f",
            "image2",
            poster,
          ],
          { timeout: 30000 },
        );
      } catch {
        await runFile(
          "ffmpeg",
          ["-y", "-i", source, "-frames:v", "1", "-f", "image2", poster],
          { timeout: 30000 },
        );
      }
      source = poster;
    }
    await sharp(source, { limitInputPixels: 100000000 })
      .rotate()
      .resize({
        width: size,
        height: size,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp()
      .toFile(tmp);
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true });
    if (poster) await rm(poster, { force: true });
  }
  return target;
}
export async function stage(
  id: string,
  response: Response,
  mediaType: "IMAGE" | "VIDEO" = "IMAGE",
) {
  if (!response.body)
    throw new Fault("LINE_DOWNLOAD", "Empty LINE response.", true);
  const path = pathFor(id),
    tmp = path + "." + randomUUID() + ".part",
    maxMB = mediaType === "VIDEO" ? env.MAX_VIDEO_SIZE_MB : env.MAX_IMAGE_SIZE_MB;
  let n = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      new Transform({
        transform(chunk, _, cb) {
          n += chunk.length;
          cb(
            n > maxMB * 1048576
              ? new Fault("FILE_SIZE", "LINE media exceeds size limit.")
              : null,
            chunk,
          );
        },
      }),
      createWriteStream(tmp, { flags: "wx", mode: 0o600 }),
    );
    const info =
      mediaType === "VIDEO" ? await inspectVideo(tmp) : await inspect(tmp);
    await rename(tmp, path);
    return { ...info, stagingPath: path };
  } finally {
    await rm(tmp, { force: true });
  }
}
export async function cacheThumbnail(
  id: string,
  size: 320 | 640,
  input: Buffer,
) {
  const target = pathFor(id, size),
    tmp = target + "." + randomUUID() + ".part";
  try {
    await sharp(input, { limitInputPixels: 100000000 })
      .rotate()
      .resize({
        width: size,
        height: size,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp()
      .toFile(tmp);
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
  return target;
}
export async function touch(path: string) {
  const now = new Date();
  await utimes(path, now, now);
}
