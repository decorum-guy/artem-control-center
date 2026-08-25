import { expect, test } from "@playwright/test";

const correlationId = "a1b2c3d4-aaaa-bbbb-cccc-123456789012";

function availability(allowed = true) {
  return {
    schemaVersion: 1,
    action: {
      capability: "system.connectivity.restart",
      minimumProfile: "standard",
      effectiveProfile: allowed ? "standard" : "read_only",
      allowed,
      availability: allowed ? "allowed" : "profile_blocked",
      activeCorrelationId: null
    }
  };
}

function execution(status: string) {
  return {
    schemaVersion: 1,
    correlationId,
    actionId: "system.connectivity.restart",
    status,
    requestedAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:01Z",
    finishedAt: ["connected", "degraded", "failed"].includes(status)
      ? "2026-08-11T00:00:02Z"
      : null,
    result: status === "connected"
      ? {
          homeAssistantForwardReady: true,
          aliceForwardReady: true,
          homeAssistantLive: true,
          homeAssistantWebSocket: true,
          homeAssistantSnapshotConfirmed: true,
          aliceLive: true,
          aliceHealthy: true
        }
      : null,
    error: null
  };
}

test("degraded Home connectivity can be recovered directly from Overview without PIN", async ({ page }) => {
  let postCount = 0;
  let executionReads = 0;

  await page.route("**/api/v1/actions/system/connectivity**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname.endsWith("/availability")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(availability(true))
      });
      return;
    }

    if (url.pathname === "/api/v1/actions/system/connectivity" && request.method() === "POST") {
      postCount += 1;
      expect(request.postDataJSON()).toEqual({ actionId: "system.connectivity.restart" });
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify(execution("requested"))
      });
      return;
    }

    if (url.pathname.endsWith(`/${correlationId}`)) {
      executionReads += 1;
      const statuses = ["restarting", "waiting_for_forwards", "verifying", "connected"];
      const status = statuses[Math.min(executionReads - 1, statuses.length - 1)];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(execution(status))
      });
      return;
    }

    await route.continue();
  });

  await page.goto("/overview?scenario=ha-offline-policy-available");
  const surface = page.getByTestId("connectivity-recovery-surface");
  await expect(surface).toBeVisible();
  await expect(surface).toContainText("Приватное подключение требует внимания");

  const reconnect = surface.getByRole("button", { name: "Подключиться снова" });
  await expect(reconnect).toBeEnabled();
  await reconnect.click();

  await expect(page.locator(".pin-modal")).toHaveCount(0);
  await expect(page.getByTestId("action-confirmation")).toHaveCount(0);
  await expect(page.getByTestId("connectivity-action-notice")).toContainText(
    /Перезапускаем приватное подключение|Ждём туннели|Проверяем Home Assistant|Home Assistant и AliceTG снова на связи/
  );
  await expect(page.getByTestId("connectivity-action-notice"))
    .toContainText("Home Assistant и AliceTG снова на связи", { timeout: 8_000 });
  expect(postCount).toBe(1);
});

test("read-only profile exposes recovery state but cannot restart connectivity", async ({ page }) => {
  let postCount = 0;
  await page.route("**/api/v1/actions/system/connectivity**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/availability")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(availability(false))
      });
      return;
    }
    if (request.method() === "POST") postCount += 1;
    await route.fulfill({ status: 403, contentType: "application/json", body: '{"detail":"profile_blocked"}' });
  });

  await page.goto("/home?scenario=ha-offline-policy-available");
  const surface = page.getByTestId("connectivity-recovery-surface");
  await expect(surface).toBeVisible();
  await expect(surface.getByRole("button", { name: "Подключиться снова" })).toBeDisabled();
  expect(postCount).toBe(0);
});

test("degraded connectivity remains visible when the local recovery API is unavailable", async ({ page }) => {
  await page.route("**/api/v1/actions/system/connectivity**", async (route) => {
    await route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"not_found"}' });
  });

  await page.goto("/overview?scenario=ha-offline-policy-available");
  const surface = page.getByTestId("connectivity-recovery-surface");
  await expect(surface).toBeVisible();
  await expect(surface).toContainText("восстановление недоступно");
  await expect(surface.getByRole("button", { name: "Подключиться снова" })).toBeDisabled();
});
