import { db } from "./index";
import { open } from "../shared/crypto";
import { env } from "../shared/config";
import { Fault } from "../shared/model";
import { refresh } from "../google-photos";
export async function access() {
  const c = await db.googleConnection.findUnique({ where: { id: 1 } });
  if (!c?.encryptedRefreshToken)
    throw new Fault("GOOGLE_AUTH", "Connect Google Photos, then retry.");
  try {
    return (await refresh(open(c.encryptedRefreshToken))).access_token;
  } catch (e) {
    if (e instanceof Fault)
      await db.googleConnection.updateMany({
        where: { id: 1, encryptedRefreshToken: c.encryptedRefreshToken },
        data: {
          lastError: e.message,
          status: e.transient ? "DEGRADED" : "REAUTHORIZE",
        },
      });
    throw e;
  }
}
export async function lineCredentials() {
  const owner = await db.owner.findUnique({
    where: { id: 1 },
    select: { settings: true },
  });
  const s = owner?.settings as Record<string, string> | null;
  return {
    token: s?.lineToken
      ? open(s.lineToken)
      : (env.LINE_CHANNEL_ACCESS_TOKEN ?? ""),
    secret: s?.lineSecret
      ? open(s.lineSecret)
      : (env.LINE_CHANNEL_SECRET ?? ""),
    destination: s?.destination,
  };
}
