import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { PlanningSnapshot } from "../../packages/contracts/src/index";
import { planningFixtures } from "../../apps/dashboard/src/planningFixtures";

const b1Enabled = [
  "VITE_V2_VISUAL_SHELL",
  "VITE_OVERVIEW_V2_ENABLED",
  "B3_PLANNING_CALENDAR_ROUTE_ENABLED"
].every((name) => process.env[name] === "true");

const artifactDirectory = (testInfo: TestInfo) =>
  process.env.ISSUE_112_B1_ARTIFACT_DIR ?? path.join(process.cwd(), "artifacts", "issue-112-slice-b1-review");

function calendarEvent(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
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

const b1Events = [
  calendarEvent("00000000-0000-4000-8000-000000002101", {
    title: "Весь день: рабочая сессия",
    allDay: true,
    startAtUtc: null,
    endAtUtc: null,
    startDate: "2026-08-12",
    endDateExclusive: "2026-08-13"
  }),
  calendarEvent("00000000-0000-4000-8000-000000002102", {
    title: "Длинная встреча с содержательным названием для проверки ширины",
    calendarIdentity: { providerId: "icloud-source", providerLabel: "iCloud", calendarId: "home", calendarLabel: "Дом" },
    startAtUtc: "2026-08-12T10:00:00Z",
    endAtUtc: "2026-08-12T11:30:00Z"
  }),
  calendarEvent("00000000-0000-4000-8000-000000002103", {
    title: "Командная встреча",
    calendarIdentity: { providerId: "icloud-source", providerLabel: "iCloud", calendarId: "team", calendarLabel: "Команда" },
    startAtUtc: "2026-08-12T13:00:00Z",
    endAtUtc: "2026-08-12T14:00:00Z"
  })
];

const b1Sources = [
  {
    id: "icloud-source", kind: "external", provider: "icloud", label: "iCloud", status: "current", configured: true,
    lastSyncedAt: "2026-08-12T09:00:00Z", observedAt: "2026-08-12T09:00:00Z",
    calendars: [
      { id: "work", label: "Работа", color: "#E7B64A", enabled: true, status: "current", lastSyncedAt: "2026-08-12T09:00:00Z", observedAt: "2026-08-12T09:00:00Z" },
      { id: "home", label: "Дом", color: "#58A6D8", enabled: true, status: "current", lastSyncedAt: "2026-08-12T09:00:00Z", observedAt: "2026-08-12T09:00:00Z" },
      { id: "team", label: "Команда", color: "#A26BD4", enabled: true, status: "current", lastSyncedAt: "2026-08-12T09:00:00Z", observedAt: "2026-08-12T09:00:00Z" }
    ]
  }
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function installSse(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler = (event: Event) => void;
    type Source = { handlers: Map<string, Handler[]>; addEventListener: (type: string, handler: Handler) => void; close: () => void };
    const sources: Source[] = [];
    class FakeEventSource implements Source {
      handlers = new Map<string, Handler[]>();
      constructor() { sources.push(this); }
      addEventListener(type: string, handler: Handler) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]); }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
    (window as unknown as { emitPlanningSse: (type: string, data: string) => void }).emitPlanningSse = (type, data) => {
      for (const source of sources) for (const handler of source.handlers.get(type) ?? []) handler(new MessageEvent(type, { data }));
    };
  });
}

async function emitRevision(page: Page, revision: number): Promise<void> {
  await page.evaluate((nextRevision) => {
    (window as unknown as { emitPlanningSse: (type: string, data: string) => void }).emitPlanningSse(
      "snapshot",
      JSON.stringify({ revision: nextRevision })
    );
  }, revision);
}

async function installPlanningSnapshot(page: Page, getState: () => { revision: number; status: string }): Promise<void> {
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    const state = getState();
    const planning = clone(planningFixtures.healthy) as PlanningSnapshot;
    planning.sourceStatus = state.status as PlanningSnapshot["sourceStatus"];
    planning.providerStatuses = planning.providerStatuses.map((source) => ({ ...source, status: state.status === "current" ? "current" : "stale" }));
    payload.revision = state.revision;
    payload.planning = planning;
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
}

async function installCalendarFixture(page: Page, getState: () => { status: string }): Promise<{ methods: string[]; reads: () => number }> {
  const methods: string[] = [];
  let readCount = 0;
  await page.route("**/api/v1/planning/events**", async (route) => {
    methods.push(route.request().method());
    if (route.request().method() !== "GET") return route.fallback();
    readCount += 1;
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    payload.items = b1Events;
    payload.limit = 100;
    payload.offset = 0;
    payload.count = b1Events.length;
    payload.hasMore = false;
    payload.sources = b1Sources.map((source) => ({ ...source, status: getState().status === "current" ? "current" : "stale" }));
    payload.sourceStatus = getState().status;
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  return { methods, reads: () => readCount };
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const directory = artifactDirectory(testInfo);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), animations: "disabled" });
}

