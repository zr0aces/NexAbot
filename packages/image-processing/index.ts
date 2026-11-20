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
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { env } from "../shared/config";
import { Fault } from "../shared/model";
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
export const pressured = async () =>
  (await free()) < (env.MIN_FREE_MB + env.MAX_IMAGE_SIZE_MB) * 1048576;
export async function usage(d: string) {
  let bytes = 0;
  for (const f of await readdir(d)) {
    bytes += (await stat(join(d, f)).catch(() => null))?.size ?? 0;
  }
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
    fileSize: (await stat(path)).size,
    sha256: await digest(path),
  };
}
export async function thumbnail(id: string, size: 320 | 640) {
  const target = pathFor(id, size),
    tmp = target + "." + randomUUID() + ".part";
  try {
    await sharp(pathFor(id), { limitInputPixels: 100000000 })
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
export async function stage(id: string, response: Response) {
  if (!response.body)
    throw new Fault("LINE_DOWNLOAD", "Empty LINE response.", true);
  const path = pathFor(id),
    tmp = path + "." + randomUUID() + ".part";
  let n = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      new Transform({
        transform(chunk, _, cb) {
          n += chunk.length;
          cb(
            n > env.MAX_IMAGE_SIZE_MB * 1048576
              ? new Fault("FILE_SIZE", "LINE image exceeds size limit.")
              : null,
            chunk,
          );
        },
      }),
      createWriteStream(tmp, { flags: "wx", mode: 0o600 }),
    );
    const info = await inspect(tmp);
    await rename(tmp, path);
    return { ...info, stagingPath: path };
  } finally {
    await rm(tmp, { force: true });
  }
}
export async function touch(path: string) {
  const now = new Date();
  await utimes(path, now, now);
}
