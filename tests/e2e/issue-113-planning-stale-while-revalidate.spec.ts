import { expect, test, type Page } from "@playwright/test";
import type { PlanningSnapshot } from "../../packages/contracts/src/index";
import { planningFixtures } from "../../apps/dashboard/src/planningFixtures";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

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

async function emitRevision(page: Page, revision: number): Promise<void> {
  await page.evaluate((nextRevision) => {
    (window as unknown as { emitPlanningSse: (type: string, data: string) => void }).emitPlanningSse(
      "snapshot",
      JSON.stringify({ revision: nextRevision })
    );
  }, revision);
}

async function installSnapshot(page: Page, planning: PlanningSnapshot | null): Promise<{ setRevision: (revision: number) => void }> {
  let revision = 1;
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    payload.revision = revision;
    payload.planning = planning ? clone(planning) : null;
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  return { setRevision: (nextRevision) => { revision = nextRevision; } };
}

async function installAccessFixtures(page: Page): Promise<void> {
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
        pinConfigured: true,
        lockoutUntil: null,
        capabilities: {}
      })
    });
  });
}

async function preparePage(page: Page, planning: PlanningSnapshot | null = planningFixtures.empty): Promise<{ setRevision: (revision: number) => void }> {
  await page.clock.install({ time: "2026-08-12T12:00:00Z" });
  await installSse(page);
  await installAccessFixtures(page);
  return installSnapshot(page, planning);
}

function listItems(payload: Record<string, unknown>): Record<string, unknown>[] {
  const items = payload.items;
  if (!Array.isArray(items) || items.length === 0 || !items.every((item) => item && typeof item === "object")) {
    throw new Error("Issue #113 fixture requires at least one canonical list item");
  }
  return items as Record<string, unknown>[];
}

async function fulfillList(route: Parameters<Parameters<Page["route"]>[1]>[0], titles: string[], idStart: number, hasMore = false): Promise<void> {
  const response = await route.fetch();
  const payload = await response.json() as Record<string, unknown>;
  const template = listItems(payload)[0];
  payload.items = titles.map((title, index) => ({
    ...template,
    id: `00000000-0000-4000-8000-${String(idStart + index).padStart(12, "0")}`,
    title
  }));
  payload.count = titles.length;
  payload.offset = Number(new URL(route.request().url()).searchParams.get("offset") ?? "0");
  payload.hasMore = hasMore;
  await route.fulfill({ response, body: JSON.stringify(payload) });
}

async function installCalendarRead(
  page: Page,
  options: { delayView?: "agenda"; delayNextRequest?: boolean; failInitial?: boolean; failSecond?: boolean; failView?: "agenda"; empty?: boolean } = {}
): Promise<{ requests: number; backgroundReads: number; methods: string[]; release: Deferred; fromValues: string[] }> {
  let requestCount = 0;
  let backgroundReads = 0;
  let initialMonthResponse = false;
  let requestMethods: string[] = [];
  const fromValues: string[] = [];
  let template: Record<string, unknown> | null = null;
  const release = deferred();
  await page.route("**/api/v1/planning/events**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    requestCount += 1;
    requestMethods.push(request.method());
    const url = new URL(request.url());
    fromValues.push(url.searchParams.get("from") ?? "");
    const view = url.searchParams.get("view");
    const offset = url.searchParams.get("offset") ?? "0";
    const isMonthStart = !view && offset === "0";
    const isBackgroundMonthRead = isMonthStart && initialMonthResponse;
    if (isBackgroundMonthRead) backgroundReads += 1;
    if ((options.delayView && (view === options.delayView || isBackgroundMonthRead)) || (options.delayNextRequest && isBackgroundMonthRead)) {
      await release.promise;
    }
    if (options.failInitial && requestCount <= 2) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "planning_read_unavailable" }) });
      return;
    }
    if (options.failView && (view === options.failView || isBackgroundMonthRead)) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "planning_read_unavailable" }) });
      return;
    }
    if (options.failSecond && isBackgroundMonthRead && backgroundReads === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "planning_read_unavailable" }) });
      return;
    }
    if (options.empty) {
      const response = await route.fetch();
      const payload = await response.json() as Record<string, unknown>;
      payload.items = [];
      payload.count = 0;
      payload.offset = Number(url.searchParams.get("offset") ?? "0");
      payload.hasMore = false;
      if (isMonthStart && !isBackgroundMonthRead) initialMonthResponse = true;
      await route.fulfill({ response, body: JSON.stringify(payload) });
      return;
    }
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    if (!template) template = listItems(payload)[0];
    const prefix = backgroundReads === 0 ? "Старое событие" : backgroundReads === 1 ? "Свежее событие" : "Событие после повтора";
    payload.items = [1, 2].map((index) => ({
      ...template,
      id: `00000000-0000-4000-8000-${String(900 + index).padStart(12, "0")}`,
      title: `${prefix} ${index}`
    }));
    payload.count = 2;
    payload.offset = Number(url.searchParams.get("offset") ?? "0");
    payload.hasMore = false;
    if (isMonthStart && !isBackgroundMonthRead) initialMonthResponse = true;
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  return {
    get requests() { return requestCount; },
    get backgroundReads() { return backgroundReads; },
    get methods() { return requestMethods; },
    release,
    get fromValues() { return fromValues; }
  };
}

