import { useQuery } from "@tanstack/react-query";
import type { State } from "../../../packages/shared/model";
export const base = "/api/v1";
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const r = await fetch(base + path, {
    method,
    headers: {
      "X-Gallery-Request": "1",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) {
    if (r.status === 401 && !path.startsWith("/auth/"))
      window.location.assign("/");
    throw Error(data.error ?? "Request failed.");
  }
  return data;
}
export const query = <T>(p: string) =>
  useQuery<T>({
    queryKey: [p],
    queryFn: () => api<T>(p),
    refetchInterval: 15000,
  });
export interface Photo {
  id: string;
  hasStaging: boolean;
  createdAt: string;
  lineGroupId: string;
  lineEventTimestamp: string;
  group: { displayName: string | null };
  uploadStatus: State;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  mimeType: string | null;
  sha256: string | null;
  productUrl: string | null;
  lastError: string | null;
  errorCode: string | null;
}
export interface Group {
  id: string;
  lineGroupId: string;
  displayName: string | null;
  enabled: boolean;
  membershipStatus: string;
  googleAlbumId: string | null;
  albumCreating: boolean;
  lastEventAt: string;
  _count: { images: number };
  images: Pick<Photo, "id" | "uploadStatus" | "lineEventTimestamp">[];
}
export interface Stats {
  total: number;
  synced: number;
  failed: number;
  pending: number;
  groups: number;
  google: string;
  stagingBytes: number;
  thumbnailBytes: number;
  freeBytes: number;
  diskPressure: boolean;
  oldest?: string;
  warnings: number;
  recent: { id: string; action: string; createdAt: string }[];
}
export interface Settings {
  stagingHours: number;
  failedDays: number;
  thumbnailDays: number;
  lineConfigured: boolean;
  webhook: string;
  maxImageMB: number;
}
export { date, bytes, name, labels } from "./i18n";
