import { expect, test } from "@playwright/test";

const v2Enabled = process.env.VITE_V2_VISUAL_SHELL === "true";

test.describe("owner diagnostics surface", () => {
  test.skip(!v2Enabled, "Run with VITE_V2_VISUAL_SHELL=true for the V2 diagnostics gate.");

  test("attention header reaches concrete problem details and stays within 1280x720", async ({ page }) => {
    await page.route("**/api/v1/access", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        baseProfile: "read_only",
        effectiveProfile: "read_only",
        temporaryFull: false,
        temporaryFullExpiresAt: null,
        confirmationPolicy: { actionConfirmationRequired: true, mode: "profile_default" },
        pinConfigured: false,
        lockoutUntil: null,
        capabilities: {}
      })
    }));
    await page.route("**/api/v1/actions/avalar/availability", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ schemaVersion: 1, actions: {} })
    }));
    await page.route("**/api/v1/actions/system/connectivity/availability", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        action: {
          capability: "system.connectivity.restart",
          minimumProfile: "standard",
          effectiveProfile: "read_only",
          allowed: false,
          availability: "profile_blocked",
          activeCorrelationId: null
        }
      })
    }));
    const consoleErrors: string[] = [];
    const httpErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`);
    });

    await page.goto("/overview");
    const header = page.getByTestId("product-header");
    await expect(header).toBeVisible();
    await expect(page.locator(".v2-header-system")).toContainText("требуют внимания");
    await page.locator(".v2-header-system").click();
    await expect(page.getByTestId("route-system")).toBeVisible();
    await expect(page.getByTestId("system-problem-details")).toBeVisible();
    await expect(page.getByTestId("system-problem-details")).toContainText("Требуют внимания");
    await expect(page.getByTestId("copy-diagnostics")).toBeVisible();
    await page.getByTestId("copy-diagnostics").click();
    await expect(page.locator("[role='status']").filter({ hasText: /Диагностика|отчёт|подготовить/i }).first()).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
    expect(consoleErrors, httpErrors.join("\n")).toEqual([]);
    expect(httpErrors).toEqual([]);
  });

  test("diagnostics endpoint exposes a bounded sanitized contract", async ({ request }) => {
    const response = await request.get("/api/v1/diagnostics?scenario=ha-healthy");
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    expect(payload.schemaVersion).toBe("diagnostics.v1");
    expect(payload.calendar).toMatchObject({
      fromDate: expect.any(String),
      toDate: expect.any(String),
      resultStatus: expect.any(String),
      itemCount: expect.any(Number)
    });
    expect(JSON.stringify(payload)).not.toMatch(/secret|PRIVATE_EVENT|PRIVATE_REMINDER|PRIVATE_TASK/i);
  });
});
