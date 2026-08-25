import { mkdir } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { PlanningSnapshot } from "../../packages/contracts/src/index";
import { planningFixtures } from "../../apps/dashboard/src/planningFixtures";

const technicalCopy = [
  /Planning read API/i,
  /browser-safe/i,
  /\bcanonical\b/i,
  /\bschema\b/i,
  /\bprojection\b/i,
  /\bendpoint\b/i,
  /\bcontract\b/i,
  /\bsnapshot\b/i,
  /контракт/i,
  /снимок/i,
  /канонич/i,
  /эндпоинт/i
];

const calendarEventsRoute = new RegExp("/api/v1/planning/events(?:/[^/?]+)?(?:\\?.*)?$");
const reminderListRoute = new RegExp("/api/v1/planning/reminders(?:/[^/?]+)?(?:\\?.*)?$");

const artifactDirectory = (testInfo: TestInfo) =>
  process.env.ISSUE_116_ARTIFACT_DIR ?? testInfo.outputPath("issue-116-owner-copy-review");

async function installSse(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler = (event: Event) => void;
    type Source = {
      handlers: Map<string, Handler[]>;
      addEventListener: (type: string, handler: Handler) => void;
      close: () => void;
    };
    const sources: Source[] = [];
    class FakeEventSource implements Source {
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
        for (const handler of source.handlers.get(type) ?? []) {
          handler(new MessageEvent(type, { data }));
        }
      }
    };
  });
}

async function installPlanningSnapshot(page: Page, planning: PlanningSnapshot | null): Promise<{ setRevision: (revision: number) => void }> {
  let revision = 1;
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    payload.revision = revision;
    payload.planning = planning;
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  return { setRevision: (nextRevision: number) => { revision = nextRevision; } };
}

async function preparePlanningPage(page: Page, planning: PlanningSnapshot | null = planningFixtures.healthy): Promise<{ setRevision: (revision: number) => void }> {
  await page.clock.install({ time: "2026-08-12T12:00:00Z" });
  await installSse(page);
  return installPlanningSnapshot(page, planning);
}

async function expectPlainOwnerCopy(page: Page, testId: string): Promise<void> {
  const surface = page.getByTestId(testId);
  await expect(surface).toBeVisible();
  const text = await page.locator("main").innerText();
  for (const phrase of technicalCopy) {
    expect(text).not.toMatch(phrase);
  }
}

function calendarEventsPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const event = planningFixtures.healthy.calendar.today[0];
  return {
    schemaVersion: "planning.panel.v1",
    kind: "list",
    domain: "calendar_event",
    generatedAt: "2026-08-12T12:00:00Z",
    sourceStatus: "current",
    lastSyncedAt: "2026-08-12T11:59:00Z",
    staleAfter: "2026-08-12T12:05:00Z",
    items: event ? [event] : [],
    limit: 100,
    offset: 0,
    count: event ? 1 : 0,
    hasMore: false,
    ...overrides
  };
}

