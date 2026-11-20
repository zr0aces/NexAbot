import { describe } from "./openapi";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { z } from "zod";
import { db } from "../../packages/database";
import { env } from "../../packages/shared/config";
import { equal } from "../../packages/shared/crypto";
import { Fault } from "../../packages/shared/model";
import { signed } from "../../packages/line-client";
import { lineCredentials } from "../../packages/database/connections";
import { ingest } from "./ingest";
import { routes } from "./routes";
import { initDirs } from "../../packages/image-processing";
export async function build() {
  await initDirs();
  const app = Fastify({
    logger: { redact: ["req.headers", "res.headers", "password", "token"] },
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  await app.register(swagger, {
    transform: describe,
    openapi: {
      info: { title: "NexAbot", version: "1.0.0" },
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "session" },
        },
      },
    },
  });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(helmet);
  function sid(req: FastifyRequest) {
    const value = req.cookies.session;
    return value ? req.unsignCookie(value).value : null;
  }
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const url = req.url.split("?")[0];
      if (url === "/api/webhooks/line")
        return "webhook:" + String(req.headers["x-line-signature"] ?? req.ip);
      const id = sid(req);
      return id ? "session:" + id : "ip:" + req.ip;
    },
  });
  app.setErrorHandler(
    (e: Error & { statusCode?: number; code?: string }, req, r) => {
      const status =
        e instanceof z.ZodError
          ? 400
          : e instanceof SyntaxError
            ? 400
            : e instanceof Fault
              ? e.transient
                ? 503
                : 409
              : e.code === "P2025"
                ? 404
                : e.code === "P2002"
                  ? 409
                  : (e.statusCode ?? 500);
      if (status >= 500)
        app.log.error(
          { type: e.name, route: req.routeOptions.url },
          "Request failed",
        );
      r.code(status).send({
        error:
          e instanceof Fault
            ? e.message
            : status === 400
              ? "Invalid request. Check the submitted values."
              : status === 404
                ? "Not found."
                : status === 409
                  ? "State changed. Refresh and try again."
                  : status === 429
                    ? "Too many requests. Try again later."
                    : "Request failed.",
      });
    },
  );
  const attrs = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    signed: true,
    maxAge: 43200,
  };
  app.addHook("onRequest", async (req, r) => {
    r.header("Cache-Control", "no-store");
    const url = req.url.split("?")[0];
    if (url === "/api/webhooks/line" || url === "/ready") return;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (req.headers.origin !== env.APP_URL ||
        req.headers["x-gallery-request"] !== "1")
    )
      return r.code(403).send({ error: "Invalid request origin." });
    if (
      [
        "/api/v1/auth/status",
        "/api/v1/auth/login",
        "/api/v1/auth/setup",
      ].includes(url)
    )
      return;
    const id = sid(req);
    if (!id || !(await redis.exists("session:" + id)))
      return r.code(401).send({ error: "Sign in to continue." });
  });
  app.get("/ready", async () => {
    await db.$queryRaw`SELECT 1`;
    await redis.ping();
    return { ok: true };
  });
  app.get("/api/v1/auth/status", async (req) => ({
    setup: (await db.owner.count()) === 0,
    authenticated: !!(sid(req) && (await redis.exists("session:" + sid(req)))),
  }));
  for (const mode of ["setup", "login"])
    app.post(
      "/api/v1/auth/" + mode,
      { config: { rateLimit: { max: 8, timeWindow: "5 minutes" } } },
      async (req, r) => {
        const b = z
          .object({
            email: z
              .email()
              .max(254)
              .transform((v) => v.toLowerCase()),
            password: z
              .string()
              .min(mode === "setup" ? 12 : 1)
              .max(256),
            bootstrap: z.string().optional(),
          })
          .parse(req.body);
        if (mode === "setup") {
          if (
            !equal(b.bootstrap ?? "", env.BOOTSTRAP_SECRET) ||
            (await db.owner.count())
          )
            return r
              .code(403)
              .send({
                error: "Setup is locked or the setup key is incorrect.",
              });
          await db.owner.create({
            data: {
              email: b.email,
              passwordHash: await argon2.hash(b.password, {
                type: argon2.argon2id,
              }),
            },
          });
        } else {
          const owner = await db.owner.findUnique({ where: { id: 1 } });
          if (
            !owner ||
            !(await argon2.verify(owner.passwordHash, b.password)) ||
            owner.email !== b.email
          )
            return r
              .code(401)
              .send({ error: "Email or password is incorrect." });
        }
        const id = randomBytes(32).toString("hex");
        await redis.set("session:" + id, "1", "EX", 43200);
        r.setCookie("session", id, attrs);
        return { ok: true };
      },
    );
  app.post("/api/v1/auth/logout", async (req, r) => {
    await redis.del("session:" + sid(req));
    r.clearCookie("session", { path: "/" });
    return { ok: true };
  });
  await app.register(async (hook) => {
    hook.removeContentTypeParser("application/json");
    hook.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_q, b, done) => done(null, b),
    );
    hook.post("/api/webhooks/line", async (q, r) => {
      const credentials = await lineCredentials(),
        body = q.body as Buffer;
      if (!signed(body, q.headers["x-line-signature"], credentials.secret))
        return r.code(403).send({ error: "Invalid signature." });
      const payload = JSON.parse(body.toString());
      if (
        credentials.destination &&
        credentials.destination !== payload.destination
      )
        return r.code(403).send({ error: "Unexpected channel." });
      await ingest(payload);
      return {};
    });
  });
  await app.register(async (a) => routes(a, redis, sid), { prefix: "/api/v1" });
  app.get("/api/openapi.json", async () => app.swagger());
  app.addHook("onClose", async () => {
    await redis.quit();
  });
  return app;
}
