import { expect, test } from "vitest";
import { backoff, transition } from "../packages/shared/model";
import { signed, relevant } from "../packages/line-client";
import { createHmac } from "node:crypto";
test("signature binds exact raw bytes", () => {
  const b = Buffer.from("{ }"),
    s = createHmac("sha256", "key").update(b).digest("base64");
  expect(signed(b, s, "key")).toBe(true);
  expect(signed(Buffer.from("{}"), s, "key")).toBe(false);
});
test("rooms are not groups", () =>
  expect(
    relevant({
      type: "message",
      source: { type: "room" },
      message: { type: "image", id: "1" },
      timestamp: 1,
      webhookEventId: "e",
    }),
  ).toBeFalsy());
test("sync needs remote ID and correct predecessor", () => {
  expect(() => transition("STAGED", "SYNCED", "id")).toThrow();
  expect(() => transition("CREATING_MEDIA", "SYNCED")).toThrow();
  expect(() => transition("CREATING_MEDIA", "SYNCED", "id")).not.toThrow();
});
test("retry respects provider floor and caps exponential delay", () => {
  expect(backoff(1, 60000)).toBe(60000);
  expect(backoff(99)).toBeLessThanOrEqual(3600000);
});
