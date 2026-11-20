import { test, expect } from "@playwright/test";
test("gallery filters and keyboard-accessible viewer", async ({ page }) => {
  const group = {
    id: "group",
    lineGroupId: "source",
    displayName: "Family",
    _count: { images: 1 },
  };
  const photo = {
    id: "image",
    lineGroupId: "source",
    group,
    uploadStatus: "SYNCED",
    lineEventTimestamp: "2026-05-01T12:00:00Z",
    width: 320,
    height: 240,
    fileSize: 1234,
    mimeType: "image/png",
  };
  await page.route("**/api/v1/**", async (r) => {
    const u = new URL(r.request().url());
    const path = u.pathname;
    if (/thumbnail|content/.test(path))
      return r.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    const values = path.endsWith("auth/status")
      ? { setup: false, authenticated: true }
      : path.endsWith("/groups")
        ? [group]
        : u.searchParams.get("status") === "FAILED"
          ? { items: [], total: 0, page: 1 }
          : { items: [photo], total: 1, page: 1 };
    await r.fulfill({ json: values });
  });
  await page.goto("/gallery");
  await expect(page.getByRole("heading", { name: "Gallery" })).toBeVisible();
  await page.getByRole("button", { name: /Photo from Family/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Status", exact: true })
    .selectOption("FAILED");
  await expect(page.getByText("No images found")).toBeVisible();
  await expect(page).toHaveURL(/status=FAILED/);
});
test("deployed owner session and health", async ({ page }) => {
  test.skip(!process.env["E2E_SETUP_KEY"], "Requires disposable Compose stack");
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("operator@example.org");
  await page
    .getByLabel("Password", { exact: true })
    .fill("fixture-owner-passphrase");
  if (await page.getByLabel("Setup key").count()) {
    await page.getByLabel("Setup key").fill(process.env["E2E_SETUP_KEY"]!);
    await page.getByRole("button", { name: "Create owner account" }).click();
  } else await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.getByRole("link", { name: "System health" }).click();
  await expect(
    page.locator(".row").filter({ hasText: "worker" }),
  ).toContainText("Online");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
