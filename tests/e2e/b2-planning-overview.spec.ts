import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { PlanningSnapshot } from "@artem/contracts";
import { planningFixtures } from "../../apps/dashboard/src/planningFixtures";

const viewport = { width: 1280, height: 720 };

async function mockPlanning(page: Page, fixture: PlanningSnapshot) {
  await page.unroute("**/api/v1/snapshot**").catch(() => undefined);
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.planning = structuredClone(fixture);
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
}

async function mockCompactOverviewLayout(page: Page) {
  await page.route("**/api/v1/overview/layout*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const payload = await response.json() as { items: Array<Record<string, unknown>> };
    const coffee = payload.items.find((item) => item.instanceId === "fixture.coffee");
    const planning = payload.items.find((item) => item.instanceId === "fixture.planning");
    if (coffee) {
      coffee.sizeVariant = "compact";
      coffee.placement = { x: 0, y: 1, w: 4, h: 3 };
    }
    if (planning) {
      planning.sizeVariant = "compact";
      planning.placement = { x: 4, y: 1, w: 4, h: 3 };
    }
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
}

async function expectInFirstViewport(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.y).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
}

async function expectNoDocumentHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
}

test.describe("B2 Planning Overview", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: "2026-08-12T14:00:00Z" });
  });

  test("required monitoring signals fit the canonical touch viewport", async ({ page }) => {
    await mockPlanning(page, planningFixtures.healthy);
    await page.goto("/overview?theme=day");

    await expect(page.getByTestId("planning-overview-card")).toBeVisible();
    await expectInFirstViewport(page.getByTestId("product-header"));
    await expectInFirstViewport(page.getByRole("heading", { name: "Обзор" }));
    await expectInFirstViewport(page.locator(".coffee-panel__state strong"));
    await expectInFirstViewport(page.locator(".coffee-panel .primary-action"));
    await expectInFirstViewport(page.getByTestId("planning-overview-card").getByRole("heading", { name: "Дела" }));
    await expectInFirstViewport(page.getByTestId("planning-reminder-row"));
    await expectInFirstViewport(page.getByTestId("planning-task-row"));
    await expectInFirstViewport(page.getByTestId("planning-event-row"));

    for (const testId of ["planning-task-row", "planning-event-row"]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(48);
      expect(box?.height).toBeGreaterThanOrEqual(48);
    }

    const smallText = await page.locator(".planning-card .planning-row__label, .planning-card .planning-row__title, .planning-card .planning-row__meta").evaluateAll((elements) => elements.flatMap((element) => {
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      return size < 12 ? [{ text: element.textContent?.trim(), size }] : [];
    }));
    expect(smallText, JSON.stringify(smallText)).toEqual([]);
    await expectNoDocumentHorizontalOverflow(page);

    const header = await page.getByTestId("product-header").boundingBox();
    const card = await page.getByTestId("planning-overview-card").boundingBox();
    expect(header).not.toBeNull();
    expect(card).not.toBeNull();
    expect((card?.y ?? 0) >= ((header?.y ?? 0) + (header?.height ?? 0))).toBeTruthy();
  });

  test("uses the existing canonical projection to show up to three meaningful items by size", async ({ page }) => {
    await mockPlanning(page, planningFixtures.overviewDensity);
    await page.goto("/overview?theme=day");

    const card = page.getByTestId("planning-overview-card");
    await expect(card).toHaveAttribute("data-size-variant", "standard");
    await expect(card).toHaveAttribute("data-visible-item-count", "3");
    await expect(card.getByTestId("planning-reminder-row")).toContainText("Позвонить в сервис");
    await expect(card.getByTestId("planning-task-row")).toContainText("Ранняя задача");
    await expect(card.getByTestId("planning-event-row")).toContainText("Раннее событие");

    const rows = await card.locator(".planning-row").evaluateAll((elements) => elements.map((element) => element.textContent?.trim()));
    expect(rows).toEqual(expect.arrayContaining([expect.stringContaining("Ранняя задача"), expect.stringContaining("Раннее событие")]));

    await mockCompactOverviewLayout(page);
    await page.reload();
    const compactCard = page.getByTestId("planning-overview-card");
    await expect(compactCard).toHaveAttribute("data-size-variant", "compact");
    await expect(compactCard).toHaveAttribute("data-visible-item-count", "2");
    await expect(compactCard.locator(".planning-row")).toHaveCount(2);
    await expect(compactCard.getByTestId("planning-reminder-row")).toContainText("Позвонить в сервис");
    await expect(compactCard.getByTestId("planning-task-row")).toContainText("Ранняя задача");
    await expectNoDocumentHorizontalOverflow(page);
  });

  test("renders the next same-kind items before adding truthful placeholders", async ({ page }) => {
    const repeatedReminders = structuredClone(planningFixtures.overviewDensity);
    const first = repeatedReminders.reminders.upcoming[0];
    repeatedReminders.reminders.upcoming = [
      { ...first, id: "00000000-0000-4000-8000-000000000081", title: "Напоминание 1", dueAtUtc: "2026-08-12T12:10:00Z" },
      { ...first, id: "00000000-0000-4000-8000-000000000082", title: "Напоминание 2", dueAtUtc: "2026-08-12T12:20:00Z" },
      { ...first, id: "00000000-0000-4000-8000-000000000083", title: "Напоминание 3", dueAtUtc: "2026-08-12T12:30:00Z" }
    ];
    repeatedReminders.tasks = { ...repeatedReminders.tasks, overdue: [], upcoming: [] };
    repeatedReminders.calendar = { ...repeatedReminders.calendar, today: [], upcoming: [] };
    await mockPlanning(page, repeatedReminders);
    await page.goto("/overview?theme=day");

    const card = page.getByTestId("planning-overview-card");
    await expect(card).toHaveAttribute("data-visible-item-count", "3");
    await expect(card.getByTestId("planning-reminder-row")).toContainText("Напоминание 1");
    await expect(card.getByTestId("planning-reminder-row-2")).toContainText("Напоминание 2");
    await expect(card.getByTestId("planning-reminder-row-3")).toContainText("Напоминание 3");
    await expect(card.getByTestId("planning-task-row")).toHaveCount(0);
    await expect(card.getByTestId("planning-event-row")).toHaveCount(0);
  });

  test("routes only task and calendar rows, leaving reminders monitoring-only", async ({ page }) => {
    await mockPlanning(page, planningFixtures.healthy);
    await page.goto("/overview");
    expect(await page.getByTestId("planning-reminder-row").evaluate((element) => element.tagName)).toBe("DIV");
    await page.getByTestId("planning-task-row").tap();
    await expect(page.getByTestId("route-tasks")).toBeVisible();
    await page.goto("/overview");
    await page.getByTestId("planning-event-row").tap();
    await expect(page.getByTestId("route-calendar")).toBeVisible();
  });

  test("keeps route geometry stable when the synthetic NoticeCenter stack appears", async ({ page }) => {
    await mockPlanning(page, planningFixtures.healthy);
    await page.goto("/overview?theme=day");
    const before = await page.getByTestId("planning-overview-card").boundingBox();
    expect(before).not.toBeNull();

    await page.goto("/overview?theme=day&b0=triple-notice");
    await expect(page.getByTestId("global-notice-stack")).toBeVisible();
    const after = await page.getByTestId("planning-overview-card").boundingBox();
    expect(after).toMatchObject({
      x: before?.x,
      y: before?.y,
      width: before?.width,
      height: before?.height
    });
    expect(await page.getByTestId("global-notice-stack").evaluate((element) => {
      const style = getComputedStyle(element);
      return { parentIsBody: element.parentElement === document.body, position: style.position };
    })).toEqual({ parentIsBody: true, position: "fixed" });
  });

  test("shows the future event instead of an ended morning event", async ({ page }) => {
    await mockPlanning(page, planningFixtures.endedMorningAndFutureEvening);
    await page.goto("/overview?theme=day");
    const eventRow = page.getByTestId("planning-event-row");
    await expect(eventRow).toContainText("Вечерняя встреча");
    await expect(eventRow).not.toContainText("Утреннее совещание");
  });

  test("shows the source calendar color marker and applies the Control Center override", async ({ page }) => {
    const coloredPlanning = structuredClone(planningFixtures.healthy);
    coloredPlanning.providerStatuses = [{
      ...coloredPlanning.providerStatuses[0],
      id: "calendar-provider",
      calendars: [{
        id: "primary",
        label: "Основной календарь",
        color: "#A1B2C3",
        enabled: true,
        status: "current",
        lastSyncedAt: null,
        observedAt: null
      }]
    }];
    let overrides: Array<{ providerId: string; calendarId: string; color: string }> = [];
    await page.route("**/api/v1/settings/calendar/display-colors", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: "calendar.display-preferences.v1",
          revision: overrides.length,
          updatedAt: "2026-08-12T12:00:00Z",
          overrides,
          available: true,
          warnings: [],
          writesEnabled: false
        })
      });
    });
    await mockPlanning(page, coloredPlanning);
    await page.goto("/overview?theme=day");

    const marker = page.getByTestId("planning-overview-calendar-marker");
    await expect(marker).toHaveAttribute("data-color", "#A1B2C3");
    await expect(marker).toHaveCSS("background-color", "rgb(161, 178, 195)");
    const rowGeometry = await page.getByTestId("planning-event-row").evaluate((element) => ({
      row: element.getBoundingClientRect().toJSON(),
      copy: element.querySelector(".planning-row__copy")?.getBoundingClientRect().toJSON(),
      marker: element.querySelector("[data-testid='planning-overview-calendar-marker']")?.getBoundingClientRect().toJSON()
    }));
    expect(rowGeometry.marker?.width).toBe(4);
    expect(rowGeometry.marker?.height).toBeLessThan(rowGeometry.row.height);
    expect(rowGeometry.copy?.left).toBeGreaterThan(rowGeometry.row.left + 8);

    overrides = [{ providerId: "calendar-provider", calendarId: "primary", color: "#D65A4A" }];
    await page.reload();
    await expect(page.getByTestId("planning-overview-calendar-marker")).toHaveAttribute("data-color", "#D65A4A");
    await expect(page.getByTestId("planning-overview-calendar-marker")).toHaveCSS("background-color", "rgb(214, 90, 74)");
  });

  test("orders upcoming events by local day before all-day type", async ({ page }) => {
    await mockPlanning(page, planningFixtures.upcomingTimedBeforeLaterAllDay);
    await page.goto("/overview?theme=day");
    const eventRow = page.getByTestId("planning-event-row");
    await expect(eventRow).toContainText("Завтрашняя timed-встреча");
    await expect(eventRow).not.toContainText("Поздний день без времени");
  });

  test("supports day/night themes and all motion modes without losing signals", async ({ page }) => {
    for (const theme of ["day", "night"]) {
      for (const motion of ["full", "reduced", "low-performance", "battery-saving"]) {
        await mockPlanning(page, planningFixtures.healthy);
        await page.goto(`/overview?theme=${theme}&motion=${motion}`);
        await expect(page.getByTestId("planning-overview-card")).toBeVisible();
        await expect(page.getByTestId("planning-reminder-row")).toBeVisible();
        await expect(page.getByTestId("planning-task-row")).toBeVisible();
        await expect(page.getByTestId("planning-event-row")).toBeVisible();
        await expectNoDocumentHorizontalOverflow(page);
        if (motion !== "full") {
          const coffeeAnimations = await page.locator(".coffee-activity i").evaluateAll((elements) => elements.map((element) => getComputedStyle(element).animationName));
          expect(coffeeAnimations.every((animation) => animation === "none")).toBeTruthy();
        }
      }
    }
  });

  test("shows truthful current, empty, degraded, stale, and offline states", async ({ page }) => {
    const cases: Array<[string, PlanningSnapshot, string]> = [
      ["current", planningFixtures.healthy, "current"],
      ["empty", planningFixtures.empty, "current"],
      ["degraded", planningFixtures.degraded, "degraded"],
      ["stale", planningFixtures.stale, "stale"],
      ["offline", planningFixtures.offlineWithLastGoodItems, "offline"],
      ["offline-empty", planningFixtures.offlineEmpty, "offline"]
    ];

    for (const [label, fixture, state] of cases) {
      await mockPlanning(page, fixture);
      await page.goto(`/overview?planningState=${label}`);
      const card = page.getByTestId("planning-overview-card");
      await expect(card).toHaveAttribute("data-state", state);
      if (state === "current" && label === "current") {
        await expect(card.locator(".planning-card__health")).toHaveCount(0);
      }
      if (label === "empty") {
        await expect(page.getByTestId("planning-reminder-row")).toContainText("Напоминаний нет");
        await expect(page.getByTestId("planning-task-row")).toContainText("Нет просроченных задач");
        await expect(page.getByTestId("planning-event-row")).toContainText("Событий нет");
      }
      if (label === "degraded") await expect(card).toContainText("Есть проблемы");
      if (label === "stale") {
        await expect(card).toContainText("Данные могут быть устаревшими");
        await expect(card).not.toContainText("через");
      }
      if (label === "offline") {
        await expect(card).toContainText("Данные недоступны");
        await expect(card).not.toContainText("через");
      }
      if (label === "offline-empty") {
        await expect(card).toContainText("Данные недоступны");
        await expect(card).not.toContainText("Напоминаний нет");
      }
    }
  });

  test("collapses an unavailable Calendar domain once while retaining healthy Overview rows", async ({ page }) => {
    const baseEvent = planningFixtures.overviewDensity.calendar.upcoming[0];
    const planning = {
      ...planningFixtures.overviewDensity,
      sourceStatus: "degraded" as const,
      calendar: {
        ...planningFixtures.overviewDensity.calendar,
        upcoming: [
          { ...baseEvent, id: "00000000-0000-4000-8000-000000159401", title: "CAL_EVENT_A_159A4B", startAtUtc: "2026-08-12T12:50:00Z", endAtUtc: "2026-08-12T13:50:00Z" },
          { ...baseEvent, id: "00000000-0000-4000-8000-000000159402", title: "CAL_EVENT_B_159A4B", startAtUtc: "2026-08-12T13:00:00Z", endAtUtc: "2026-08-12T14:00:00Z" },
          { ...baseEvent, id: "00000000-0000-4000-8000-000000159403", title: "CAL_EVENT_C_159A4B", startAtUtc: "2026-08-12T13:10:00Z", endAtUtc: "2026-08-12T14:10:00Z" }
        ]
      },
      health: {
        lastAttemptedAt: "2026-08-12T12:00:00Z",
        lastSuccessfulAt: "2026-08-12T11:59:00Z",
        consecutiveFailures: 3,
        issues: [],
        domains: [
          { domain: "reminders" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: "2026-08-12T11:59:00Z" },
          { domain: "tasks" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: "2026-08-12T11:59:00Z" },
          { domain: "calendar" as const, status: "unavailable" as const, consecutiveFailures: 3, lastAttemptedAt: "2026-08-12T12:00:00Z", lastSuccessfulAt: "2026-08-12T11:59:00Z" },
          { domain: "projects" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: "2026-08-12T11:59:00Z" }
        ]
      }
    };
    await mockPlanning(page, planning);
    await page.goto("/overview?theme=day");

    const card = page.getByTestId("planning-overview-card");
    const statusRow = page.getByTestId("planning-calendar-status-row");
    await expect(statusRow).toHaveCount(1);
    await expect(statusRow).toContainText("Календарь");
    await expect(statusRow).toContainText("Данные недоступны");
    await expect(card.getByText("Данные недоступны", { exact: true })).toHaveCount(1);
    await expect(card).not.toContainText("CAL_EVENT_A_159A4B");
    await expect(card).not.toContainText("CAL_EVENT_B_159A4B");
    await expect(card).not.toContainText("CAL_EVENT_C_159A4B");
    await expect(card).toContainText("Позвонить в сервис");
    await expect(card).toContainText("Ранняя задача");
    await expect(statusRow.locator(".planning-row__source-marker")).toHaveCount(0);
    await expectNoDocumentHorizontalOverflow(page);
  });

  test("keeps a stale retained Calendar event title and safe calendar label", async ({ page }) => {
    const event = planningFixtures.overviewDensity.calendar.upcoming[0];
    const planning = {
      ...planningFixtures.empty,
      sourceStatus: "stale" as const,
      calendar: {
        ...planningFixtures.empty.calendar,
        upcoming: [{ ...event, id: "00000000-0000-4000-8000-000000159404", title: "Сохранённая встреча 159A4B", calendarIdentity: { ...event.calendarIdentity!, calendarLabel: "Команда" } }]
      },
      health: {
        lastAttemptedAt: "2026-08-12T12:00:00Z",
        lastSuccessfulAt: "2026-08-12T11:59:00Z",
        consecutiveFailures: 2,
        issues: [],
        domains: [
          { domain: "reminders" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: "2026-08-12T11:59:00Z" },
          { domain: "tasks" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: "2026-08-12T11:59:00Z" },
          { domain: "calendar" as const, status: "stale" as const, consecutiveFailures: 2, lastAttemptedAt: "2026-08-12T12:00:00Z", lastSuccessfulAt: "2026-08-12T11:59:00Z" },
          { domain: "projects" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: "2026-08-12T11:59:00Z" }
        ]
      }
    };
    await mockPlanning(page, planning);
    await page.goto("/overview?theme=day");
    const eventRow = page.getByTestId("planning-event-row");
    await expect(eventRow).toContainText("Сохранённая встреча 159A4B");
    await expect(eventRow).toContainText("Команда");
    await expect(eventRow).toHaveAttribute("data-planning-state", "stale");
    await expect(eventRow).not.toContainText("Данные недоступны");
  });

  test("uses server-owned domain evidence in the Planning problem details", async ({ page }) => {
    const planning = {
      ...planningFixtures.healthy,
      sourceStatus: "degraded" as const,
      health: {
        lastAttemptedAt: "2026-08-25T12:00:00Z",
        lastSuccessfulAt: "2026-08-25T11:59:00Z",
        consecutiveFailures: 2,
        issues: [{
          source: "tasks" as const,
          status: "degraded" as const,
          consecutiveFailures: 2,
          lastAttemptedAt: "2026-08-25T12:00:00Z",
          lastSuccessfulAt: "2026-08-25T11:59:00Z"
        }],
        domains: []
      }
    };
    await mockPlanning(page, planning);
    await page.goto("/overview?theme=day");
    await page.getByTestId("planning-overview-health-action").click();
    const details = page.getByTestId("planning-overview-health-details");
    await expect(details).toContainText("Задачи");
    await expect(details).toContainText("Не удалось обновить данные");
    await expect(details).not.toContainText("конкретный источник определить не удалось");
  });

  test("long Russian titles remain inert, clamped, and separated from metadata", async ({ page }) => {
    await mockPlanning(page, planningFixtures.longRussianTitles);
    await page.goto("/overview?theme=day");
    await expect(page.getByTestId("planning-overview-card")).toBeVisible();
    await expectNoDocumentHorizontalOverflow(page);

    const rows = await page.locator(".planning-row").evaluateAll((elements) => elements.map((element) => {
      const copy = element.querySelector<HTMLElement>(".planning-row__copy")?.getBoundingClientRect();
      const meta = element.querySelector<HTMLElement>(".planning-row__meta")?.getBoundingClientRect();
      return { copy, meta, text: element.textContent ?? "" };
    }));
    for (const row of rows) {
      if (row.copy && row.meta) expect(row.copy.right).toBeLessThanOrEqual(row.meta.left + 1);
    }
    const inertText = page.getByText("https://example.com light.turn_on /etc/passwd", { exact: false });
    await expect(inertText).toBeVisible();
    expect(await inertText.evaluate((element) => element.closest("a,button")?.getAttribute("href") ?? null)).toBeNull();
  });

  test("semantic SSE replacement updates one monitoring row without duplicates", async ({ page }) => {
    await page.addInitScript(() => {
      type Handler = (event: Event) => void;
      const sources: Array<{ handlers: Map<string, Handler[]>; close: () => void }> = [];
      class FakeEventSource {
        handlers = new Map<string, Handler[]>();
        constructor() {
          sources.push(this);
        }
        addEventListener(type: string, handler: Handler) {
          this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
        }
        close() {}
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
      (window as unknown as { emitPlanningSse: (type: string, data: string) => void }).emitPlanningSse = (type, data) => {
        for (const source of sources) {
          for (const handler of source.handlers.get(type) ?? []) handler(new MessageEvent(type, { data }));
        }
      };
    });

    let snapshotFetches = 0;
    await page.route("**/api/v1/snapshot**", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.planning = structuredClone(snapshotFetches < 2 ? planningFixtures.sseBefore : planningFixtures.sseAfter);
      snapshotFetches += 1;
      await route.fulfill({ response, body: JSON.stringify(payload) });
    });
    await page.goto("/overview");
    await expect(page.getByTestId("planning-reminder-row")).toContainText("Позвонить в сервис");
    await page.evaluate(() => (window as unknown as { emitPlanningSse: (type: string, data: string) => void }).emitPlanningSse("snapshot", JSON.stringify({ revision: 2 })));
    await expect(page.getByTestId("planning-reminder-row")).toContainText("Обновлённое напоминание");
    await expect(page.getByTestId("planning-reminder-row")).toHaveCount(1);
    expect(snapshotFetches).toBeGreaterThanOrEqual(2);
  });

  test("captures canonical B2 review screenshots", async ({ page }, testInfo) => {
    const artifactDir = process.env.B2_ARTIFACT_DIR ?? testInfo.outputPath("b2-artifacts");
    await mkdir(artifactDir, { recursive: true });
    for (const [name, fixture] of [["overview-day", planningFixtures.healthy], ["overview-night", planningFixtures.healthy], ["overview-stale", planningFixtures.stale]] as const) {
      await mockPlanning(page, fixture);
      const theme = name.includes("night") ? "night" : "day";
      await page.goto(`/overview?theme=${theme}`);
      await expect(page.getByTestId("planning-overview-card")).toBeVisible();
      await page.screenshot({ path: path.join(artifactDir, `${name}.png`), animations: "disabled" });
    }
  });
});