async function installTaskRead(page: Page, options: { delayView?: "overdue"; delaySecond?: boolean; hasMore?: boolean } = {}): Promise<{ requests: number; release: Deferred; startBackground: () => void; backgroundReads: number; getTemplate: () => Record<string, unknown> | null }> {
  let requestCount = 0;
  let template: Record<string, unknown> | null = null;
  const release = deferred();
  let backgroundMode = false;
  let backgroundReads = 0;
  await page.route("**/api/v1/planning/tasks**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    requestCount += 1;
    const url = new URL(route.request().url());
    const view = url.searchParams.get("view");
    if (options.delaySecond && backgroundMode && backgroundReads === 0) {
      backgroundReads += 1;
      await release.promise;
    } else if (options.delayView && view === options.delayView) {
      await release.promise;
    }
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    template ??= listItems(payload)[0];
    const items = options.delayView && view === options.delayView
      ? ["Новая задача 1", "Новая задача 2"]
      : (options.delaySecond ? !backgroundMode : requestCount <= 2) ? ["Старая задача 1", "Старая задача 2"] : ["Новая задача 1", "Новая задача 2"];
    payload.items = items.map((title, index) => ({
      ...template,
      id: `00000000-0000-4000-8000-${String(910 + index).padStart(12, "0")}`,
      title
    }));
    payload.count = items.length;
    payload.offset = Number(url.searchParams.get("offset") ?? "0");
    payload.hasMore = options.hasMore ?? false;
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  return { get requests() { return requestCount; }, release, startBackground: () => { backgroundMode = true; }, get backgroundReads() { return backgroundReads; }, getTemplate: () => template };
}

function nativeReminders(title: string) {
  return {
    status: "fresh", observedAt: "2026-11-24T05:00:00Z", canCreate: true, canReschedule: true,
    items: [{ id: "fixture", title, dueAt: "2026-11-25T14:00:00Z", timezone: "Europe/Moscow", repeats: false }]
  };
}

function refreshNativeReminders(page: Page) {
  return page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

test.describe("Issue #113 planning stale-while-revalidate", () => {
  test.beforeEach(() => {
    const environment = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    test.skip(
      environment.B3_PLANNING_TASKS_ROUTE_ENABLED !== "true"
        || environment.B3_PLANNING_CALENDAR_ROUTE_ENABLED !== "true"
        || environment.B3_PLANNING_REMINDERS_ROUTE_ENABLED !== "true",
      "run with all Planning routes enabled"
    );
  });

  test("Calendar keeps the populated month grid mounted during a delayed snapshot refresh and atomically accepts fresh rows", async ({ page }) => {
    const { setRevision } = await preparePage(page);
    const calendar = await installCalendarRead(page, { delayNextRequest: true });
    await page.goto("/calendar");
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(2);
    const before = await page.locator(".planning-route-workzone").boundingBox();

    setRevision(2);
    await emitRevision(page, 2);
    await expect.poll(() => calendar.backgroundReads).toBe(1);
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(2);
    await expect(page.getByText("Старое событие 1")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-month")).toBeVisible();
    await expect(page.getByTestId("planning-route-loading")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-health")).toHaveCount(0);
    const during = await page.locator(".planning-route-workzone").boundingBox();
    expect(during?.height).toBeGreaterThanOrEqual((before?.height ?? 1) * 0.9);

    calendar.release.resolve();
    await expect(page.getByText("Свежее событие 1").first()).toBeVisible();
    await expect(page.getByTestId("planning-route-loading")).toHaveCount(0);
    await expect(page.getByText("Старое событие 1")).toHaveCount(0);
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(2);
  });

  test("Calendar background failure preserves populated rows, exposes health, and retry remains GET-only", async ({ page }) => {
    const { setRevision } = await preparePage(page);
    const calendar = await installCalendarRead(page, { failSecond: true });
    await page.goto("/calendar");
    await expect(page.getByText("Старое событие 1")).toBeVisible();

    setRevision(2);
    await emitRevision(page, 2);
    await expect.poll(() => calendar.backgroundReads).toBe(1);
    await expect(page.getByText("Старое событие 1")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(2);
    await page.clock.fastForward(3_600);
    await expect(page.getByTestId("planning-route-health")).toContainText("Не удалось обновить данные");
    await expect(page.getByTestId("planning-route-health")).toContainText("Показаны последние доступные данные");
    await expect(page.getByTestId("planning-route-error")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-empty")).toHaveCount(0);

    const methods: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/planning/events") && request.method() !== "OPTIONS") methods.push(request.method());
    });
    await page.getByTestId("planning-route-health").getByRole("button", { name: "Повторить" }).click();
    await expect(page.getByText("Событие после повтора 1")).toBeVisible();
    expect(methods).toEqual(["GET"]);
  });

  test("Calendar first-load failure does not claim retained confirmed content", async ({ page }) => {
    await preparePage(page, null);
    const calendar = await installCalendarRead(page, { failInitial: true });
    await page.goto("/calendar");

    await expect.poll(() => calendar.requests).toBeGreaterThan(0);
    await expect(page.getByTestId("planning-route-error")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-health")).toContainText("Данные недоступны");
    await expect(page.getByTestId("planning-route-health")).toContainText("Повторите попытку");
    await expect(page.getByTestId("planning-route-health")).not.toContainText("Показаны последние доступные данные");
  });

  test("Calendar month-change failure does not claim old rows remain visible", async ({ page }) => {
    await preparePage(page, null);
    const calendar = await installCalendarRead(page, { delayView: "agenda", failView: "agenda" });
    await page.goto("/calendar");
    await expect(page.getByText("Старое событие 1")).toBeVisible();

    await page.getByRole("button", { name: "Предыдущий месяц" }).click();
    await expect.poll(() => calendar.backgroundReads).toBe(1);
    await expect(page.getByText("Старое событие 1")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-loading")).toBeVisible();

    calendar.release.resolve();
    await expect(page.getByTestId("planning-route-error")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-health")).toContainText("Данные недоступны");
    await expect(page.getByTestId("planning-route-health")).not.toContainText("Показаны последние доступные данные");
  });

  test("Calendar query identity changes do not show old-month rows under a new month", async ({ page }) => {
    await preparePage(page);
    const calendar = await installCalendarRead(page, { delayView: "agenda" });
    await page.goto("/calendar");
    await expect(page.getByText("Старое событие 1")).toBeVisible();

    await page.getByRole("button", { name: "Предыдущий месяц" }).click();
    await expect.poll(() => calendar.backgroundReads).toBe(1);
    await expect(page.getByText("Старое событие 1")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-loading")).toBeVisible();
    calendar.release.resolve();
    await expect(page.getByTestId("planning-calendar-month-heading")).toContainText("Июль");
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(0);

    const initialFrom = calendar.fromValues[0];
    const previousFrom = calendar.fromValues.at(-1) ?? initialFrom;
    let nextFrom = "";
    await page.unroute("**/api/v1/planning/events**");
    await page.route("**/api/v1/planning/events**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      nextFrom = new URL(route.request().url()).searchParams.get("from") ?? "";
      await route.continue();
    });
    await page.getByRole("button", { name: "Следующий месяц" }).click();
    await expect.poll(() => nextFrom).not.toBe("");
    expect(nextFrom).not.toBe(previousFrom);
  });

  test("Calendar legitimate empty response remains an empty state while revalidating", async ({ page }) => {
    const { setRevision } = await preparePage(page);
    const calendar = await installCalendarRead(page, { delayNextRequest: true, empty: true });
    await page.goto("/calendar");
    await expect(page.getByTestId("planning-calendar-month")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-selected-day-empty")).toBeVisible();
    const before = await page.locator(".planning-route-workzone").boundingBox();

    setRevision(2);
    await emitRevision(page, 2);
    await expect.poll(() => calendar.backgroundReads).toBe(1);
    await expect(page.getByTestId("planning-calendar-month")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-selected-day-empty")).toBeVisible();
    await expect(page.getByTestId("planning-route-loading")).toHaveCount(0);
    const during = await page.locator(".planning-route-workzone").boundingBox();
    expect(during?.height).toBeGreaterThanOrEqual((before?.height ?? 1) * 0.9);
    calendar.release.resolve();
    await expect(page.getByTestId("planning-route-loading")).toHaveCount(0);
    await expect(page.getByTestId("planning-calendar-month")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-selected-day-empty")).toBeVisible();
  });

  test("Tasks preserve rows for a background snapshot refresh", async ({ page }) => {
    const { setRevision } = await preparePage(page);
    const tasks = await installTaskRead(page, { delaySecond: true });
    await page.goto("/tasks");
    await expect(page.getByText("Старая задача 1")).toBeVisible();

    // Observe the requested refresh, independent of StrictMode mount reads.
    tasks.startBackground();
    setRevision(2);
    await emitRevision(page, 2);
    await expect.poll(() => tasks.backgroundReads).toBe(1);
    await expect(page.getByText("Старая задача 1")).toBeVisible();
    await expect(page.getByTestId("planning-route-loading")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-health")).toContainText("Обновляем…");
    tasks.release.resolve();
    await expect(page.getByText("Новая задача 1")).toBeVisible();
    await expect(page.getByText("Старая задача 1")).toHaveCount(0);
  });

  test("Tasks view and page identity changes clear old rows before the new response", async ({ page }) => {
    await preparePage(page);
    const tasks = await installTaskRead(page, { delayView: "overdue", hasMore: true });
    await page.goto("/tasks");
    await expect(page.getByText("Старая задача 1")).toBeVisible();

    await page.getByRole("button", { name: "Просрочено" }).click();
    await expect.poll(() => tasks.requests).toBeGreaterThanOrEqual(2);
    await expect(page.getByText("Старая задача 1")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-loading")).toBeVisible();
    await expect(page.getByTestId("planning-route-health")).toHaveCount(0);
    tasks.release.resolve();
    await expect(page.getByText("Новая задача 1")).toBeVisible();

    const nextPage = deferred();
    await page.unroute("**/api/v1/planning/tasks**");
    await page.route("**/api/v1/planning/tasks**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const offset = new URL(route.request().url()).searchParams.get("offset");
      if (offset !== "0") await nextPage.promise;
      const response = await route.fetch();
      const payload = await response.json() as Record<string, unknown>;
      const template = tasks.getTemplate();
      if (!template) throw new Error("Task pagination fixture did not capture a canonical template");
      payload.items = [{ ...template, id: "00000000-0000-4000-8000-000000009991", title: "Задача страницы 2" }];
      payload.count = 1;
      payload.offset = Number(offset ?? "0");
      payload.hasMore = false;
      await route.fulfill({ response, body: JSON.stringify(payload) });
    });
    await page.getByRole("button", { name: "Ещё" }).click();
    await expect(page.getByText("Новая задача 1")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-loading")).toBeVisible();
    await expect(page.getByTestId("planning-route-health")).toHaveCount(0);
    nextPage.resolve();
    await expect(page.getByText("Задача страницы 2")).toBeVisible();
  });

  test("Alice reminders preserve rows while a background read is pending", async ({ page }) => {
    await preparePage(page);
    const held = deferred();
    let hold = false;
    let waiting = false;
    await page.route("**/api/v1/station/reminders", async route => {
      if (hold) {
        waiting = true;
        await held.promise;
        return route.fulfill({ json: nativeReminders("Новое напоминание 1") });
      }
      return route.fulfill({ json: nativeReminders("Старое напоминание 1") });
    });
    await page.goto("/reminders");
    const section = page.getByTestId("alice-reminders");
    const before = section.getByText("Старое напоминание 1");
    await expect(before).toBeVisible();
    const initial = await before.boundingBox();
    hold = true;
    try {
      await refreshNativeReminders(page);
      await expect.poll(() => waiting).toBe(true);
      await expect(before).toBeVisible();
      expect(await before.boundingBox()).toEqual(initial);
      await expect(section).toHaveAttribute("data-status", "fresh");
    } finally {
      held.resolve();
    }
    await expect(section.getByText("Новое напоминание 1")).toBeVisible();
    await expect(before).toHaveCount(0);
  });

  test("an unavailable Alice authorization clears previous reminders and their editor", async ({ page }) => {
    await preparePage(page);
    let authorizationLost = false;
    let legacyRequests = 0;
    await page.route("**/api/v1/planning/reminders/**", route => { legacyRequests++; return route.fallback(); });
    await page.route("**/api/v1/station/reminders", route => route.fulfill({ json: authorizationLost
      ? { status: "auth_required", observedAt: null, items: [] }
      : nativeReminders("Старое напоминание 1") }));
    await page.goto("/reminders");
    const section = page.getByTestId("alice-reminders");
    await expect(section.getByText("Старое напоминание 1")).toBeVisible();
    await section.getByRole("button", { name: "Добавить" }).click();
    await expect(page.getByTestId("alice-reminder-editor")).toBeVisible();
    authorizationLost = true;
    await refreshNativeReminders(page);
    await expect(section.getByRole("status")).toContainText("Нужно восстановить вход в Яндекс");
    await expect(section.getByText("Старое напоминание 1")).toHaveCount(0);
    await expect(page.getByTestId("alice-reminder-editor")).toHaveCount(0);
    await expect(page.getByTestId("alice-reminders-empty")).toHaveCount(0);
    expect(legacyRequests).toBe(0);
  });

  test("a response from the old reminders view cannot replace the new view", async ({ page }) => {
    await preparePage(page);
    const held = deferred();
    let phase: "initial" | "hold" | "new" = "initial";
    let waiting = false;
    await page.route("**/api/v1/station/reminders", async route => {
      if (phase === "hold") {
        waiting = true;
        await held.promise;
        return route.fulfill({ json: nativeReminders("Поздний старый ответ 1") }).catch(() => {});
      }
      return route.fulfill({ json: nativeReminders(phase === "initial" ? "Старое напоминание 1" : "Новое напоминание 1") });
    });
    await page.goto("/reminders");
    const section = page.getByTestId("alice-reminders");
    await expect(section.getByText("Старое напоминание 1")).toBeVisible();
    phase = "hold";
    try {
      await refreshNativeReminders(page);
      await expect.poll(() => waiting).toBe(true);
      await page.locator('a[href="/tasks"]').first().evaluate((link: HTMLAnchorElement) => link.click());
      await expect(page.getByTestId("route-tasks")).toBeVisible();
      phase = "new";
      await page.goBack();
      await expect(section.getByText("Новое напоминание 1")).toBeVisible();
    } finally {
      held.resolve();
    }
    await expect(section.getByText("Новое напоминание 1")).toBeVisible();
    await expect(section.getByText("Поздний старый ответ 1")).toHaveCount(0);
  });
});
