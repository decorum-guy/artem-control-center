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
