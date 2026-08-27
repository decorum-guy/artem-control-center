import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const enabled = process.env.VITE_V2_VISUAL_SHELL === "true" && process.env.B3_PLANNING_CALENDAR_ROUTE_ENABLED === "true";
const artifactDirectory = (testInfo: TestInfo) =>
  process.env.ISSUE_112_B2_CALENDAR_SETTINGS_ARTIFACT_DIR ?? testInfo.outputPath("issue-112-b2-calendar-settings-review");

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const directory = artifactDirectory(testInfo);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), animations: "disabled" });
}

const sources = [{
  id: "icloud-safe", kind: "external", provider: "icloud", label: "iCloud", status: "current", configured: true,
  lastSyncedAt: "2026-08-26T00:00:00Z", observedAt: "2026-08-26T00:00:00Z",
  calendars: [
    { id: "work-a", label: "Рабочий", color: "#A1B2C3", enabled: true, status: "current", lastSyncedAt: null, observedAt: null },
    { id: "work-b", label: "Рабочий", color: "#D4E5F6", enabled: true, status: "current", lastSyncedAt: null, observedAt: null },
    ...Array.from({ length: 11 }, (_, index) => ({ id: `calendar-${index}`, label: `Календарь ${index + 1}`, color: "#A1B2C3", enabled: true, status: "current" as const, lastSyncedAt: null, observedAt: null }))
  ]
}];

const events = [
  { id: "00000000-0000-4000-8000-000000007001", version: 1, source: "calendar-provider", sourceLabel: "iCloud", calendarIdentity: { providerId: "icloud-safe", providerLabel: "iCloud", calendarId: "work-a", calendarLabel: "Рабочий" }, title: "Весь день", notes: null, location: null, allDay: true, timezone: "Europe/Moscow", syncState: "synced", localOnlyMutable: false, startAtUtc: null, endAtUtc: null, startDate: "2026-08-26", endDateExclusive: "2026-08-27", deletedAt: null, createdAt: "2026-08-26T00:00:00Z", updatedAt: "2026-08-26T00:00:00Z" },
  { id: "00000000-0000-4000-8000-000000007002", version: 1, source: "calendar-provider", sourceLabel: "iCloud", calendarIdentity: { providerId: "icloud-safe", providerLabel: "iCloud", calendarId: "work-a", calendarLabel: "Рабочий" }, title: "Встреча", notes: null, location: null, allDay: false, timezone: "Europe/Moscow", syncState: "synced", localOnlyMutable: false, startAtUtc: "2026-08-26T10:00:00Z", endAtUtc: "2026-08-26T11:00:00Z", startDate: null, endDateExclusive: null, deletedAt: null, createdAt: "2026-08-26T00:00:00Z", updatedAt: "2026-08-26T00:00:00Z" }
];

async function install(page: Page, options: { failFirstWrite?: boolean } = {}) {
  let preferences = { schemaVersion: "calendar.display-preferences.v1", revision: 0, updatedAt: "2026-08-26T00:00:00Z", overrides: [] as Array<{ providerId: string; calendarId: string; color: string }>, available: true, warnings: [] as string[], writesEnabled: true };
  let failFirstWrite = options.failFirstWrite === true;
  await page.route("**/api/v1/settings/calendar/display-colors", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: preferences });
    if (failFirstWrite) {
      failFirstWrite = false;
      return route.fulfill({ status: 503, json: { detail: "temporary_unavailable" } });
    }
    const body = route.request().postDataJSON() as { expectedRevision: number; providerId: string; calendarId: string; color: string | null };
    if (body.expectedRevision !== preferences.revision) return route.fulfill({ status: 409, json: { detail: "revision_conflict" } });
    preferences = { ...preferences, revision: preferences.revision + 1, overrides: body.color === null
      ? preferences.overrides.filter((entry) => !(entry.providerId === body.providerId && entry.calendarId === body.calendarId))
      : [...preferences.overrides.filter((entry) => !(entry.providerId === body.providerId && entry.calendarId === body.calendarId)), { providerId: body.providerId, calendarId: body.calendarId, color: body.color.toUpperCase() }] };
    return route.fulfill({ json: preferences });
  });
  await page.route("**/api/v1/planning/calendar-sources/refresh", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({ json: {
      schemaVersion: "planning.calendar-sources.refresh.v1",
      kind: "calendar_sources_refresh",
      result: "success",
      status: "current",
      observedAt: "2026-08-27T09:00:00Z",
      lastSuccessfulSyncAt: "2026-08-27T09:00:00Z",
      calendarsSeen: sources[0].calendars.length,
      eventsSeen: events.length,
      errorCode: null,
      correlation_id: "00000000-0000-4000-8000-000000000097"
    } });
  });
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    const planning = payload.planning as Record<string, unknown>;
    planning.providerStatuses = sources;
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  await page.route("**/api/v1/planning/events**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    Object.assign(payload, { items: events, sources, limit: 100, offset: 0, count: events.length, hasMore: false });
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
}

