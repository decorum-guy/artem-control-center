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

async function installSnapshot(page: Page, planning: PlanningSnapshot): Promise<{ setRevision: (revision: number) => void }> {
  let revision = 1;
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    payload.revision = revision;
    payload.planning = clone(planning);
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

async function preparePage(page: Page, planning: PlanningSnapshot = planningFixtures.empty): Promise<{ setRevision: (revision: number) => void }> {
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
  options: { delayView?: "agenda"; delayNextRequest?: boolean; failSecond?: boolean; empty?: boolean } = {}
): Promise<{ requests: number; methods: string[]; release: Deferred; fromValues: string[] }> {
  let requestCount = 0;
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
    if ((options.delayView && view === options.delayView) || (options.delayNextRequest && (options.empty ? requestCount === 3 : requestCount >= 3))) {
      await release.promise;
    }
    if (options.failSecond && requestCount === 3) {
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
      await route.fulfill({ response, body: JSON.stringify(payload) });
      return;
    }
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    if (!template) template = listItems(payload)[0];
    const prefix = requestCount <= 2 ? "Старое событие" : requestCount === 3 ? "Свежее событие" : "Событие после повтора";
    payload.items = [1, 2].map((index) => ({
      ...template,
      id: `00000000-0000-4000-8000-${String(900 + index).padStart(12, "0")}`,
      title: `${prefix} ${index}`
    }));
    payload.count = 2;
    payload.offset = Number(url.searchParams.get("offset") ?? "0");
    payload.hasMore = false;
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  return {
    get requests() { return requestCount; },
    get methods() { return requestMethods; },
    release,
    get fromValues() { return fromValues; }
  };
}

async function installTaskRead(page: Page, options: { delayView?: "overdue"; delaySecond?: boolean; hasMore?: boolean } = {}): Promise<{ requests: number; release: Deferred; getTemplate: () => Record<string, unknown> | null }> {
  let requestCount = 0;
  let template: Record<string, unknown> | null = null;
  const release = deferred();
  await page.route("**/api/v1/planning/tasks**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    requestCount += 1;
    const url = new URL(route.request().url());
    const view = url.searchParams.get("view");
    if ((options.delayView && view === options.delayView) || (options.delaySecond && requestCount === 3)) {
      await release.promise;
    }
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    template ??= listItems(payload)[0];
    const items = requestCount <= 2 ? ["Старая задача 1", "Старая задача 2"] : ["Новая задача 1", "Новая задача 2"];
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
  return { get requests() { return requestCount; }, release, getTemplate: () => template };
}

async function installReminderRead(page: Page, options: { delayView?: "delivery"; delaySecond?: boolean; lateBackground?: boolean; hasMore?: boolean } = {}): Promise<{ requests: number; release: Deferred; getTemplate: () => Record<string, unknown> | null }> {
  let requestCount = 0;
  let template: Record<string, unknown> | null = null;
  const release = deferred();
  await page.route("**/api/v1/planning/reminders/view**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    requestCount += 1;
    const url = new URL(route.request().url());
    const view = url.searchParams.get("view");
    if ((options.delayView && view === options.delayView) || (options.delaySecond && requestCount === 3)) {
      await release.promise;
    }
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    if (!template) template = listItems(payload)[0];
    const items = requestCount <= 2
      ? ["Старое напоминание 1", "Старое напоминание 2"]
      : options.lateBackground && requestCount === 3
        ? ["Поздний старый ответ 1", "Поздний старый ответ 2"]
        : ["Новое напоминание 1", "Новое напоминание 2"];
    payload.items = items.map((title, index) => ({
      ...template,
      ...(view === "delivery" ? { status: "due", deliveryState: "failed" } : {}),
      id: `00000000-0000-4000-8000-${String(920 + index).padStart(12, "0")}`,
      title
    }));
    payload.count = items.length;
    payload.offset = Number(url.searchParams.get("offset") ?? "0");
    payload.hasMore = options.hasMore ?? false;
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  return { get requests() { return requestCount; }, release, getTemplate: () => template };
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

  test("Calendar keeps populated Agenda mounted during a delayed snapshot refresh and atomically accepts fresh rows", async ({ page }) => {
    const { setRevision } = await preparePage(page);
    const calendar = await installCalendarRead(page, { delayNextRequest: true });
    await page.goto("/calendar");
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(2);
    const before = await page.locator(".planning-route-workzone").boundingBox();

    setRevision(2);
    await emitRevision(page, 2);
    await expect.poll(() => calendar.requests).toBe(3);
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(2);
    await expect(page.getByText("Старое событие 1")).toBeVisible();
    await expect(page.getByTestId("planning-route-loading")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-health")).toContainText("Обновляем данные");
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
    await expect.poll(() => calendar.requests).toBe(3);
    await expect(page.getByText("Старое событие 1")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(2);
    await expect(page.getByTestId("planning-route-health")).toContainText("Обновление не удалось");
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

  test("Calendar query identity changes do not show Today rows under Agenda or another date", async ({ page }) => {
    await preparePage(page);
    const calendar = await installCalendarRead(page, { delayView: "agenda" });
    await page.goto("/calendar");
    await expect(page.getByText("Старое событие 1")).toBeVisible();

    await page.getByRole("button", { name: "Повестка" }).click();
    await expect.poll(() => calendar.requests).toBe(3);
    await expect(page.getByText("Старое событие 1")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-loading")).toBeVisible();
    calendar.release.resolve();
    await expect(page.getByText("Свежее событие 1").first()).toBeVisible();

    const initialFrom = calendar.fromValues[0];
    let nextFrom = "";
    await page.unroute("**/api/v1/planning/events**");
    await page.route("**/api/v1/planning/events**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      nextFrom = new URL(route.request().url()).searchParams.get("from") ?? "";
      await route.continue();
    });
    await page.getByRole("button", { name: "Следующие 7 дней" }).click();
    await expect(page.getByText("Свежее событие 1")).toHaveCount(0);
    await expect.poll(() => nextFrom).not.toBe("");
    expect(nextFrom).not.toBe(initialFrom);
  });

  test("Calendar legitimate empty response remains an empty state while revalidating", async ({ page }) => {
    const { setRevision } = await preparePage(page);
    const calendar = await installCalendarRead(page, { delayNextRequest: true, empty: true });
    await page.goto("/calendar");
    await expect(page.getByTestId("planning-route-empty")).toBeVisible();
    const before = await page.locator(".planning-route-workzone").boundingBox();

    setRevision(2);
    await emitRevision(page, 2);
    await expect.poll(() => calendar.requests).toBe(3);
    await expect(page.getByTestId("planning-route-empty")).toBeVisible();
    await expect(page.getByTestId("planning-route-loading")).toHaveCount(0);
    const during = await page.locator(".planning-route-workzone").boundingBox();
    expect(during?.height).toBeGreaterThanOrEqual((before?.height ?? 1) * 0.9);
    calendar.release.resolve();
    await expect(page.getByTestId("planning-route-loading")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-empty")).toBeVisible();
  });

  test("Tasks preserve rows for a background snapshot refresh", async ({ page }) => {
    const { setRevision } = await preparePage(page);
    const tasks = await installTaskRead(page, { delaySecond: true });
    await page.goto("/tasks");
    await expect(page.getByText("Старая задача 1")).toBeVisible();

    setRevision(2);
    await emitRevision(page, 2);
    await expect.poll(() => tasks.requests).toBe(3);
    await expect(page.getByText("Старая задача 1")).toBeVisible();
    await expect(page.getByTestId("planning-route-loading")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-health")).toContainText("Обновляем данные");
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
    await expect.poll(() => tasks.requests).toBe(3);
    await expect(page.getByText("Старая задача 1")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-loading")).toBeVisible();
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
    nextPage.resolve();
    await expect(page.getByText("Задача страницы 2")).toBeVisible();
  });

  test("Reminders preserve rows for a background snapshot refresh", async ({ page }) => {
    const { setRevision } = await preparePage(page);
    const reminders = await installReminderRead(page, { delaySecond: true });
    await page.goto("/reminders");
    await expect(page.getByText("Старое напоминание 1")).toBeVisible();

    setRevision(2);
    await emitRevision(page, 2);
    await expect.poll(() => reminders.requests).toBe(3);
    await expect(page.getByText("Старое напоминание 1")).toBeVisible();
    await expect(page.getByTestId("planning-route-loading")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-health")).toContainText("Обновляем данные");
    reminders.release.resolve();
    await expect(page.getByText("Новое напоминание 1")).toBeVisible();
    await expect(page.getByText("Старое напоминание 1")).toHaveCount(0);
  });

  test("Reminders view and page identity changes do not carry Upcoming rows", async ({ page }) => {
    await preparePage(page);
    const reminders = await installReminderRead(page, { delayView: "delivery", hasMore: true });
    await page.goto("/reminders");
    await expect(page.getByText("Старое напоминание 1")).toBeVisible();

    await page.getByRole("button", { name: "Доставка", exact: true }).tap();
    await expect.poll(() => reminders.requests).toBe(3);
    await expect(page.getByText("Старое напоминание 1")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-loading")).toBeVisible();
    reminders.release.resolve();
    await expect(page.getByText("Новое напоминание 1")).toBeVisible();

    const nextPage = deferred();
    await page.unroute("**/api/v1/planning/reminders/view**");
    await page.route("**/api/v1/planning/reminders/view**", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const offset = new URL(route.request().url()).searchParams.get("offset");
      if (offset !== "0") await nextPage.promise;
      const response = await route.fetch();
      const payload = await response.json() as Record<string, unknown>;
      const template = reminders.getTemplate();
      if (!template) throw new Error("Reminder pagination fixture did not capture a canonical template");
      payload.items = [{
        ...template,
        status: "due",
        deliveryState: "failed",
        id: "00000000-0000-4000-8000-000000009991",
        title: "Напоминание страницы 2"
      }];
      payload.count = 1;
      payload.offset = Number(offset ?? "0");
      payload.hasMore = false;
      await route.fulfill({ response, body: JSON.stringify(payload) });
    });
    await page.getByRole("button", { name: "Ещё" }).click();
    await expect(page.getByText("Новое напоминание 1")).toHaveCount(0);
    await expect(page.getByTestId("planning-route-loading")).toBeVisible();
    nextPage.resolve();
    await expect(page.getByText("Напоминание страницы 2")).toBeVisible();
  });

  test("An obsolete background response cannot overwrite a newly selected Reminders query", async ({ page }) => {
    const { setRevision } = await preparePage(page);
    const reminders = await installReminderRead(page, { delaySecond: true, lateBackground: true });
    await page.goto("/reminders");
    await expect(page.getByText("Старое напоминание 1")).toBeVisible();

    setRevision(2);
    await emitRevision(page, 2);
    await expect.poll(() => reminders.requests).toBe(3);

    await page.getByRole("button", { name: "Доставка", exact: true }).tap();
    await expect(page.getByText("Новое напоминание 1")).toBeVisible();
    reminders.release.resolve();
    await expect(page.getByText("Новое напоминание 1")).toBeVisible();
    await expect(page.getByText("Поздний старый ответ 1")).toHaveCount(0);
  });
});