async function installCalendarResponse(page: Page, mutate?: (payload: Record<string, unknown>) => void): Promise<void> {
  await page.route(calendarEventsRoute, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const payload = calendarEventsPayload();
    mutate?.(payload);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
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

test.describe("Issue #116 owner-facing copy", () => {
  test.beforeEach(() => {
    const environment = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    test.skip(
      environment.VITE_V2_VISUAL_SHELL !== "true"
        || environment.VITE_OVERVIEW_V2_ENABLED !== "true"
        || environment.B3_PLANNING_TASKS_ROUTE_ENABLED !== "true"
        || environment.B3_PLANNING_CALENDAR_ROUTE_ENABLED !== "true"
        || environment.B3_PLANNING_REMINDERS_ROUTE_ENABLED !== "true",
      "run with V2 Overview and all Planning routes enabled"
    );
  });

  test("healthy owner surfaces contain no implementation-facing explanations and capture review frames", async ({ page }, testInfo) => {
    const directory = artifactDirectory(testInfo);
    await mkdir(directory, { recursive: true });
    const surfaces = [
      ["/overview", "route-overview-v2", "overview-healthy.png"],
      ["/calendar", "route-calendar", "calendar-healthy.png"],
      ["/tasks", "route-tasks", "tasks-healthy.png"],
      ["/reminders", "route-reminders", "reminders-healthy.png"],
      ["/settings", "route-settings", "settings-healthy.png"],
      ["/system", "route-system", "system-healthy.png"]
    ] as const;

    await page.clock.install({ time: "2026-08-12T12:00:00Z" });
    await installCalendarResponse(page);
    for (const [path, testId, filename] of surfaces) {
      await page.goto(path);
      await expectPlainOwnerCopy(page, testId);
      await page.screenshot({ path: `${directory}/${filename}`, animations: "disabled" });
    }
  });

  test("retained data after refresh failure uses plain truthful copy", async ({ page }, testInfo) => {
    await mkdir(artifactDirectory(testInfo), { recursive: true });
    const { setRevision } = await preparePlanningPage(page);
    let reads = 0;
    await page.route(calendarEventsRoute, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      reads += 1;
      if (reads >= 3) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "unavailable" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(calendarEventsPayload()) });
    });

    await page.goto("/calendar");
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(1);
    setRevision(2);
    await emitRevision(page, 2);
    await expect.poll(() => reads).toBeGreaterThan(2);
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(1);
    await expect(page.getByTestId("planning-route-health")).toContainText("Не удалось обновить данные");
    await expect(page.getByTestId("planning-route-health")).toContainText("Показаны последние доступные данные");
    await expect(page.getByTestId("planning-route-error")).toHaveCount(0);
    await expectPlainOwnerCopy(page, "route-calendar");
    await page.screenshot({ path: `${artifactDirectory(testInfo)}/calendar-refresh-failed.png`, animations: "disabled" });
  });

  test("hard failure without retained content does not claim data remains visible", async ({ page }) => {
    await preparePlanningPage(page, null);
    await page.route(calendarEventsRoute, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "unavailable" }) });
    });

    await page.goto("/calendar");
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-error")).toBeVisible();
    await expect(page.getByTestId("planning-route-health")).toContainText("Данные недоступны");
    await expect(page.getByTestId("planning-route-health")).not.toContainText("Показаны последние доступные данные");
    await expectPlainOwnerCopy(page, "route-calendar");
  });

  test("query identity failure clears old rows and keeps fatal copy truthful", async ({ page }) => {
    await preparePlanningPage(page, null);
    let reads = 0;
    await page.route(calendarEventsRoute, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      reads += 1;
      if (reads >= 3) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "unavailable" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(calendarEventsPayload()) });
    });

    await page.goto("/calendar");
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(1);
    await page.getByRole("button", { name: "Предыдущий месяц" }).click();
    await expect.poll(() => reads).toBeGreaterThan(2);
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-error")).toBeVisible();
    await expect(page.getByTestId("planning-route-health")).toContainText("Данные недоступны");
    await expect(page.getByTestId("planning-route-health")).not.toContainText("Показаны последние доступные данные");
  });

  test("stale, partial fallback, empty, and access states stay plain and truthful", async ({ page }) => {
    await preparePlanningPage(page);
    await installCalendarResponse(page, (payload) => { payload.sourceStatus = "stale"; });
    await page.goto("/calendar");
    await expect(page.getByTestId("planning-route-health")).toContainText("Данные могут быть устаревшими");
    await expectPlainOwnerCopy(page, "route-calendar");

    await page.unroute(calendarEventsRoute);
    await installCalendarResponse(page, (payload) => {
      payload.items = [];
      payload.count = 0;
      payload.hasMore = false;
    });
    await page.goto("/calendar");
    await expect(page.getByTestId("planning-calendar-selected-day-empty")).toContainText("Нет событий");
    await expectPlainOwnerCopy(page, "route-calendar");

    await page.route(reminderListRoute, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "unavailable" }) });
    });
    await page.goto("/reminders");
    await expect(page.getByTestId("planning-route-health")).toContainText("Последние доступные данные");
    await expect(page.getByTestId("planning-route-health")).toContainText("могут быть неполными");
    await expect(page.getByTestId("planning-reminder-route-row")).toHaveCount(1);
    await expectPlainOwnerCopy(page, "route-reminders");

    await page.route("**/api/v1/access", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          baseProfile: "read_only",
          effectiveProfile: "read_only",
          temporaryFull: false,
          temporaryFullExpiresAt: null,
          confirmationPolicy: { actionConfirmationRequired: true, mode: "profile_default" },
          pinConfigured: true,
          lockoutUntil: null,
          capabilities: {}
        })
      });
    });
    await page.goto("/settings");
    await page.getByTestId("settings-summary-access").click();
    await expect(page.getByTestId("settings-access-sheet")).toContainText("Только чтение");
    await expectPlainOwnerCopy(page, "route-settings");
  });
});
