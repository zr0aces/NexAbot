import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { request } from "../shared/http";
export function signed(body: Buffer, signature: unknown, secret: string) {
  if (typeof signature !== "string" || !secret) return false;
  const expected = createHmac("sha256", secret).update(body).digest("base64");
  return (
    signature.length === expected.length &&
    Buffer.byteLength(signature) === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
}
const event = z.object({
  type: z.string(),
  timestamp: z.number().int().nonnegative(),
  webhookEventId: z.string().min(1),
  source: z
    .object({
      type: z.string(),
      groupId: z.string().min(1).max(128).optional(),
    })
    .optional(),
  message: z
    .object({ type: z.string(), id: z.string().min(1).max(128) })
    .optional(),
});
export type Event = z.infer<typeof event>;
export const envelope = z.object({
  destination: z.string().min(1).max(128),
  events: z.array(event).max(1000),
});
export function relevant(e: Event) {
  return (
    e.source?.type === "group" &&
    !!e.source.groupId &&
    (e.type === "join" ||
      e.type === "leave" ||
      (e.type === "message" &&
        (e.message?.type === "image" || e.message?.type === "video")))
  );
}
export function line(
  path: string,
  token: string,
  data = false,
  timeoutMs = 90000,
) {
  return request(
    "https://" + (data ? "api-data" : "api") + ".line.me/v2/bot/" + path,
    { headers: { Authorization: "Bearer " + token } },
    "LINE",
    timeoutMs,
  );
}
export const download = (id: string, t: string) =>
  line("message/" + encodeURIComponent(id) + "/content", t, true, 600000);
