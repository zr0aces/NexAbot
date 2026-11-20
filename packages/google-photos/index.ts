import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { env } from "../shared/config";
import { request } from "../shared/http";
import { Fault } from "../shared/model";
export const editScope =
  "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata";
export const scopes = [
  "photoslibrary.appendonly",
  "photoslibrary.readonly.appcreateddata",
  "photoslibrary.edit.appcreateddata",
].map((s) => "https://www.googleapis.com/auth/" + s);
export function consent(state: string) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    throw new Fault(
      "GOOGLE_CONFIG",
      "Configure the Google OAuth client first.",
    );
  return (
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      response_type: "code",
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      scope: scopes.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
    })
  );
}
export async function token(fields: Record<string, string>) {
  const r = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      ...fields,
    }),
  });
  return z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().optional(),
      scope: z.string().optional(),
    })
    .parse(await r.json());
}
export const refresh = (t: string) =>
  token({ grant_type: "refresh_token", refresh_token: t });
const root = "https://photoslibrary.googleapis.com/v1/";
async function api(
  path: string,
  access: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  return (
    await request(root + path, {
      method,
      headers: {
        Authorization: "Bearer " + access,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  ).json();
}
export function title(name: string | null, id: string) {
  return Array.from(
    "LINE - " +
      (name?.replace(/[\u0000-\u001f\u007f]/g, " ").trim() ||
        "Group " + id.slice(-8)),
  )
    .slice(0, 500)
    .join("");
}
export const album = async (id: string, t: string) =>
  z
    .object({ id: z.string(), mediaItemsCount: z.coerce.number().default(0) })
    .parse(await api("albums/" + encodeURIComponent(id), t));
export const createAlbum = async (name: string, t: string) =>
  z
    .object({ id: z.string().min(1) })
    .parse(await api("albums", t, { album: { title: name } })).id;
export const renameAlbum = async (id: string, name: string, t: string) =>
  z
    .object({ id: z.string().min(1) })
    .parse(
      await api(
        "albums/" + encodeURIComponent(id) + "?updateMask=title",
        t,
        { title: name },
        "PATCH",
      ),
    ).id;
export const media = z.object({
  id: z.string().min(1),
  baseUrl: z.url().optional(),
  productUrl: z.url().optional(),
  filename: z.string().optional(),
});
export const item = async (id: string, t: string) =>
  media.parse(await api("mediaItems/" + encodeURIComponent(id), t));
export async function bytes(path: string, mime: string, t: string) {
  const r = await request(
    root + "uploads",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + t,
        "Content-type": "application/octet-stream",
        "Content-Length": String((await stat(path)).size),
        "X-Goog-Upload-Content-Type": mime,
        "X-Goog-Upload-Protocol": "raw",
      },
      body: createReadStream(path),
      duplex: "half",
    } as unknown as RequestInit,
    "GOOGLE",
    600000,
  );
  const result = (await r.text()).trim();
  if (!result) throw new Fault("GOOGLE_UPLOAD", "Missing upload token.", true);
  return result;
}
export async function createMedia(
  albumId: string,
  uploadToken: string,
  fileName: string,
  t: string,
) {
  const data = await api("mediaItems:batchCreate", t, {
    albumId,
    newMediaItems: [{ simpleMediaItem: { uploadToken, fileName } }],
  });
  const result = data.newMediaItemResults?.[0];
  if (result?.status?.code) {
    const msg = String(result.status.message);
    const code = Number(result.status.code);
    if ([2, 4, 13, 14].includes(code))
      throw new Fault(
        "MEDIA_UNCERTAIN",
        "Google could not confirm the media creation result.",
      );
    if (/album.*(limit|full)|20,?000/i.test(msg))
      throw new Fault("ALBUM_CAPACITY", "Album capacity reached.");
    if (/storage/i.test(msg))
      throw new Fault("GOOGLE_STORAGE", "Google account storage exhausted.");
    throw new Fault(
      "GOOGLE_ITEM_" + code,
      "Google rejected the media item (status " + code + ").",
      code === 8,
    );
  }
  return media.parse(result?.mediaItem);
}
export async function reconcile(albumId: string, filename: string, t: string) {
  let pageToken: string | undefined, match: z.infer<typeof media> | undefined;
  do {
    const page = await api("mediaItems:search", t, {
      albumId,
      pageSize: 100,
      pageToken,
    });
    for (const m of page.mediaItems ?? []) {
      if (m.filename === filename) {
        if (match) return;
        match = media.parse(m);
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return match;
}
export async function validate(t: string) {
  await api("albums?pageSize=1", t);
}
