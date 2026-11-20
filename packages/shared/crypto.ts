import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { env } from "./config";
export function equal(a: string, b: string) {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}
export function seal(s: string) {
  const iv = randomBytes(12),
    c = createCipheriv(
      "aes-256-gcm",
      Buffer.from(env.TOKEN_ENCRYPTION_KEY, "hex"),
      iv,
    ),
    data = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}
export function open(s: string) {
  const [iv, tag, data] = s.split(".").map((x) => Buffer.from(x, "base64"));
  const d = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(env.TOKEN_ENCRYPTION_KEY, "hex"),
    iv,
  );
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}
