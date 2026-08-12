import { expect, test, type Page } from "@playwright/test";

type RogStatus = "offline" | "online" | "waking" | "hibernating";
type RogAction = "system.rog_g703.wake" | "system.rog_g703.hibernate";

function actionAvailability(actionId: RogAction, status: RogStatus) {
  const online = status === "online";
  const allowed = actionId.endsWith("wake") ? !online : online;
  return {
    capability: actionId,
    minimumProfile: "standard",
    effectiveProfile: "standard",
    allowed,
    availability: allowed ? "allowed" : "precondition_failed",
    cooldownUntil: null,
    targetId: "rog_g703gi",
    status
  };
}

function rogService(status: RogStatus) {
  const health = status === "online" ? "healthy" : status === "offline" ? "offline" : "degraded";
  return {
    id: "rog_g703gi",
    title: "ASUS ROG G703GI",
    enabled: true,
    dataContract: "system.rog-g703.v1",
    health,
    source: "live",
    summary: status === "online"
      ? "В сети"
      : status === "offline"
        ? "Не отвечает · сон или гибернация"
        : status === "waking"
          ? "Проверяем появление ASUS в сети"
          : "Переходит в гибернацию Windows S4",
    actions: [
      { id: "system.rog_g703.wake", title: "Включить", enabled: status === "offline", risk: "low" },
      { id: "system.rog_g703.hibernate", title: "Гибернация", enabled: status === "online", risk: "medium" }
    ],
    data: {
      targetId: "rog_g703gi",
      status,
      observedAt: "2026-08-12T20:00:00Z",
      lastTransitionAt: "2026-08-12T20:00:00Z",
      lastError: null
    },
    presentation: {
      category: "system",
      group: "System",
      overview: "none",
      priority: 85,
      environment: "LAN",
      freshnessLabel: "только что",
      incidents: status === "online" ? 0 : 1
    }
  };
}

async function mockRogG703(page: Page) {
  let status: RogStatus = "offline";
  const executionId = "rog-execution-1";
  let activeAction: RogAction | null = null;
  let polls = 0;
  const requestBodies: Record<string, unknown>[] = [];

  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { services: unknown[] };
    payload.services = [...payload.services, rogService(status)];
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });

  await page.route(/\/api\/v1\/actions\/system\/rog-g703(?:\/.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/availability")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          targetId: "rog_g703gi",
          status: {
            targetId: "rog_g703gi",
            status,
            observedAt: "2026-08-12T20:00:00Z",
            lastTransitionAt: "2026-08-12T20:00:00Z",
            lastError: null
          },
          actions: {
            "system.rog_g703.wake": actionAvailability("system.rog_g703.wake", status),
            "system.rog_g703.hibernate": actionAvailability("system.rog_g703.hibernate", status)
          }
        })
      });
      return;
    }
    if (url.pathname === "/api/v1/actions/system/rog-g703" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      requestBodies.push(body);
      expect(Object.keys(body)).toEqual(["actionId"]);
      activeAction = body.actionId as RogAction;
      polls = 0;
      status = activeAction.endsWith("wake") ? "waking" : "hibernating";
      await new Promise((resolve) => setTimeout(resolve, 120));
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          correlationId: executionId,
          targetId: "rog_g703gi",
          actionId: activeAction,
          status: "requested",
          requestedAt: "2026-08-12T20:00:00Z",
          updatedAt: "2026-08-12T20:00:00Z",
          finishedAt: null,
          result: null,
          error: null
        })
      });
      return;
    }
    if (url.pathname.endsWith(`/${executionId}`)) {
      polls += 1;
      const transition = activeAction?.endsWith("wake") ? "waking" : "hibernating";
      const terminal = activeAction?.endsWith("wake") ? "online" : "offline";
      if (polls > 1) status = terminal;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          correlationId: executionId,
          targetId: "rog_g703gi",
          actionId: activeAction,
          status: polls > 1 ? terminal : transition,
          requestedAt: "2026-08-12T20:00:00Z",
          updatedAt: "2026-08-12T20:00:01Z",
          finishedAt: polls > 1 ? "2026-08-12T20:00:02Z" : null,
          result: polls > 1
            ? activeAction?.endsWith("wake")
              ? { packetsSent: 3, onlineConfirmed: true }
              : { offlineConfirmed: true }
            : null,
          error: null
        })
      });
      return;
    }
    await route.continue();
  });

  return { getRequestBodies: () => requestBodies };
}

test("feature-off System route is explicit and does not expose ASUS controls", async ({ page }) => {
  await page.goto("/system");
  await expect(page.getByTestId("route-system")).toBeVisible();
  await expect(page.getByTestId("rog-g703-disabled")).toBeVisible();
  await expect(page.getByTestId("rog-g703-controls")).toHaveCount(0);
  await expect(page.getByText("MAC-адрес", { exact: false })).toHaveCount(1);
});

test("touch-first ROG flow verifies wake, S4 hibernate and safe action payloads", async ({ page }) => {
  await page.addInitScript(() => {
    (window as typeof window & { __nativeConfirmationCalls?: number }).__nativeConfirmationCalls = 0;
    window.confirm = () => {
      (window as typeof window & { __nativeConfirmationCalls?: number }).__nativeConfirmationCalls! += 1;
      return false;
    };
  });
  const api = await mockRogG703(page);
  await page.goto("/system");

  const controls = page.getByTestId("rog-g703-controls");
  await expect(controls).toBeVisible();
  const wake = page.getByTestId("rog-g703-wake");
  const hibernate = page.getByTestId("rog-g703-hibernate");
  await expect(wake).toBeEnabled();
  await expect(hibernate).toBeDisabled();
  expect((await wake.boundingBox())?.height).toBeGreaterThanOrEqual(48);
  expect((await hibernate.boundingBox())?.height).toBeGreaterThanOrEqual(48);

  await wake.tap();
  await expect(controls).toContainText("Пробуждение");
  await expect(page.getByTestId("rog-g703-action-notice")).toContainText("Пакет пробуждения");
  await expect(controls).toContainText("В сети");
  await expect(hibernate).toBeEnabled();

  await hibernate.tap();
  const confirmation = page.getByTestId("action-confirmation");
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("Перевести ASUS ROG G703GI в гибернацию?");
  await confirmation.getByRole("button", { name: "Гибернация" }).click();
  await expect(controls).toContainText("Гибернация");
  await expect(page.getByTestId("rog-g703-action-notice")).toContainText("переходит в гибернацию");
  await expect(controls).toContainText("Не в сети");
  await expect(page.getByTestId("rog-g703-action-notice")).toContainText("гибернация подтверждена");

  expect(api.getRequestBodies()).toEqual([
    { actionId: "system.rog_g703.wake" },
    { actionId: "system.rog_g703.hibernate" }
  ]);
  expect(await page.evaluate(() =>
    (window as typeof window & { __nativeConfirmationCalls?: number }).__nativeConfirmationCalls ?? 0
  )).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByTestId("global-notice-stack")).toBeVisible();
  await expect(page.getByTestId("rog-g703-action-notice")).toHaveCount(1);
});