test.describe("Issue #112 B2.1 Calendar Settings", () => {
  test.skip(!enabled, "Run with the V2 shell and Calendar route enabled.");

  test("shows a scrollable source list, changes one effective colour, survives close/reload, and resets", async ({ page }, testInfo) => {
    await install(page);
    await page.goto("/settings");
    await expect(page.getByTestId("settings-summary-calendars")).toContainText("13 календарей");
    await capture(page, testInfo, "settings-main-calendars.png");
    await page.getByTestId("settings-summary-calendars").click();
    const rows = page.getByTestId("settings-calendar-row");
    await expect(rows).toHaveCount(13);
    await expect(rows.nth(0)).toContainText("Рабочий");
    await expect(rows.nth(1)).toContainText("Рабочий");
    await expect(rows.nth(0).getByTestId("settings-calendar-effective-swatch")).toBeVisible();
    await capture(page, testInfo, "settings-calendar-sheet.png");
    await rows.nth(0).getByRole("button", { name: /Цвет/ }).click();
    await capture(page, testInfo, "settings-calendar-palette.png");
    await page.getByRole("button", { name: "Выбрать #D65A4A" }).click();
    await expect(rows.nth(0).getByTestId("settings-calendar-effective-swatch")).toHaveCSS("background-color", "rgb(214, 90, 74)");
    const body = page.locator(".cc-overlay__body");
    expect(await body.evaluate((node) => node.scrollHeight > node.clientHeight)).toBeTruthy();
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    await page.getByTestId("settings-summary-calendars").click();
    await expect(rows.nth(0).getByTestId("settings-calendar-effective-swatch")).toHaveCSS("background-color", "rgb(214, 90, 74)");
    await page.reload();
    await page.getByTestId("settings-summary-calendars").click();
    await expect(page.getByTestId("settings-calendar-row").nth(0).getByTestId("settings-calendar-effective-swatch")).toHaveCSS("background-color", "rgb(214, 90, 74)");
    await page.getByTestId("settings-calendar-row").nth(0).getByRole("button", { name: /Цвет/ }).click();
    await page.getByRole("button", { name: "Цвет источника" }).click();
    await expect(page.getByTestId("settings-calendar-row").nth(0).getByTestId("settings-calendar-effective-swatch")).toHaveCSS("background-color", "rgb(161, 178, 195)");
  });

  test("applies an override to the month dot and both all-day and timed accents", async ({ page }, testInfo) => {
    await install(page);
    await page.goto("/settings");
    await page.getByTestId("settings-summary-calendars").click();
    await page.getByTestId("settings-calendar-row").nth(0).getByRole("button", { name: /Цвет/ }).click();
    await page.getByRole("button", { name: "Выбрать #D65A4A" }).click();
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    await page.goto("/calendar?date=2026-08-26");
    await expect(page.getByTestId("planning-calendar-month")).toBeVisible();
    await expect(page.locator('[data-date="2026-08-26"]').getByTestId("planning-calendar-event-indicator").first()).toHaveAttribute("data-color", "#D65A4A");
    await expect(page.getByTestId("planning-calendar-event-row").filter({ hasText: "Весь день" })).toHaveCSS("border-left-color", "rgb(214, 90, 74)");
    await expect(page.getByTestId("planning-calendar-event-row").filter({ hasText: "Встреча" })).toHaveCSS("border-left-color", "rgb(214, 90, 74)");
    await capture(page, testInfo, "calendar-override-accents.png");
  });

  test("keeps the confirmed colour and explains a failed save without backend detail", async ({ page }) => {
    await install(page, { failFirstWrite: true });
    await page.goto("/settings");
    await page.getByTestId("settings-summary-calendars").click();
    const first = page.getByTestId("settings-calendar-row").nth(0);
    await first.getByRole("button", { name: /Цвет/ }).click();
    await page.getByRole("button", { name: "Выбрать #D65A4A" }).click();
    await expect(first.getByTestId("settings-calendar-effective-swatch")).toHaveCSS("background-color", "rgb(161, 178, 195)");
    await expect(page.getByRole("status")).toContainText("Не удалось сохранить цвет");
    await expect(page.getByText("temporary_unavailable", { exact: true })).toHaveCount(0);
  });

  test("refreshes source discovery from Settings, suppresses duplicate taps, and reloads metadata", async ({ page }) => {
    const refreshRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/planning/calendar-sources/refresh")) refreshRequests.push(request.method());
    });
    await install(page);
    await page.goto("/settings");
    await page.getByTestId("settings-summary-calendars").click();
    const refresh = page.getByTestId("settings-calendar-refresh");
    await expect(refresh).toHaveText("Обновить список календарей");
    await Promise.all([refresh.dispatchEvent("click"), refresh.dispatchEvent("click")]);
    await expect(refresh).toHaveText("Обновить список календарей");
    await expect(page.getByRole("status")).toContainText("Список календарей обновлён");
    expect(refreshRequests).toEqual(["POST"]);
    await expect(page.getByTestId("settings-calendar-row")).toHaveCount(13);
  });
});
