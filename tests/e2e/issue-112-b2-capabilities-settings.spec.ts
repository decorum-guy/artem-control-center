import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const artifacts = process.env.ISSUE_112_B2_CAPABILITIES_ARTIFACT_DIR ?? "artifacts/issue-112-b2-capabilities-review";

type Entry = {
  id: string; label: string; description: string; group: string; technicalFlag: string;
  activeEnabled: boolean; desiredEnabled: boolean; pending: boolean; mutable: boolean;
  behavior: "immediate" | "delayed"; requiredApplyAction: "none" | "restart" | "rebuild";
  operationalBlockedReason: string | null;
  configuredEnabled?: boolean; overrideEnabled?: boolean | null;
};

function entries(): Entry[] {
  return [
    { id: "calendar_display_colors", label: "Изменение цветов календарей", description: "Цвета действуют только внутри панели.", group: "Локальные возможности", technicalFlag: "PANEL_CALENDAR_DISPLAY_COLOR_WRITES_ENABLED", activeEnabled: true, desiredEnabled: true, pending: false, mutable: true, behavior: "immediate", requiredApplyAction: "none", operationalBlockedReason: null, configuredEnabled: true, overrideEnabled: null },
    { id: "overview_layout_editor", label: "Редактирование главного экрана", description: "Редактор виджетов.", group: "Локальные возможности", technicalFlag: "PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED", activeEnabled: true, desiredEnabled: true, pending: false, mutable: true, behavior: "immediate", requiredApplyAction: "none", operationalBlockedReason: null, configuredEnabled: true, overrideEnabled: null },
    { id: "planning_calendar_route", label: "Раздел «Календарь»", description: "Доступность раздела календаря.", group: "Планирование", technicalFlag: "VITE_PLANNING_CALENDAR_ROUTE_ENABLED", activeEnabled: true, desiredEnabled: true, pending: false, mutable: true, behavior: "delayed", requiredApplyAction: "rebuild", operationalBlockedReason: null, configuredEnabled: true, overrideEnabled: null },
    { id: "planning_reminder_mutations_ui", label: "Поддержка изменения напоминаний", description: "Сборка интерфейса.", group: "Планирование", technicalFlag: "VITE_PLANNING_REMINDER_MUTATIONS_ENABLED", activeEnabled: true, desiredEnabled: true, pending: false, mutable: false, behavior: "delayed", requiredApplyAction: "rebuild", operationalBlockedReason: null },
    { id: "planning_task_mutations", label: "Запись задач", description: "Разрешение Panel Agent изменять задачи.", group: "Планирование", technicalFlag: "PANEL_PLANNING_TASK_MUTATIONS_ENABLED", activeEnabled: true, desiredEnabled: true, pending: false, mutable: false, behavior: "immediate", requiredApplyAction: "none", operationalBlockedReason: null },
    { id: "planning_calendar_mutations", label: "Запись календаря", description: "Разрешение Panel Agent изменять события.", group: "Планирование", technicalFlag: "PANEL_PLANNING_CALENDAR_MUTATIONS_ENABLED", activeEnabled: true, desiredEnabled: true, pending: false, mutable: false, behavior: "immediate", requiredApplyAction: "none", operationalBlockedReason: null },
    { id: "panel_writes", label: "Запись панели", description: "Главный защитный барьер.", group: "Системные действия", technicalFlag: "PANEL_WRITES_ENABLED", activeEnabled: true, desiredEnabled: true, pending: false, mutable: false, behavior: "immediate", requiredApplyAction: "none", operationalBlockedReason: null },
    { id: "avalar_main_deploy", label: "Развёртывание AVALAR Main", description: "Инфраструктурное разрешение.", group: "Инфраструктура", technicalFlag: "PANEL_AVALAR_MAIN_DEPLOY_ENABLED", activeEnabled: true, desiredEnabled: true, pending: false, mutable: false, behavior: "immediate", requiredApplyAction: "none", operationalBlockedReason: null },
    { id: "rog_g703", label: "Инфраструктура ROG G703", description: "Управление зарегистрированной инфраструктурой.", group: "Инфраструктура", technicalFlag: "PANEL_ROG_G703_ENABLED", activeEnabled: true, desiredEnabled: true, pending: false, mutable: false, behavior: "immediate", requiredApplyAction: "none", operationalBlockedReason: null }
  ];
}

