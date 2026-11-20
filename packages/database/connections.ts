import { db } from "./index";
import { open } from "../shared/crypto";
import { env } from "../shared/config";
import { Fault } from "../shared/model";
import { refresh } from "../google-photos";

let cachedAccess: {
  token: string;
  encryptedRefreshToken: string;
  expiresAt: number;
} | null = null;
let inflightAccess: {
  encryptedRefreshToken: string;
  promise: Promise<string>;
} | null = null;

export function clearAccessCache() {
  cachedAccess = null;
  inflightAccess = null;
}

export async function access(forceRefresh = false) {
  const c = await db.googleConnection.findUnique({ where: { id: 1 } });
  if (!c?.encryptedRefreshToken) {
    clearAccessCache();
    throw new Fault("GOOGLE_AUTH", "Connect Google Photos, then retry.");
  }
  const encrypted = c.encryptedRefreshToken;
  if (
    !forceRefresh &&
    cachedAccess &&
    cachedAccess.encryptedRefreshToken === encrypted &&
    cachedAccess.expiresAt > Date.now()
  ) {
    return cachedAccess.token;
  }
  if (
    !forceRefresh &&
    inflightAccess &&
    inflightAccess.encryptedRefreshToken === encrypted
  ) {
    return inflightAccess.promise;
  }
  const promise = (async () => {
    try {
      const token = (await refresh(open(encrypted))).access_token;
      cachedAccess = {
        token,
        encryptedRefreshToken: encrypted,
        expiresAt: Date.now() + 45 * 60000,
      };
      return token;
    } catch (e) {
      if (cachedAccess?.encryptedRefreshToken === encrypted) cachedAccess = null;
      if (e instanceof Fault)
        await db.googleConnection.updateMany({
          where: { id: 1, encryptedRefreshToken: encrypted },
          data: {
            lastError: e.message,
            status: e.transient ? "DEGRADED" : "REAUTHORIZE",
          },
        });
      throw e;
    } finally {
      if (inflightAccess?.encryptedRefreshToken === encrypted)
        inflightAccess = null;
    }
  })();
  inflightAccess = { encryptedRefreshToken: encrypted, promise };
  return promise;
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
