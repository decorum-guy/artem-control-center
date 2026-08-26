import { expect, test, type Page } from "@playwright/test";

const v2Enabled = process.env.VITE_V2_VISUAL_SHELL === "true";
const lockEnabled = process.env.VITE_TOUCH_INPUT_LOCK_ENABLED === "true";

const CURRENT = "abc12345" + "0".repeat(32);
const TARGET = "def45678" + "1".repeat(32);
const CHANGED_TARGET = "fedcba98" + "2".repeat(32);

type UpdateCheck = {
  schemaVersion: "panel-update.v1";
  currentHead: string | null;
  targetHead: string | null;
  updateAvailable: boolean;
  updateAllowed: boolean;
  status: "update_available" | "up_to_date" | "blocked";
  reason: string | null;
};

type UpdateOwnerState = {
  schemaVersion: 1;
  status: "idle" | "checking" | "updating" | "success" | "failed";
  result?: string;
};

function available(target = TARGET): UpdateCheck {
  return {
    schemaVersion: "panel-update.v1",
    currentHead: CURRENT,
    targetHead: target,
    updateAvailable: true,
    updateAllowed: true,
    status: "update_available",
    reason: null
  };
}

function blocked(reason: string): UpdateCheck {
  return {
    schemaVersion: "panel-update.v1",
    currentHead: CURRENT,
    targetHead: TARGET,
    updateAvailable: false,
    updateAllowed: false,
    status: "blocked",
    reason
  };
}

function accessStatus(profile: "standard" | "full") {
  return {
    schemaVersion: 1,
    revision: profile === "full" ? 2 : 1,
    baseProfile: profile,
    effectiveProfile: profile,
    temporaryFull: false,
    temporaryFullExpiresAt: null,
    confirmationPolicy: {
      actionConfirmationRequired: false,
      mode: profile === "full" ? "manual_persistent_full" : "profile_default"
    },
    pinConfigured: true,
    lockoutUntil: null,
    capabilities: {}
  };
}

async function installRuntimeFixtures(page: Page, profile: "standard" | "full" = "full") {
  let currentProfile = profile;
  let nextCheck: UpdateCheck = available();
  let checkQueue: UpdateCheck[] = [];
  let statusQueue: UpdateOwnerState[] = [];
  let checkDelayMs = 0;
  let checkCount = 0;
  let statusCount = 0;
  let applyCount = 0;
  let shutdownCount = 0;
  let hideCount = 0;
  let lastApplyBody: Record<string, unknown> | null = null;
  let applyConflictOnce = false;

  await page.route("**/api/v1/access", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(accessStatus(currentProfile))
    });
  });

  await page.route("**/api/v1/system/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/v1/system/runtime" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: true, platform: "windows", revision: "runtime123456" })
      });
      return;
    }
    if (path === "/api/v1/system/update/status" && request.method() === "GET") {
      statusCount += 1;
      const payload = statusQueue.length
        ? statusQueue.shift()!
        : { schemaVersion: 1 as const, status: "idle" as const };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload)
      });
      return;
    }
    if (path === "/api/v1/system/update/check" && request.method() === "POST") {
      checkCount += 1;
      if (checkDelayMs > 0) await page.waitForTimeout(checkDelayMs);
      const payload = checkQueue.length ? checkQueue.shift()! : nextCheck;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      return;
    }
    if (path === "/api/v1/system/update/apply" && request.method() === "POST") {
      applyCount += 1;
      lastApplyBody = request.postDataJSON() as Record<string, unknown>;
      if (applyConflictOnce) {
        applyConflictOnce = false;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ detail: "update_target_changed" })
        });
        return;
      }
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ accepted: true, status: "updating" })
      });
      return;
    }
    if (path === "/api/v1/system/runtime/shutdown" && request.method() === "POST") {
      shutdownCount += 1;
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: true, action: "shutdown" }) });
      return;
    }
    if (path === "/api/v1/system/runtime/hide" && request.method() === "POST") {
      hideCount += 1;
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: true, action: "hide" }) });
      return;
    }
    await route.fallback();
  });

  await page.route("**/health/live", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok" }) });
  });

  return {
    setProfile: (next: "standard" | "full") => { currentProfile = next; },
    setCheck: (next: UpdateCheck) => { nextCheck = next; checkQueue = []; },
    queueChecks: (...checks: UpdateCheck[]) => { checkQueue = [...checks]; },
    queueStatuses: (...states: UpdateOwnerState[]) => { statusQueue = [...states]; },
    setCheckDelay: (milliseconds: number) => { checkDelayMs = milliseconds; },
    conflictNextApply: () => { applyConflictOnce = true; },
    getCheckCount: () => checkCount,
    getStatusCount: () => statusCount,
    getApplyCount: () => applyCount,
    getShutdownCount: () => shutdownCount,
    getHideCount: () => hideCount,
    getLastApplyBody: () => lastApplyBody
  };
}