async function mockCapabilities(page: Page, options: { applyFailure?: boolean; writesEnabled?: boolean } = {}) {
  let revision = 1;
  let capabilities = entries();
  let applySucceeded = false;
  let applyPoll = 0;
  let patchRequests = 0;
  const payload = () => ({ schemaVersion: "capabilities.v1", revision, available: true, writesEnabled: options.writesEnabled ?? true, warnings: [], entries: capabilities });
  await page.route("**/api/v1/settings/capabilities", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: payload() });
    patchRequests += 1;
    const request = route.request().postDataJSON() as { expectedRevision: number; capabilityId: string; enabled: boolean | null };
    if (request.expectedRevision !== revision) return route.fulfill({ status: 409, json: { detail: "revision_conflict" } });
    capabilities = capabilities.map((entry) => entry.id !== request.capabilityId ? entry : entry.behavior === "immediate"
      ? { ...entry, activeEnabled: request.enabled ?? entry.configuredEnabled ?? true, desiredEnabled: request.enabled ?? entry.configuredEnabled ?? true, overrideEnabled: request.enabled }
      : { ...entry, desiredEnabled: request.enabled ?? entry.configuredEnabled ?? true, pending: entry.activeEnabled !== (request.enabled ?? entry.configuredEnabled ?? true), overrideEnabled: request.enabled });
    revision += 1;
    return route.fulfill({ json: payload() });
  });
  await page.route("**/api/v1/system/runtime/apply-capabilities", async (route) => {
    applySucceeded = true;
    applyPoll = 0;
    if (!options.applyFailure) capabilities = capabilities.map((entry) => entry.behavior === "delayed" ? { ...entry, activeEnabled: entry.desiredEnabled, pending: false } : entry);
    return route.fulfill({ status: 202, json: { accepted: true, action: "apply_capabilities" } });
  });
  await page.route("**/api/v1/system/runtime", async (route) => {
    const states = ["queued", "building", "restarting", "success"];
    const status = options.applyFailure && applySucceeded ? "failed" : applySucceeded ? states[Math.min(applyPoll++, states.length - 1)] : "idle";
    return route.fulfill({ json: { enabled: true, capabilityApplyEnabled: true, capabilityApply: { status }, platform: "posix" } });
  });
  return { patchRequests: () => patchRequests };
}

