import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const artifacts = process.env.ISSUE_112_B2_CAPABILITIES_ARTIFACT_DIR ?? "artifacts/issue-112-b2-capabilities-review";

type Entry = {
  id: string; label: string; description: string; group: string; technicalFlag: string;
  activeEnabled: boolean; desiredEnabled: boolean; pending: boolean; mutable: boolean;
  behavior: "immediate" | "delayed"; requiredApplyAction: "none" | "restart" | "rebuild";
  operationalBlockedReason: string | null;
};

function entries(): Entry[] {
  return [
    { id: "calendar_display_colors", label: "Изменение цветов календарей", description: "Цвета действуют только внутри панели.", group: "Локальные возможности", technicalFlag: "PANEL_CALENDAR_DISPLAY_COLOR_WRITES_ENABLED", activeEnabled: true, desiredEnabled: true, pending: false, mutable: true, behavior: "immediate", requiredApplyAction: "none", operationalBlockedReason: null },
    { id: "overview_layout_editor", label: "Редактирование главного экрана", description: "Редактор виджетов.", group: "Локальные возможности", technicalFlag: "PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED", activeEnabled: true, desiredEnabled: true, pending: false, mutable: true, behavior: "immediate", requiredApplyAction: "none", operationalBlockedReason: null },
    { id: "planning_calendar_route", label: "Раздел «Календарь»", description: "Доступность раздела календаря.", group: "Планирование", technicalFlag: "VITE_PLANNING_CALENDAR_ROUTE_ENABLED", activeEnabled: true, desiredEnabled: true, pending: false, mutable: true, behavior: "delayed", requiredApplyAction: "rebuild", operationalBlockedReason: null },
    { id: "panel_writes", label: "Запись панели", description: "Главный защитный барьер.", group: "Системные действия", technicalFlag: "PANEL_WRITES_ENABLED", activeEnabled: true, desiredEnabled: true, pending: false, mutable: false, behavior: "immediate", requiredApplyAction: "none", operationalBlockedReason: null }
  ];
}

async function mockCapabilities(page: Page) {
  let revision = 1;
  let capabilities = entries();
  let applySucceeded = false;
  const payload = () => ({ schemaVersion: "capabilities.v1", revision, available: true, writesEnabled: true, warnings: [], entries: capabilities });
  await page.route("**/api/v1/settings/capabilities", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: payload() });
    const request = route.request().postDataJSON() as { expectedRevision: number; capabilityId: string; enabled: boolean | null };
    if (request.expectedRevision !== revision) return route.fulfill({ status: 409, json: { detail: "revision_conflict" } });
    capabilities = capabilities.map((entry) => entry.id !== request.capabilityId ? entry : entry.behavior === "immediate"
      ? { ...entry, activeEnabled: request.enabled ?? true, desiredEnabled: request.enabled ?? true }
      : { ...entry, desiredEnabled: request.enabled ?? true, pending: entry.activeEnabled !== (request.enabled ?? true) });
    revision += 1;
    return route.fulfill({ json: payload() });
  });
  await page.route("**/api/v1/system/runtime/apply-capabilities", async (route) => {
    applySucceeded = true;
    capabilities = capabilities.map((entry) => entry.behavior === "delayed" ? { ...entry, activeEnabled: entry.desiredEnabled, pending: false } : entry);
    return route.fulfill({ status: 202, json: { accepted: true, action: "apply_capabilities" } });
  });
  await page.route("**/api/v1/system/runtime", async (route) => route.fulfill({ json: { enabled: true, capabilityApplyEnabled: true, capabilityApply: { status: applySucceeded ? "success" : "idle" }, platform: "posix" } }));
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

    await page.getByTestId("capability-switch-calendar_display_colors").click();
    await expect(page.getByTestId("capability-calendar_display_colors")).toContainText("Выключено");

    await page.getByTestId("capability-switch-planning_calendar_route").click();
    await expect(page.getByTestId("capability-planning_calendar_route")).toContainText("Сейчас: Включено");
    await expect(page.getByTestId("capability-planning_calendar_route")).toContainText("После применения: Выключено");
    await expect(page.getByTestId("capability-apply-area")).toContainText("Будет выполнена пересборка и перезапуск панели");
    await expect(page.getByRole("button", { name: "Применить изменения" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, "capabilities-pending.png"), animations: "disabled" });
  });
});