async function openSystem(page: Page) {
  await page.goto("/system");
  await expect(page.getByTestId("route-system")).toBeVisible();
  const zone = page.getByTestId("system-runtime-zone");
  await zone.scrollIntoViewIfNeeded();
  await expect(zone).toBeVisible();
  return zone;
}

async function lockPanel(page: Page) {
  const control = page.getByTestId("interaction-lock-control");
  await expect(control).toBeVisible();
  if (await control.getAttribute("aria-pressed") === "true") return;
  await control.focus();
  await page.keyboard.down("Space");
  await page.waitForTimeout(1_100);
  await page.keyboard.up("Space");
  await expect(control).toHaveAttribute("aria-pressed", "true");
}

async function closeUpdateDialog(page: Page) {
  await page.getByTestId("runtime-update-dialog").getByRole("button", { name: "Отмена" }).click();
  await expect(page.getByTestId("runtime-update-dialog")).toHaveCount(0);
}

test.describe("Control Center runtime update UX", () => {
  test.skip(!v2Enabled || !lockEnabled, "Run with V2 shell and touch lock enabled.");

  test("1280x720 runtime zone fits three touch-safe controls without horizontal overflow", async ({ page }) => {
    await installRuntimeFixtures(page);
    const zone = await openSystem(page);

    for (const label of ["Скрыть панель", "Обновить панель", "Полностью закрыть"]) {
      const button = zone.getByRole("button", { name: label });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box?.height ?? 0, label).toBeGreaterThanOrEqual(48);
    }

    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth
    }));
    expect(overflow.document).toBeLessThanOrEqual(1);
    expect(overflow.body).toBeLessThanOrEqual(1);
  });

  test("Update opens a checking ceremony and then shows exact current and target versions", async ({ page }) => {
    const api = await installRuntimeFixtures(page);
    api.setCheckDelay(250);
    const zone = await openSystem(page);

    await zone.getByRole("button", { name: "Обновить панель" }).click();
    const dialog = page.getByTestId("runtime-update-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Проверяем обновления…");
    await expect(dialog).toContainText("Текущая версия");
    await expect(dialog).toContainText("abc12345");
    await expect(dialog).toContainText("После обновления");
    await expect(dialog).toContainText("def45678");
    await expect(dialog.getByRole("button", { name: "Обновить", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "Отмена" })).toBeEnabled();
  });

  test("same version reports latest and cannot apply", async ({ page }) => {
    const api = await installRuntimeFixtures(page);
    api.setCheck({
      schemaVersion: "panel-update.v1",
      currentHead: CURRENT,
      targetHead: CURRENT,
      updateAvailable: false,
      updateAllowed: false,
      status: "up_to_date",
      reason: null
    });
    const zone = await openSystem(page);
    await zone.getByRole("button", { name: "Обновить панель" }).click();

    const dialog = page.getByTestId("runtime-update-dialog");
    await expect(dialog).toContainText("Установлена последняя версия");
    await expect(dialog.getByRole("button", { name: "Обновить", exact: true })).toBeDisabled();
    expect(api.getApplyCount()).toBe(0);
  });

  test("dirty diverged and fetch failures stay owner-safe and cannot apply", async ({ page }) => {
    const api = await installRuntimeFixtures(page);
    const zone = await openSystem(page);
    const cases = [
      ["dirty_checkout", "В локальной копии есть несохранённые изменения"],
      ["diverged", "История локальной версии расходится с основной"],
      ["fetch_failed", "Не удалось проверить обновления"]
    ] as const;

    for (const [reason, copy] of cases) {
      api.setCheck(blocked(reason));
      await zone.getByRole("button", { name: "Обновить панель" }).click();
      const dialog = page.getByTestId("runtime-update-dialog");
      await expect(dialog).toContainText(copy);
      await expect(dialog.getByRole("button", { name: "Обновить", exact: true })).toBeDisabled();
      expect(await dialog.textContent()).not.toMatch(/stderr|fatal:|git fetch|C:\\|\/home\//i);
      await closeUpdateDialog(page);
    }
    expect(api.getApplyCount()).toBe(0);
  });

  test("valid apply sends only the checked exact current and target SHA", async ({ page }) => {
    const api = await installRuntimeFixtures(page, "full");
    const zone = await openSystem(page);
    await zone.getByRole("button", { name: "Обновить панель" }).click();
    const dialog = page.getByTestId("runtime-update-dialog");
    await dialog.getByRole("button", { name: "Обновить", exact: true }).click();

    await expect.poll(api.getApplyCount).toBe(1);
    expect(api.getLastApplyBody()).toEqual({ expectedCurrentHead: CURRENT, expectedTargetHead: TARGET });
    await expect(dialog).toContainText(/Запускаем обновление|Обновление выполняется/);
  });

  test("accepted apply that later fails becomes actionable and polling is cleaned up", async ({ page }) => {
    const api = await installRuntimeFixtures(page, "full");
    const zone = await openSystem(page);
    await zone.getByRole("button", { name: "Обновить панель" }).click();
    const dialog = page.getByTestId("runtime-update-dialog");
    await expect(dialog.getByRole("button", { name: "Обновить", exact: true })).toBeEnabled();

    api.queueStatuses(
      { schemaVersion: 1, status: "updating" },
      { schemaVersion: 1, status: "failed", result: "updater_unavailable" }
    );
    await dialog.getByRole("button", { name: "Обновить", exact: true }).click();

    await expect.poll(api.getApplyCount).toBe(1);
    await expect(dialog).toContainText("Обновление не завершено");
    await expect(dialog).not.toContainText("Запускаем…");
    await expect(dialog.getByRole("button", { name: "Отмена" })).toBeEnabled();
    expect(await dialog.textContent()).not.toMatch(/stderr|fatal:|C:\\|\/home\/|update-production\.ps1/i);

    const statusCountBeforeClose = api.getStatusCount();
    await closeUpdateDialog(page);
    await page.waitForTimeout(1_000);
    expect(api.getStatusCount()).toBe(statusCountBeforeClose);
  });

  test("changed target conflict rechecks instead of silently applying the new target", async ({ page }) => {
    const api = await installRuntimeFixtures(page, "full");
    api.queueChecks(available(TARGET), available(CHANGED_TARGET));
    api.conflictNextApply();
    const zone = await openSystem(page);
    await zone.getByRole("button", { name: "Обновить панель" }).click();
    const dialog = page.getByTestId("runtime-update-dialog");
    await expect(dialog).toContainText("def45678");
    await dialog.getByRole("button", { name: "Обновить", exact: true }).click();

    await expect.poll(api.getCheckCount).toBe(2);
    await expect(dialog).toContainText("fedcba98");
    expect(api.getApplyCount()).toBe(1);
    expect(api.getLastApplyBody()).toEqual({ expectedCurrentHead: CURRENT, expectedTargetHead: TARGET });
  });

  test("non-Full access cannot send update apply", async ({ page }) => {
    const api = await installRuntimeFixtures(page, "standard");
    const zone = await openSystem(page);
    await zone.getByRole("button", { name: "Обновить панель" }).click();
    const dialog = page.getByTestId("runtime-update-dialog");
    await expect(dialog).toContainText("Для установки включите Полный доступ.");
    await expect(dialog.getByRole("button", { name: "Обновить", exact: true })).toBeDisabled();
    expect(api.getApplyCount()).toBe(0);
  });

  test("interaction lock closes the update ceremony and never sends apply", async ({ page }) => {
    const api = await installRuntimeFixtures(page, "full");
    const zone = await openSystem(page);
    await zone.getByRole("button", { name: "Обновить панель" }).click();
    await expect(page.getByTestId("runtime-update-dialog")).toBeVisible();

    await lockPanel(page);
    await expect(page.getByTestId("runtime-update-dialog")).toHaveCount(0);
    expect(api.getApplyCount()).toBe(0);
  });

  test("Full access with confirmation waiver still requires explicit shutdown confirmation", async ({ page }) => {
    const api = await installRuntimeFixtures(page, "full");
    const zone = await openSystem(page);
    const shutdown = zone.getByRole("button", { name: "Полностью закрыть" });

    await shutdown.click();
    let confirmation = page.getByTestId("action-confirmation");
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole("heading", { name: "Полностью закрыть панель?" })).toBeVisible();
    expect(api.getShutdownCount()).toBe(0);

    await confirmation.getByRole("button", { name: "Отмена" }).click();
    await expect(confirmation).toHaveCount(0);
    expect(api.getShutdownCount()).toBe(0);

    await shutdown.click();
    confirmation = page.getByTestId("action-confirmation");
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Полностью закрыть", exact: true }).click();
    await expect.poll(api.getShutdownCount).toBe(1);
    expect(api.getHideCount()).toBe(0);
  });
});
