import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const artifactDirectory = (testInfo: TestInfo) => process.env.ISSUE_112_ARTIFACT_DIR ?? testInfo.outputPath("issue-112-calendar-review");

function event(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    version: 1,
    source: "calendar-provider",
    sourceLabel: "iCloud",
    calendarIdentity: { providerId: "icloud-source", providerLabel: "iCloud", calendarId: "work", calendarLabel: "Работа" },
    title: "Событие календаря",
    notes: null,
    location: null,
    allDay: false,
    timezone: "Europe/Moscow",
    syncState: "synced",
    localOnlyMutable: false,
    startAtUtc: "2026-08-12T10:00:00Z",
    endAtUtc: "2026-08-12T11:00:00Z",
    startDate: null,
    endDateExclusive: null,
    deletedAt: null,
    createdAt: "2026-08-12T09:00:00Z",
    updatedAt: "2026-08-12T09:00:00Z",
    ...overrides
  };
}

const monthEvents = [
  event("00000000-0000-4000-8000-000000001101", {
    source: "panel-agent",
    sourceLabel: "Panel Agent",
    calendarIdentity: { providerId: "native-planning", providerLabel: "Local Planning", calendarId: "local", calendarLabel: "Локальный" },
    title: "Локальный день",
    allDay: true,
    localOnlyMutable: true,
    syncState: "local_only",
    startAtUtc: null,
    endAtUtc: null,
    startDate: "2026-08-12",
    endDateExclusive: "2026-08-13"
  }),
  event("00000000-0000-4000-8000-000000001102", { title: "Рабочая встреча", startAtUtc: "2026-08-12T10:00:00Z", endAtUtc: "2026-08-12T11:00:00Z" }),
  event("00000000-0000-4000-8000-000000001103", { title: "Работа в субботу", startAtUtc: "2026-08-15T08:00:00Z", endAtUtc: "2026-08-15T09:00:00Z", calendarIdentity: { providerId: "icloud-source", providerLabel: "iCloud", calendarId: "work", calendarLabel: "Работа" } }),
  event("00000000-0000-4000-8000-000000001104", { title: "Дом в субботу", startAtUtc: "2026-08-15T10:00:00Z", endAtUtc: "2026-08-15T11:00:00Z", calendarIdentity: { providerId: "icloud-source", providerLabel: "iCloud", calendarId: "home", calendarLabel: "Дом" } }),
  event("00000000-0000-4000-8000-000000001105", { title: "Через полночь", startAtUtc: "2026-08-14T20:00:00Z", endAtUtc: "2026-08-15T01:00:00Z", calendarIdentity: { providerId: "missing-source", providerLabel: "Недоступный источник", calendarId: "missing", calendarLabel: "Без цвета" } })
];

const sources = [
  {
    id: "native-planning", kind: "native", provider: "local", label: "Local Planning", status: "current", configured: true,
    lastSyncedAt: "2026-08-12T09:00:00Z", observedAt: "2026-08-12T09:00:00Z", calendars: []
  },
  {
    id: "icloud-source", kind: "external", provider: "icloud", label: "iCloud", status: "current", configured: true,
    lastSyncedAt: "2026-08-12T09:00:00Z", observedAt: "2026-08-12T09:00:00Z",
    calendars: [
      { id: "work", label: "Работа", color: "#A1B2C3", enabled: true, status: "current", lastSyncedAt: "2026-08-12T09:00:00Z", observedAt: "2026-08-12T09:00:00Z" },
      { id: "home", label: "Дом", color: "#D4E5F6", enabled: true, status: "current", lastSyncedAt: "2026-08-12T09:00:00Z", observedAt: "2026-08-12T09:00:00Z" }
    ]
  }
];

async function installCalendarFixture(page: Page): Promise<string[]> {
  const methods: string[] = [];
  await page.route("**/api/v1/planning/events**", async (route) => {
    methods.push(route.request().method());
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    payload.items = monthEvents;
    payload.limit = 100;
    payload.offset = 0;
    payload.count = monthEvents.length;
    payload.hasMore = false;
    payload.sources = sources;
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  return methods;
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const directory = artifactDirectory(testInfo);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), animations: "disabled" });
}

