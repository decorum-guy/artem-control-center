import { expect, test, type Page } from "@playwright/test";

type RogStatus = "offline" | "online" | "waking" | "sleeping" | "hibernating";
type RogAction = "system.rog_g703.wake" | "system.rog_g703.sleep" | "system.rog_g703.hibernate";

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

function accessStatus(elevated: boolean) {
  const availability = elevated ? "allowed" : "elevation_required";
  const effectiveProfile = elevated ? "full" : "read_only";
  const decision = (capability: RogAction) => ({
    capability,
    minimumProfile: "standard",
    effectiveProfile,
    allowed: elevated,
    availability,
    cooldownUntil: null
  });
  return {
    schemaVersion: 1,
    revision: elevated ? 2 : 1,
    baseProfile: "read_only",
    effectiveProfile,
    temporaryFull: elevated,
    temporaryFullExpiresAt: elevated ? "2099-01-01T00:00:00Z" : null,
    pinConfigured: true,
    lockoutUntil: null,
    capabilities: {
      "system.rog_g703.wake": decision("system.rog_g703.wake"),
      "system.rog_g703.sleep": decision("system.rog_g703.sleep"),
      "system.rog_g703.hibernate": decision("system.rog_g703.hibernate")
    }
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
          : status === "sleeping"
            ? "Переходит в сон Windows"
            : "Переходит в гибернацию Windows S4",
    actions: [
      { id: "system.rog_g703.wake", title: "Включить", enabled: status === "offline", risk: "low" },
      { id: "system.rog_g703.sleep", title: "Сон", enabled: status === "online", risk: "medium" },
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

async function mockRogG703(page: Page, options: { requireElevation?: boolean } = {}) {
  const requireElevation = options.requireElevation ?? false;
  let status: RogStatus = "offline";
  let elevated = false;
  const executionId = "rog-execution-1";
  let activeAction: RogAction | null = null;
  let polls = 0;
  const requestBodies: Record<string, unknown>[] = [];

  if (requireElevation) {
    await page.route(/\/api\/v1\/access(?:\/.*)?$/, async (route) => {
      const request = route.request();
      const url = new URL(request.url());

      if (url.pathname === "/api/v1/access" && request.method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(accessStatus(elevated))
        });
        return;
      }

      if (url.pathname === "/api/v1/access/unlock" && request.method() === "POST") {
        const body = request.postDataJSON() as { pin?: string };
        if (body.pin !== "1234") {
          await route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ detail: "invalid_pin" })
          });
          return;
        }
        elevated = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(accessStatus(elevated))
        });
        return;
      }

      await route.continue();
    });
  }

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
      const availabilityFor = (actionId: RogAction) => {
        const decision = actionAvailability(actionId, status);
        if (requireElevation && !elevated && decision.allowed) {
          return {
            ...decision,
            effectiveProfile: "read_only",
            allowed: false,
            availability: "elevation_required"
          };
        }
        return decision;
      };
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
            "system.rog_g703.wake": availabilityFor("system.rog_g703.wake"),
            "system.rog_g703.sleep": availabilityFor("system.rog_g703.sleep"),
            "system.rog_g703.hibernate": availabilityFor("system.rog_g703.hibernate")
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
      status = activeAction.endsWith("wake") ? "waking" : activeAction.endsWith("sleep") ? "sleeping" : "hibernating";
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
      const transition = activeAction?.endsWith("wake") ? "waking" : activeAction?.endsWith("sleep") ? "sleeping" : "hibernating";
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
  await expect(page.getByTestId("rog-g703-disabled")).toContainText("Секретные данные не отображаются");
});

test("touch-first ROG flow verifies wake, distinct Sleep/S4 hibernate and safe action payloads", async ({ page }) => {
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
  const sleep = page.getByTestId("rog-g703-sleep");
  const hibernate = page.getByTestId("rog-g703-hibernate");
  await expect(wake).toBeEnabled();
  await expect(sleep).toHaveCount(0);
  await expect(hibernate).toHaveCount(0);
  expect((await wake.boundingBox())?.height).toBeGreaterThanOrEqual(48);

  await wake.tap();
  await expect(controls).toContainText("Пробуждение");
  await expect(page.getByTestId("rog-g703-action-notice")).toContainText("Пакет пробуждения");
  await expect(controls).toContainText("В сети");
  await expect(sleep).toBeEnabled();
  await expect(hibernate).toBeEnabled();
  expect((await sleep.boundingBox())?.height).toBeGreaterThanOrEqual(48);
  expect((await hibernate.boundingBox())?.height).toBeGreaterThanOrEqual(48);

  await sleep.tap();
  const sleepConfirmation = page.getByTestId("action-confirmation");
  await expect(sleepConfirmation).toBeVisible();
  await expect(sleepConfirmation).toContainText("Перевести ASUS ROG G703GI в сон?");
  await sleepConfirmation.getByRole("button", { name: "Сон" }).click();
  await expect(controls).toContainText("Сон");
  await expect(sleep).toBeDisabled();
  await expect(hibernate).toBeDisabled();
  await expect(sleep).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("rog-g703-action-notice")).toContainText("переходит в сон");
  await expect(controls).toContainText("Не в сети");
  await expect(page.getByTestId("rog-g703-action-notice")).toContainText("переход подтверждён");

  await wake.tap();
  await expect(controls).toContainText("В сети");

  await hibernate.tap();
  const confirmation = page.getByTestId("action-confirmation");
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("Перевести ASUS ROG G703GI в гибернацию?");
  await confirmation.getByRole("button", { name: "Гибернация" }).click();
  await expect(controls).toContainText("Гибернация");
  await expect(page.getByTestId("rog-g703-action-notice")).toContainText("переходит в гибернацию");
  await expect(controls).toContainText("Не в сети");
  await expect(page.getByTestId("rog-g703-action-notice")).toContainText("переход подтверждён");

  expect(api.getRequestBodies()).toEqual([
    { actionId: "system.rog_g703.wake" },
    { actionId: "system.rog_g703.sleep" },
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

test("elevation-required ROG action reaches the existing PIN flow before POST", async ({ page }) => {
  const api = await mockRogG703(page, { requireElevation: true });
  await page.goto("/system");

  const controls = page.getByTestId("rog-g703-controls");
  const wake = page.getByTestId("rog-g703-wake");
  await expect(controls).toBeVisible();
  await expect(wake).toBeEnabled();
  expect((await wake.boundingBox())?.height).toBeGreaterThanOrEqual(48);

  await wake.tap();
  const dialog = page.getByRole("dialog", { name: "Включить" });
  await expect(dialog).toBeVisible();
  expect(api.getRequestBodies()).toHaveLength(0);

  await dialog.getByRole("button", { name: "Отмена" }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.getRequestBodies()).toHaveLength(0);

  await wake.tap();
  await expect(dialog).toBeVisible();
  for (const digit of ["0", "0", "0", "0"]) {
    await dialog.getByRole("button", { name: digit, exact: true }).click();
  }
  await dialog.getByRole("button", { name: "Разблокировать" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Неверный PIN.");
  expect(api.getRequestBodies()).toHaveLength(0);
  await dialog.getByRole("button", { name: "Отмена" }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.getRequestBodies()).toHaveLength(0);

  await wake.tap();
  await expect(dialog).toBeVisible();
  for (const digit of ["1", "2", "3", "4"]) {
    await dialog.getByRole("button", { name: digit, exact: true }).click();
  }
  await dialog.getByRole("button", { name: "Разблокировать" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(controls).toContainText("В сети");
  expect(api.getRequestBodies()).toEqual([{ actionId: "system.rog_g703.wake" }]);
});
