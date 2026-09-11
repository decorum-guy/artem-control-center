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
  let releaseStatus: (() => void) | null = null;
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });

  await page.route(/\/api\/v1\/actions\/avalar(?:\/.*)?$/, async (route) => {
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
      await statusGate;
      executionReads += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(execution(executionReads >= 3 ? "success" : "running"))
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

  releaseStatus?.();
  await expect(notice).toContainText("Успешно проверено", { timeout: 5_000 });
});

test("registry-backed AVALAR rows use the existing Services renderer and explicit actions", async ({ page }) => {
  await page.route(/\/api\/v1\/actions\/avalar(?:\/.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/availability")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(availabilityPayload())
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json() as { services: Array<Record<string, unknown>> };
    snapshot.services.push(
      {
        id: "avalar.main.website",
        title: "AVALAR · main · website",
        enabled: true,
        dataContract: "service.health.v1",
        health: "healthy",
        source: "live",
        summary: "Ready",
        actions: [],
        data: { projectId: "avalar", environmentId: "main", serviceId: "website" },
        presentation: {
          category: "work",
          group: "AVALAR",
          overview: "aggregate",
          priority: 90,
          environment: "main",
          freshnessLabel: "только что",
          latencyMs: 12,
          incidents: 0
        }
      },
      {
        id: "avalar.stage.website",
        title: "AVALAR · stage · website",
        enabled: true,
        dataContract: "service.health.v1",
        health: "healthy",
        source: "live",
        summary: "Ready",
        actions: [{ id: "avalar.stage.smoke", title: "Smoke check", enabled: true, risk: "low" }],
        data: { projectId: "avalar", environmentId: "stage", serviceId: "website" },
        presentation: {
          category: "work",
          group: "AVALAR",
          overview: "aggregate",
          priority: 80,
          environment: "stage",
          freshnessLabel: "только что",
          latencyMs: 10,
          incidents: 0
        }
      }
    );
    await route.fulfill({ response, body: JSON.stringify(snapshot) });
  });

  await page.goto("/services");

  const main = page.getByTestId("widget-avalar.main.website");
  await expect(main).toBeVisible();
  await expect(main.locator(".service-row__actions").getByRole("button")).toHaveCount(1);

  const stage = page.getByTestId("widget-avalar.stage.website");
  await expect(stage.getByRole("button", { name: "Smoke check" })).toBeEnabled();
});
