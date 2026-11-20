import type { SwaggerTransform } from "@fastify/swagger";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { limits, states } from "../../packages/shared/model";
const body: Record<string, z.ZodType> = {
  "POST /auth/setup": z.object({
    email: z.email(),
    password: z.string().min(12).max(256),
    bootstrap: z.string(),
  }),
  "POST /auth/login": z.object({ email: z.email(), password: z.string() }),
  "PATCH /settings": limits,
  "POST /settings/line": z.object({ token: z.string(), secret: z.string() }),
  "PATCH /groups/:id": z.object({ enabled: z.boolean() }),
  "POST /groups/:id/resolve-album": z.object({
    albumId: z.string().optional(),
    confirmation: z.literal("I checked Google Photos"),
  }),
  "POST /jobs/:id/discard": z.object({
    confirmation: z.literal("Discard staged original"),
  }),
};
const error = { type: "object", properties: { error: { type: "string" } } };
export const describe: SwaggerTransform = ({ schema, url, route }) => {
  const path = url.replace("/api/v1", ""),
    method = String(route.method),
    isHook = url === "/api/webhooks/line",
    publicPath =
      isHook || (path.startsWith("/auth/") && path !== "/auth/logout");
  const out = {
    ...schema,
    tags: [isHook ? "webhook" : path.split("/")[1]],
    summary: method + " " + path,
    security: publicPath ? [] : [{ session: [] }],
    response: { 400: error, 401: error, 403: error, 409: error, 503: error },
    ...(url === "/ready" ? { hide: true } : {}),
  };
  const extra: FastifySchema = {};
  if (body[method + " " + path])
    extra.body = z.toJSONSchema(body[method + " " + path]);
  if (path.includes(":id"))
    extra.params = {
      type: "object",
      properties: { id: { type: "string", format: "uuid" } },
      required: ["id"],
    };
  if (path === "/images" || path === "/jobs")
    extra.querystring = z.toJSONSchema(
      z.object({
        page: z.int().min(1).optional(),
        group: z.string().optional(),
        status: z.enum(states).optional(),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
      }),
    );
  if (isHook) {
    extra.headers = {
      type: "object",
      required: ["x-line-signature"],
      properties: {
        "x-line-signature": {
          type: "string",
          description: "Base64 HMAC-SHA256 of the original request bytes",
        },
      },
    };
    extra.body = {
      type: "object",
      required: ["destination", "events"],
      properties: {
        destination: { type: "string" },
        events: { type: "array", items: { type: "object" } },
      },
    };
  }
  return { schema: { ...out, ...extra }, url };
};