test.describe("Issue #112 B2.2 capabilities", () => {
  test("uses only immediate and staged owner behaviors at 1280×720", async ({ page }) => {
    await mockCapabilities(page);
    await page.goto("/settings");
    await page.getByTestId("settings-summary-capabilities").click();
    await expect(page.getByTestId("settings-capabilities-sheet")).toBeVisible();
    await expect(page.getByTestId("capability-calendar_display_colors")).toContainText("Сразу");
    await expect(page.getByTestId("capability-planning_calendar_route")).toContainText("После применения");
    await expect(page.getByText("Перезапуск", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("capability-panel_writes").locator("input")).toHaveCount(0);
    await expect(page.getByTestId("capability-avalar_main_deploy").locator("input")).toHaveCount(0);
    await expect(page.getByTestId("capability-rog_g703").locator("input")).toHaveCount(0);

    await page.getByTestId("capability-switch-calendar_display_colors").click();
    await expect(page.getByTestId("capability-calendar_display_colors")).toContainText("Выключено");

    await page.getByTestId("capability-switch-planning_calendar_route").click();
    await expect(page.getByTestId("capability-planning_calendar_route")).toContainText("Сейчас: Включено");
    await expect(page.getByTestId("capability-planning_calendar_route")).toContainText("После применения: Выключено");
    await expect(page.getByTestId("settings-summary-capabilities")).toContainText("1 ожидают применения");
    const routeRow = page.getByTestId("capability-planning_calendar_route");
    await expect(routeRow.getByRole("button", { name: "Использовать конфигурацию" })).toBeVisible();
    await routeRow.getByRole("button", { name: "Использовать конфигурацию" }).click();
    await expect(page.getByTestId("settings-summary-capabilities")).toContainText("Управление возможностями панели");
    await page.getByTestId("capability-switch-planning_calendar_route").click();
    await expect(page.getByTestId("capability-apply-area")).toContainText("Будет выполнена пересборка и перезапуск панели");
    await expect(page.getByRole("button", { name: "Применить изменения" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, "capabilities-pending.png"), animations: "disabled" });
  });

  test("keeps polling queued, building, and restarting until supervisor success", async ({ page }) => {
    await mockCapabilities(page);
    await page.goto("/settings");
    await page.getByTestId("settings-summary-capabilities").click();
    await page.getByTestId("capability-switch-planning_calendar_route").click();
    await page.getByRole("button", { name: "Применить изменения" }).click();
    await expect(page.getByTestId("capability-apply-area")).toContainText("Изменение поставлено в очередь");
    await expect(page.getByTestId("capability-apply-area")).toContainText("Собираем новую версию панели", { timeout: 5_000 });
    await expect(page.getByTestId("capability-apply-area")).toContainText("Перезапускаем и проверяем панель", { timeout: 5_000 });
    await expect(page.getByTestId("capability-apply-area")).toHaveCount(0, { timeout: 8_000 });
  });

  test("retains desired staged state after explicit supervisor failure", async ({ page }) => {
    await mockCapabilities(page, { applyFailure: true });
    await page.goto("/settings");
    await page.getByTestId("settings-summary-capabilities").click();
    await page.getByTestId("capability-switch-planning_calendar_route").click();
    await page.getByRole("button", { name: "Применить изменения" }).click();
    await expect(page.getByText("Не удалось применить изменения. Панель продолжает работать с предыдущими настройками.")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("capability-planning_calendar_route")).toContainText("Ожидает применения");
    await expect(page.getByTestId("settings-summary-capabilities")).toContainText("1 ожидают применения");
  });

  test("does not send a capability mutation while the global write master is disabled", async ({ page }) => {
    const mocked = await mockCapabilities(page, { writesEnabled: false });
    await page.goto("/settings");
    await page.getByTestId("settings-summary-capabilities").click();
    await expect(page.getByTestId("capability-switch-calendar_display_colors").locator("input")).toBeDisabled();
    await page.getByTestId("capability-switch-calendar_display_colors").click({ force: true });
    expect(mocked.patchRequests()).toBe(0);
  });

  test("requires Full access before a capability PATCH", async ({ page }) => {
    const mocked = await mockCapabilities(page);
    await page.route("**/api/v1/access", async (route) => {
      if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== "/api/v1/access") return route.fallback();
      return route.fulfill({ json: {
        schemaVersion: 1, revision: 1, baseProfile: "standard", effectiveProfile: "standard",
        temporaryFull: false, temporaryFullExpiresAt: null, pinConfigured: true, lockoutUntil: null,
        capabilities: {
          "settings.capabilities.manage": {
            capability: "settings.capabilities.manage", minimumProfile: "full", effectiveProfile: "standard",
            allowed: false, availability: "profile_blocked"
          }
        }
      } });
    });
    await page.goto("/settings");
    await page.getByTestId("settings-summary-capabilities").click();
    await page.getByTestId("capability-switch-calendar_display_colors").click();
    await expect(page.getByText("Для изменения возможностей нужен полный доступ.")).toBeVisible();
    expect(mocked.patchRequests()).toBe(0);
  });
});
