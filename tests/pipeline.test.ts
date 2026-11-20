import { test, expect, vi } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import sharp from "sharp";
test.skipIf(!process.env["GALLERY_INTEGRATION"])(
  "owner → signed LINE events → outbox → album → gallery, recovery and retention",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "gallery-test-"));
    Object.assign(process.env, {
      APP_URL: "http://localhost",
      STAGING_PATH: join(temp, "stage"),
      THUMBNAIL_PATH: join(temp, "thumb"),
      SESSION_SECRET: "x".repeat(32),
      BOOTSTRAP_SECRET: "b".repeat(24),
      TOKEN_ENCRYPTION_KEY: "1".repeat(64),
      LINE_CHANNEL_SECRET: "fixture",
      LINE_CHANNEL_ACCESS_TOKEN: "test",
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_REDIRECT_URI: "http://localhost/api/v1/google/callback",
      MIN_FREE_MB: "1",
    });
    const { db } = await import("../packages/database"),
      { build } = await import("../apps/api/server"),
      { processEvent, resolveAlbum } = await import("../apps/worker/process"),
      { cleanup } = await import("../apps/worker/maintenance"),
      { scopes } = await import("../packages/google-photos");
    const app = await build();
    const prefix = "/api/v1",
      origin = { origin: "http://localhost", "x-gallery-request": "1" };
    try {
      expect((await app.inject({ url: prefix + "/images" })).statusCode).toBe(
        401,
      );
      const setup = await app.inject({
        method: "POST",
        url: prefix + "/auth/setup",
        headers: origin,
        payload: {
          email: "owner@example.org",
          password: "long-fixture-password",
          bootstrap: "b".repeat(24),
        },
      });
      expect(setup.statusCode).toBe(200);
      const cookie = setup.cookies[0].value,
        headers = { ...origin, cookie: "session=" + cookie };
      expect(
        (
          await app.inject({
            method: "POST",
            url: prefix + "/auth/login",
            headers: origin,
            payload: { email: "owner@example.org", password: "wrong" },
          })
        ).statusCode,
      ).toBe(401);
      const event = (
        type: string,
        id: string,
        kind = "image",
        source = "group",
      ) => ({
        type,
        webhookEventId: id,
        timestamp: Date.now(),
        source: { type: source, groupId: "group-a" },
        message: { type: kind, id: "message-a" },
      });
      const send = async (events: ReturnType<typeof event>[], valid = true) => {
        const raw = JSON.stringify({ destination: "channel", events });
        return app.inject({
          method: "POST",
          url: "/api/webhooks/line",
          payload: raw,
          headers: {
            "content-type": "application/json",
            "x-line-signature": valid
              ? createHmac("sha256", "fixture").update(raw).digest("base64")
              : "wrong",
          },
        });
      };
      expect((await send([], false)).statusCode).toBe(403);
      expect(
        (await send([event("join", "j"), event("message", "disabled")]))
          .statusCode,
      ).toBe(200);
      expect(await db.image.count()).toBe(0);
      const g = await db.lineGroup.findFirstOrThrow();
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: prefix + "/groups/" + g.id,
            headers,
            payload: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      await send([
        event("message", "video", "video"),
        event("message", "direct", "image", "user"),
      ]);
      expect(await db.image.count()).toBe(0);
      await send([
        event("message", "img"),
        event("message", "img"),
        event("message", "other-event"),
      ]);
      expect(await db.image.count()).toBe(1);
      const png = await sharp({
        create: { width: 20, height: 15, channels: 3, background: "green" },
      })
        .png()
        .toBuffer();
      let albums = 0,
        creates = 0,
        mode = "success",
        matched = "";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const json = (v: unknown) => Response.json(v);
          if (url.includes("oauth2.googleapis.com") && mode === "invalid-grant")
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          if (
            url.includes("oauth2.googleapis.com") &&
            String(init?.body).includes("authorization_code")
          )
            return json({
              refresh_token: "refresh",
              scope: scopes.join(" "),
              access_token: "access",
            });
          if (url.endsWith("albums?pageSize=1")) return json({});
          if (url.includes("oauth2.googleapis.com"))
            return json({ access_token: "access" });
          if (url.includes("api-data.line.me") && mode === "throttle")
            return new Response("slow", {
              status: 429,
              headers: { "Retry-After": "60" },
            });
          if (url.includes("api-data.line.me") && mode === "invalid")
            return new Response("not a photo");
          if (url.includes("api-data.line.me"))
            return new Response(new Uint8Array(png));
          if (url.endsWith("/summary")) return json({ groupName: "Family" });
          if (url.endsWith("/albums")) {
            albums++;
            return json({ id: "album" });
          }
          if (url.endsWith("/albums/album"))
            return json({ id: "album", mediaItemsCount: "1" });
          if (url.endsWith("/uploads")) {
            for await (const _ of init!
              .body as unknown as AsyncIterable<Buffer>) {
            }
            return new Response("upload");
          }
          if (url.endsWith(":batchCreate")) {
            creates++;
            matched = JSON.parse(String(init?.body)).newMediaItems[0]
              .simpleMediaItem.fileName;
            if (mode === "ambiguous") throw Error("lost response");
            if (mode === "partial")
              return json({ newMediaItemResults: [{ status: { code: 7 } }] });
            return json({
              newMediaItemResults: [
                { status: {}, mediaItem: { id: "media-1" } },
              ],
            });
          }
          if (url.endsWith(":search"))
            return json({
              mediaItems:
                mode === "found"
                  ? [{ id: "reconciled", filename: matched }]
                  : [],
            });
          throw Error("Unexpected URL");
        }),
      );
      const consent = await app.inject({
        url: prefix + "/google/connect",
        headers,
      });
      const state = new URL(String(consent.headers.location)).searchParams.get(
        "state",
      );
      const callback = prefix + "/google/callback?code=code&state=" + state;
      expect((await app.inject({ url: callback, headers })).statusCode).toBe(
        302,
      );
      expect((await app.inject({ url: callback, headers })).statusCode).toBe(
        403,
      );
      expect(
        (await db.googleConnection.findFirstOrThrow()).encryptedRefreshToken,
      ).not.toBe("refresh");
      const spec = await app.inject({ url: "/api/openapi.json", headers });
      expect(spec.json().paths["/api/v1/groups/{id}"].patch).toBeTruthy();
      const run = async () =>
        processEvent(
          (
            await db.outboxEvent.findFirstOrThrow({
              orderBy: { createdAt: "asc" },
            })
          ).id,
        );
      await run();
      await run();
      const staged = await db.image.findFirstOrThrow();
      expect(staged.mimeType).toBe("image/png");
      expect(staged.width).toBe(20);
      await Promise.allSettled([
        resolveAlbum(g, "access"),
        resolveAlbum(g, "access"),
      ]);
      expect(albums).toBe(1);
      await run();
      expect(
        (
          await app.inject({
            url: prefix + "/images?status=SYNCED&group=group-a",
            headers,
          })
        ).json().total,
      ).toBe(1);
      expect(
        (
          await app.inject({ url: prefix + "/images?status=FAILED", headers })
        ).json().total,
      ).toBe(0);
      expect(
        (
          await app.inject({
            url: prefix + "/images/" + staged.id + "/thumbnail",
            headers,
          })
        ).statusCode,
      ).toBe(200);
      for (const state of ["partial", "ambiguous"]) {
        mode = state;
        const e = event("message", state);
        e.message.id = state;
        await send([e]);
        await run();
        await run();
        const row = await db.image.findFirstOrThrow({
          where: { lineMessageId: state },
        });
        expect(row.uploadStatus).toBe(
          state === "partial" ? "FAILED" : "NEEDS_REVIEW",
        );
        if (state === "ambiguous") {
          mode = "invalid-grant";
          await app.inject({
            method: "POST",
            url: prefix + "/jobs/" + row.id + "/retry",
            headers,
          });
          await run();
          expect(
            (await db.image.findUniqueOrThrow({ where: { id: row.id } }))
              .uploadStatus,
          ).toBe("NEEDS_REVIEW");
          mode = "found";
          await app.inject({
            method: "POST",
            url: prefix + "/jobs/" + row.id + "/retry",
            headers,
          });
          await run();
          expect(
            (await db.image.findUniqueOrThrow({ where: { id: row.id } }))
              .googleMediaItemId,
          ).toBe("reconciled");
        }
      }
      expect(creates).toBe(3);
      await cleanup(Date.now() + 31 * 86400000);
      expect(await stat(staged.stagingPath!).catch(() => null)).toBeNull();
      const failed = await db.image.findFirstOrThrow({
        where: { uploadStatus: "FAILED" },
      });
      expect((await stat(failed.stagingPath!)).size).toBeGreaterThan(0);

      mode = "invalid";
      const bad = event("message", "bad");
      bad.message.id = "bad";
      await send([bad]);
      await run();
      expect(
        (await db.image.findFirstOrThrow({ where: { lineMessageId: "bad" } }))
          .uploadStatus,
      ).toBe("UNRECOVERABLE");
      const { Queue, Worker } = await import("bullmq"),
        { dispatch } = await import("../apps/worker/dispatch");
      const connection = { url: process.env["REDIS_URL"] },
        q = new Queue("recovery-test", { connection });
      mode = "throttle";
      const delayed = event("message", "limited");
      delayed.message.id = "limited";
      await send([delayed]);
      await dispatch(q);
      await q.close();
      const q2 = new Queue("recovery-test", { connection });
      const worker = new Worker("recovery-test", (j) => processEvent(j.id!), {
        connection,
      });
      try {
        await vi.waitFor(
          async () =>
            expect(
              (
                await db.image.findFirstOrThrow({
                  where: { lineMessageId: "limited" },
                })
              ).uploadStatus,
            ).toBe("RETRY_PENDING"),
          { timeout: 10000 },
        );
        const later = await db.outboxEvent.findFirstOrThrow();
        expect(+later.availableAt - Date.now()).toBeGreaterThan(55000);
        mode = "success";
        await dispatch(q2, new Date(+later.availableAt + 1));
        await vi.waitFor(
          async () =>
            expect(
              (
                await db.image.findFirstOrThrow({
                  where: { lineMessageId: "limited" },
                })
              ).uploadStatus,
            ).toBe("STAGED"),
          { timeout: 10000 },
        );
      } finally {
        await worker.close();
        await q2.close();
      }
    } finally {
      vi.unstubAllGlobals();
      await app.close();
      await db.$disconnect();
    }
  },
  60000,
);