test.describe("Issue #112 Slice B1 physical polish", () => {
  test.skip(!b1Enabled, "Run with the V2 shell and Calendar route enabled.");

  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: "2026-08-12T12:00:00Z" });
  });

  test("shares event colors, separates all-day semantics, expands without changing selection, and removes healthy implementation copy", async ({ page }, testInfo) => {
    const state = { status: "current" };
    await installSse(page);
    await installPlanningSnapshot(page, () => ({ revision: 1, status: state.status }));
    await installCalendarFixture(page, () => state);
    await page.goto("/calendar");
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(3);

    const selectedHeading = await page.getByTestId("planning-calendar-selected-day-heading").innerText();
    const indicatorColors = await page.locator('[data-date="2026-08-12"]').getByTestId("planning-calendar-event-indicator").evaluateAll((items) => items.map((item) => item.getAttribute("data-color")));
    const cardEvidence = await page.getByTestId("planning-calendar-event-row").evaluateAll((items) => items.map((item) => ({
      color: getComputedStyle(item).borderLeftColor,
      accent: getComputedStyle(item).getPropertyValue("--calendar-event-accent").trim(),
      text: item.textContent ?? ""
    })));
    expect(new Set(cardEvidence.map((item) => item.accent))).toEqual(new Set(indicatorColors));
    expect(cardEvidence.every((item) => item.color !== "rgba(0, 0, 0, 0)" && item.color !== "transparent")).toBe(true);
    expect(cardEvidence.map((item) => item.text).join(" ")).not.toContain("Europe/Moscow");
    expect(cardEvidence.map((item) => item.text).join(" ")).not.toContain("Синхронизация: Синхронизировано");
    expect(cardEvidence.map((item) => item.text).join(" ")).toContain("Дом");

    const allDayBand = page.getByTestId("planning-calendar-all-day-band");
    const allDayRow = allDayBand.getByTestId("planning-calendar-event-row");
    const bandBox = await allDayBand.boundingBox();
    const rowBox = await allDayRow.boundingBox();
    expect((rowBox?.x ?? 0)).toBeGreaterThan((bandBox?.x ?? 0));
    expect(await allDayBand.evaluate((element) => getComputedStyle(element).paddingBottom)).toBe("8px");
    await capture(page, testInfo, "calendar-normal-selected-day.png");
    await capture(page, testInfo, "calendar-all-day-multiple-source-colors.png");

    const normalWidth = (await page.getByTestId("planning-calendar-selected-day").boundingBox())?.width ?? 0;
    await page.getByTestId("planning-calendar-expand").click();
    await expect(page.getByTestId("planning-calendar-month")).toHaveAttribute("data-expanded-day", "true");
    await expect(page.locator(".calendar-month")).toBeHidden();
    await expect(page.getByTestId("planning-calendar-expand")).toHaveText("Свернуть день");
    expect((await page.getByTestId("planning-calendar-selected-day").boundingBox())?.width ?? 0).toBeGreaterThan(normalWidth);
    await expect(page.getByTestId("planning-calendar-selected-day-heading")).toContainText("12 августа");
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(3);
    await capture(page, testInfo, "calendar-expanded-day.png");
    await page.getByTestId("planning-calendar-expand").click();
    await expect(page.locator(".calendar-month")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-selected-day-heading")).toContainText("12 августа");

    const spacing = await page.getByTestId("planning-calendar-selected-day").locator(".calendar-selected-day__events").evaluate((element) => ({
      paddingBottom: getComputedStyle(element).paddingBottom,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    }));
    expect(Number.parseFloat(spacing.paddingBottom)).toBeGreaterThanOrEqual(32);
    expect(spacing.scrollHeight).toBeGreaterThanOrEqual(spacing.clientHeight);
  });

  test("manual refresh is read-only, retains rows, and snapshot revisions do not blank the selected day", async ({ page }) => {
    const state = { revision: 1, status: "current" };
    await installSse(page);
    await installPlanningSnapshot(page, () => state);
    const fixture = await installCalendarFixture(page, () => state);
    let readCount = 0;
    let releaseRefresh: (() => void) | null = null;
    let delayNext = false;
    await page.unroute("**/api/v1/planning/events**");
    await page.route("**/api/v1/planning/events**", async (route) => {
      fixture.methods.push(route.request().method());
      if (route.request().method() !== "GET") return route.fallback();
      readCount += 1;
      if (delayNext) await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      const response = await route.fetch();
      const payload = await response.json() as Record<string, unknown>;
      payload.items = b1Events;
      payload.sources = b1Sources;
      payload.count = b1Events.length;
      payload.limit = 100;
      payload.offset = 0;
      payload.hasMore = false;
      await route.fulfill({ response, body: JSON.stringify(payload) });
    });
    await page.goto("/calendar");
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(3);
    const selectedHeading = await page.getByTestId("planning-calendar-selected-day-heading").innerText();
    delayNext = true;
    await page.getByTestId("planning-calendar-refresh").click();
    await expect(page.getByTestId("planning-calendar-refresh")).toBeDisabled();
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(3);
    await expect(page.getByTestId("planning-calendar-selected-day-heading")).toContainText("12 августа");
    await page.getByTestId("planning-calendar-refresh").click({ force: true });
    expect(fixture.methods.every((method) => method === "GET")).toBe(true);
    releaseRefresh?.();
    await expect(page.getByTestId("planning-calendar-refresh")).toBeEnabled();
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(3);

    state.revision = 2;
    await emitRevision(page, 2);
    await expect.poll(() => readCount).toBeGreaterThan(1);
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(3);
    await expect(page.getByTestId("planning-calendar-selected-day-heading")).toContainText("12 августа");
    state.revision = 3;
    await emitRevision(page, 3);
    await expect.poll(() => readCount).toBeGreaterThan(2);
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(3);
    await expect(page.getByTestId("planning-calendar-selected-day-empty")).toHaveCount(0);
  });

  test("warning dwell suppresses transient degradation and stabilizes recovery", async ({ page }) => {
    const state = { revision: 1, status: "current" };
    await installSse(page);
    await installPlanningSnapshot(page, () => state);
    await installCalendarFixture(page, () => state);
    await page.goto("/calendar");
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(3);

    state.status = "degraded";
    state.revision = 2;
    await emitRevision(page, 2);
    state.status = "current";
    state.revision = 3;
    await emitRevision(page, 3);
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(3);
    await expect(page.getByTestId("planning-route-health")).not.toContainText("Есть проблемы");

    state.status = "degraded";
    state.revision = 4;
    await emitRevision(page, 4);
    await page.clock.fastForward(3_600);
    await expect(page.getByTestId("planning-route-health")).toContainText("Есть проблемы");
    await expect(page.getByTestId("planning-source").first()).toHaveAttribute("data-warning-visible", "true");

    state.status = "current";
    state.revision = 5;
    await emitRevision(page, 5);
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(3);
    await expect(page.getByTestId("planning-route-health")).toContainText("Есть проблемы");
    await page.clock.fastForward(1_900);
    await expect(page.getByTestId("planning-route-health")).toHaveCount(0);
    await expect(page.getByTestId("planning-source").first()).toHaveAttribute("data-warning-visible", "false");
  });

  test("captures Weather, top shell, and both stationary lock glyph states", async ({ page }, testInfo) => {
    await page.goto("/weather");
    await expect(page.getByTestId("weather-daily-zone")).toBeVisible();
    const headingCenters = await page.locator(".weather-days__header--v2 > span").evaluateAll((items) => items.map((item) => {
      const rect = item.getBoundingClientRect();
      return { center: rect.left + rect.width / 2, text: item.textContent?.trim() };
    }));
    const firstRow = await page.locator(".weather-day--v2").first().evaluate((item) => Array.from(item.children).map((child) => {
      const rect = child.getBoundingClientRect();
      return { center: rect.left + rect.width / 2, left: rect.left, right: rect.right };
    }));
    expect(Math.abs(headingCenters[0].center - firstRow[0].center)).toBeLessThanOrEqual(1);
    expect(Math.abs(headingCenters[1].center - ((firstRow[1].left + firstRow[2].right) / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(headingCenters[2].center - firstRow[3].center)).toBeLessThanOrEqual(1);
    expect(Math.abs(headingCenters[3].center - firstRow[4].center)).toBeLessThanOrEqual(1);
    await capture(page, testInfo, "weather-daily-table.png");
    await page.goto("/overview");
    await expect(page.locator(".v2-header-system")).toBeVisible();
    await expect(page.getByTestId("v2-header-access")).toBeVisible();
    await capture(page, testInfo, "global-top-bar.png");
    const control = page.getByTestId("interaction-lock-control");
    await expect(control).toBeVisible();
    await capture(page, testInfo, "lock-unlocked.png");
    const beforeHold = await control.boundingBox();
    await control.hover();
    await page.mouse.down();
    const duringHold = await control.boundingBox();
    expect(duringHold?.width).toBe(beforeHold?.width);
    expect(duringHold?.height).toBe(beforeHold?.height);
    expect(Math.abs((duringHold?.x ?? 0) - (beforeHold?.x ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((duringHold?.y ?? 0) - (beforeHold?.y ?? 0))).toBeLessThanOrEqual(1);
    await page.clock.fastForward(1_100);
    await page.mouse.up();
    await expect(control).toHaveAttribute("aria-pressed", "true");
    await expect(control.locator(".interaction-lock-hint")).toHaveCount(0);
    await capture(page, testInfo, "lock-locked.png");
  });
});