test.describe("Issue #112 Calendar Slice A", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: "2026-08-12T12:00:00Z" });
  });

  test("renders a real month, selected-day agenda, source colors, safe boundaries, and review screenshots", async ({ page }, testInfo) => {
    const methods = await installCalendarFixture(page);
    await page.goto("/calendar");
    await expect(page.getByTestId("planning-calendar-month")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-month-heading")).toHaveText("Август 2026");
    await expect(page.getByTestId("planning-calendar-month-cell")).toHaveCount(42);

    const today = page.locator('[data-testid="planning-calendar-month-cell"][data-date="2026-08-12"]');
    await expect(today).toHaveAttribute("aria-selected", "true");
    await expect(today).toHaveAttribute("data-current", "true");
    await expect(page.getByTestId("planning-calendar-selected-day-heading")).toContainText("12 августа");
    await capture(page, testInfo, "calendar-populated-current-month.png");

    const emptyDay = page.locator('[data-testid="planning-calendar-month-cell"][data-date="2026-08-13"]');
    await emptyDay.press("Enter");
    await expect(emptyDay).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("planning-calendar-selected-day-heading")).toContainText("13 августа");
    await expect(page.getByTestId("planning-calendar-selected-day-empty")).toHaveText("Нет событий");
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(0);
    await capture(page, testInfo, "calendar-selected-empty-day.png");

    await today.click();
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(2);
    await expect(page.getByTestId("planning-calendar-all-day-band")).toBeVisible();
    await page.getByTestId("planning-calendar-event-row").first().click();
    await expect(page.getByTestId("planning-calendar-detail")).toBeVisible();
    await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Закрыть" }).click();

    const colorDay = page.locator('[data-testid="planning-calendar-month-cell"][data-date="2026-08-15"]');
    await colorDay.click();
    await expect(page.getByTestId("planning-calendar-selected-day-heading")).toContainText("15 августа");
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(3);
    const indicatorColors = await colorDay.getByTestId("planning-calendar-event-indicator").evaluateAll((items) => items.map((item) => item.getAttribute("data-color")));
    expect(new Set(indicatorColors).size).toBe(3);
    const rowColors = await page.getByTestId("planning-calendar-event-row").evaluateAll((items) => items.map((item) => item.getAttribute("style")));
    expect(new Set(rowColors).size).toBe(3);
    await capture(page, testInfo, "calendar-multiple-source-colors.png");

    await page.getByRole("button", { name: "Предыдущий месяц" }).click();
    await expect(page.getByTestId("planning-calendar-month-heading")).toHaveText("Июль 2026");
    await expect(page.locator('[data-testid="planning-calendar-month-cell"][data-date="2026-08-12"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Следующий месяц" }).click();
    await expect(page.getByTestId("planning-calendar-month-heading")).toHaveText("Август 2026");
    await colorDay.click();
    await page.getByRole("button", { name: "Следующий месяц" }).click();
    await expect(page.getByTestId("planning-calendar-month-heading")).toHaveText("Сентябрь 2026");
    await page.getByRole("button", { name: "Сегодня" }).click();
    await expect(page.getByTestId("planning-calendar-month-heading")).toHaveText("Август 2026");
    await expect(page.locator('[data-testid="planning-calendar-month-cell"][data-date="2026-08-12"]')).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-testid="planning-calendar-month-cell"][data-date="2026-08-12"]')).toHaveAttribute("data-current", "true");

    await page.locator('[data-testid="planning-calendar-month-cell"][data-date="2026-08-14"]').click();
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(1);
    await page.locator('[data-testid="planning-calendar-month-cell"][data-date="2026-08-15"]').click();
    await expect(page.getByTestId("planning-calendar-event-row").filter({ hasText: "Через полночь" })).toBeVisible();
    await expect(page.getByTestId("planning-calendar-event-row").filter({ hasText: "Работа в субботу" })).toBeVisible();

    const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width + 1);
    expect(methods.every((method) => method === "GET")).toBe(true);
  });
});
