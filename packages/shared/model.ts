import { z } from "zod";
export const states = [
  "RECEIVED",
  "DOWNLOAD_PENDING",
  "DOWNLOADING",
  "STAGED",
  "UPLOAD_PENDING",
  "UPLOADING",
  "CREATING_MEDIA",
  "SYNCED",
  "RETRY_PENDING",
  "NEEDS_REVIEW",
  "FAILED",
  "UNRECOVERABLE",
] as const;
export type State = (typeof states)[number];
export const terminal: State[] = [
  "SYNCED",
  "NEEDS_REVIEW",
  "FAILED",
  "UNRECOVERABLE",
];
const edges: Partial<Record<State, State[]>> = {
  RECEIVED: ["DOWNLOAD_PENDING"],
  DOWNLOAD_PENDING: ["DOWNLOADING"],
  DOWNLOADING: ["STAGED"],
  STAGED: ["UPLOAD_PENDING"],
  UPLOAD_PENDING: ["UPLOADING"],
  UPLOADING: ["CREATING_MEDIA"],
  CREATING_MEDIA: ["SYNCED"],
  RETRY_PENDING: ["DOWNLOAD_PENDING", "UPLOAD_PENDING"],
  FAILED: ["RETRY_PENDING", "UNRECOVERABLE"],
  NEEDS_REVIEW: ["SYNCED"],
};
export function transition(a: State, b: State, id?: string | null) {
  if (
    !(
      edges[a]?.includes(b) ||
      (!terminal.includes(a) &&
        ["FAILED", "RETRY_PENDING", "UNRECOVERABLE", "NEEDS_REVIEW"].includes(
          b,
        ))
    ) ||
    (b === "SYNCED" && !id?.trim())
  )
    throw Error("Invalid transition " + a + " → " + b);
}
export const limits = z.object({
  stagingHours: z.number().int().min(1).max(720),
  failedDays: z.number().int().min(1).max(90),
  thumbnailDays: z.number().int().min(1).max(365),
  collectVideos: z.boolean().default(false),
});
export const filters = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  group: z.string().max(100).optional(),
  status: z.enum(states).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export class Fault extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient = false,
    readonly delay = 0,
  ) {
    super(message);
  }
}
export const backoff = (n: number, min = 0) =>
  Math.max(
    min,
    Math.floor(
      Math.min(3600000, 2000 * 2 ** Math.min(n, 12)) *
        (0.5 + Math.random() * 0.5),
    ),
  );
