import { expect, test } from "@playwright/test";

const actionIds = [
  "avalar.main.smoke",
  "avalar.stage.smoke",
  "avalar.main.restart",
  "avalar.stage.restart",
  "avalar.stage.deploy",
  "avalar.main.deploy"
] as const;

function availabilityPayload() {
  return {
    schemaVersion: 1,
    actions: Object.fromEntries(actionIds.map((actionId) => [
      actionId,
      {
        capability: actionId,
        minimumProfile: actionId.endsWith(".smoke") ? "standard" : "full",
        effectiveProfile: "standard",
        allowed: actionId.endsWith(".smoke"),
        availability: actionId.endsWith(".smoke") ? "allowed" : "elevation_required",
        cooldownUntil: null
      }
    ]))
  };
}

function execution(status: "requested" | "running" | "success") {
  return {
    schemaVersion: 1,
    correlationId: "12345678-aaaa-bbbb-cccc-123456789012",
    actionId: "avalar.stage.smoke",
    environment: "stage",
    status,
    requestedAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:01Z",
    finishedAt: status === "success" ? "2026-08-11T00:00:02Z" : null,
    result: status === "success" ? { ok: true } : null,
    error: null
  };
}

test("AVALAR Stage smoke uses a readable status card without overlapping disabled text", async ({ page }) => {
  let executionReads = 0;

  await page.route("**/api/v1/actions/avalar**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname.endsWith("/availability")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(availabilityPayload())
      });
      return;
    }

    if (url.pathname === "/api/v1/actions/avalar" && request.method() === "POST") {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify(execution("requested"))
      });
      return;
    }

    if (url.pathname.includes("/api/v1/actions/avalar/12345678-")) {
      executionReads += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(execution(executionReads >= 2 ? "success" : "running"))
      });
      return;
    }

    await route.continue();
  });

  await page.goto("/services");

  const stageRow = page.getByTestId("widget-avalar-site-stage");
  const smoke = stageRow.getByRole("button", { name: "Проверить Stage" });
  await expect(smoke).toBeEnabled();
  await smoke.click();

  const notice = page.getByTestId("avalar-action-notice");
  await expect(notice).toBeVisible();
  await expect(notice.locator("strong")).toHaveText("Проверить Stage");
  await expect(notice).toContainText(/Отправляем защищённую команду|Выполняем на сервере|Успешно проверено/);

  const background = await notice.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
  expect(background).not.toBe("transparent");

  const box = await notice.boundingBox();
  expect(box?.width).toBeGreaterThan(300);
  expect(box?.height).toBeGreaterThan(70);

  await expect(smoke).toBeDisabled();
  const pseudoContent = await smoke.evaluate((element) => getComputedStyle(element, "::after").content);
  expect(["none", "normal", '""']).toContain(pseudoContent);

  await expect(notice).toContainText("Успешно проверено", { timeout: 5_000 });
});
