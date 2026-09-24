import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const enabled = process.env.VITE_V2_VISUAL_SHELL === "true"
  && process.env.B3_PLANNING_CALENDAR_ROUTE_ENABLED === "true"
  && process.env.VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED === "true";
test.skip(!enabled, "Run with the Calendar writer and V2 shell enabled.");

const localId = "00000000-0000-4000-8000-000000002790";
const createdId = "00000000-0000-4000-8000-000000002799";
const sources = [
  { id: "native-planning", label: "Локальный", kind: "native", provider: "local", configured: true, status: "current", lastSyncedAt: "2026-08-12T09:00:00Z", observedAt: "2026-08-12T09:00:00Z", calendars: [] },
  { id: "icloud-safe", label: "iCloud", kind: "external", provider: "icloud", configured: true, status: "current", lastSyncedAt: "2026-08-12T09:00:00Z", observedAt: "2026-08-12T09:00:00Z", calendars: [
    { id: "work", label: "Работа", color: "#D65A4A", enabled: true, status: "current", lastSyncedAt: null, observedAt: null },
    { id: "home", label: "Дом", color: "#2F9A7D", enabled: true, status: "current", lastSyncedAt: null, observedAt: null }
  ] }
];

function event(id: string, title: string, calendarId: string, startAtUtc: string | null, endAtUtc: string | null, allDay = false) {
  const local = calendarId === "local";
  return {
    id, version: 1, source: local ? "panel-agent" : "calendar-provider", sourceLabel: local ? "Panel Agent" : "iCloud",
    calendarIdentity: { providerId: local ? "native-planning" : "icloud-safe", providerLabel: local ? "Local Planning" : "iCloud", calendarId, calendarLabel: local ? "Локальный календарь" : calendarId === "work" ? "Работа" : "Дом" },
    title, notes: local ? "Важные детали" : null, location: local ? "Зал" : null,
    allDay, timezone: "Europe/Moscow", syncState: local ? "local_only" : "synced", localOnlyMutable: local,
    startAtUtc, endAtUtc, startDate: allDay ? "2026-08-14" : null, endDateExclusive: allDay ? "2026-08-15" : null,
    deletedAt: null as string | null, createdAt: "2026-08-12T09:00:00Z", updatedAt: "2026-08-12T09:00:00Z"
  };
}

async function fixture(page: Page, initialMarkerStyle: "dots" | "bars" = "dots") {
  let sourceStale = false;
  let markerStyle = initialMarkerStyle;
  let preferencesRevision = 0;
  const events = [
    event(localId, "Локальная встреча", "local", "2026-08-12T10:00:00Z", "2026-08-12T11:00:00Z"),
    event("00000000-0000-4000-8000-000000002791", "Рабочая встреча", "work", "2026-08-12T10:30:00Z", "2026-08-12T11:30:00Z"),
    event("00000000-0000-4000-8000-000000002796", "Обычная встреча", "home", "2026-08-12T12:00:00Z", "2026-08-12T13:00:00Z"),
    event("00000000-0000-4000-8000-000000002792", "Весь день с семьёй", "home", null, null, true),
    event("00000000-0000-4000-8000-000000002793", "Очень длинное русское название рабочей встречи, которое должно оставаться читаемым в узкой повестке", "work", "2026-08-14T08:30:00Z", "2026-08-14T09:30:00Z"),
    event("00000000-0000-4000-8000-000000002794", "Домашние дела", "home", "2026-08-14T09:00:00Z", "2026-08-14T10:00:00Z"),
    event("00000000-0000-4000-8000-000000002795", "Ещё одно событие", "work", "2026-08-14T10:00:00Z", "2026-08-14T11:00:00Z")
  ];
  const requests: Array<{ method: string; id: string; body: Record<string, unknown>; ifMatch: string | undefined }> = [];
  const currentSources = () => sources.map((source) => source.id === "icloud-safe" && sourceStale ? { ...source, status: "stale" } : source);
  const listed = () => events.filter((item) => !item.deletedAt);
  const objectEnvelope = (object: Record<string, unknown>) => ({ schemaVersion: "planning.panel.v1", kind: "object", domain: "calendar_event", object, sourceStatus: "current", lastSyncedAt: "2026-08-12T09:00:00Z", staleAfter: "2026-08-12T09:05:00Z" });

  await page.route("**/api/v1/access", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const capabilities = Object.fromEntries(["create", "edit", "delete"].map((action) => {
      const capability = `planning.calendar.${action}`;
      return [capability, { capability, minimumProfile: "standard", effectiveProfile: "full", allowed: true, availability: "allowed" }];
    }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, revision: 1, baseProfile: "full", effectiveProfile: "full", temporaryFull: false, temporaryFullExpiresAt: null, confirmationPolicy: { actionConfirmationRequired: false, mode: "manual_persistent_full" }, pinConfigured: true, lockoutUntil: null, capabilities }) });
  });
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json() as { planning?: Record<string, unknown> | null };
    if (snapshot.planning) {
      snapshot.planning.calendarMutationsEnabled = true;
      snapshot.planning.providerStatuses = sources;
    }
    await route.fulfill({ response, body: JSON.stringify(snapshot) });
  });
  await page.route("**/api/v1/settings/calendar/display-colors", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: "calendar.display-preferences.v1", revision: preferencesRevision, updatedAt: "2026-08-12T09:00:00Z", overrides: [], eventMarkerStyle: markerStyle, available: true, warnings: [], writesEnabled: true }) });
      return;
    }
    await route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ detail: "not_supported_in_calendar_fixture" }) });
  });
  await page.route("**/api/v1/settings/calendar/event-marker-style", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON() as { expectedRevision: number; markerStyle: "dots" | "bars" };
    if (body.expectedRevision !== preferencesRevision) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "revision_conflict" }) });
      return;
    }
    markerStyle = body.markerStyle;
    preferencesRevision += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: "calendar.display-preferences.v1", revision: preferencesRevision, updatedAt: "2026-08-12T09:00:00Z", overrides: [], eventMarkerStyle: markerStyle, available: true, warnings: [], writesEnabled: true }) });
  });
  await page.route(/\/api\/v1\/planning\/events(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const id = pathname.split("/").at(-1) ?? "";
    if (request.method() === "GET" && pathname.endsWith("/events")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: "planning.panel.v1", kind: "list", domain: "calendar_event", generatedAt: "2026-08-12T09:00:00Z", sourceStatus: "current", lastSyncedAt: "2026-08-12T09:00:00Z", staleAfter: "2026-08-12T09:05:00Z", sources: currentSources(), items: listed(), limit: 100, offset: 0, count: listed().length, hasMore: false }) });
      return;
    }
    const target = events.find((item) => item.id === id);
    if (request.method() === "GET") {
      await route.fulfill({ status: target ? 200 : 404, contentType: "application/json", body: JSON.stringify(target ? objectEnvelope(target) : { detail: "planning_calendar_event_not_found" }) });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    requests.push({ method: request.method(), id, body, ifMatch: request.headers()["if-match"] });
    const projection: Record<string, string> = { all_day: "allDay", start_at_utc: "startAtUtc", end_at_utc: "endAtUtc", start_date: "startDate", end_date_exclusive: "endDateExclusive" };
    const fields = Object.fromEntries(Object.entries(body).map(([key, value]) => [projection[key] ?? key, value]));
    let result;
    if (request.method() === "POST") {
      result = { ...event(createdId, String(body.title), "local", null, null), ...fields };
      events.push(result);
    } else if (target?.localOnlyMutable && request.method() === "PATCH") {
      result = { ...target, ...fields, version: target.version + 1 };
      events.splice(events.indexOf(target), 1, result);
    } else if (target?.localOnlyMutable && request.method() === "DELETE") {
      result = { ...target, deletedAt: "2026-08-12T09:05:00Z", version: target.version + 1 };
      events.splice(events.indexOf(target), 1, result);
    } else {
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ detail: "read_only" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(objectEnvelope(result)) });
  });
  return { requests, events, setSourceStale: (value: boolean) => { sourceStale = value; } };
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const directory = process.env.ISSUE_279_CALENDAR_ARTIFACT_DIR ?? testInfo.outputPath("issue-279-calendar-review");
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), animations: "disabled" });
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

test.beforeEach(async ({ page }) => { await page.clock.install({ time: "2026-08-12T09:00:00Z" }); });

test("Calendar day/night visual review keeps the complete six-week month and agenda in 720px", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const data = await fixture(page);
  expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
  await page.goto("/calendar?date=2026-08-12&theme=day");
  const month = page.getByTestId("planning-calendar-month");
  await expect(page.getByTestId("planning-calendar-month-cell")).toHaveCount(42);
  await expect(month).toHaveAttribute("data-rows", "6");
  const monthBox = await page.locator(".calendar-month").boundingBox();
  expect(monthBox!.y).toBeLessThan(200);
  expect(monthBox!.y + monthBox!.height).toBeLessThanOrEqual(720);
  const routeScroll = await page.locator(".v2-route-content").evaluate((element) => ({ scroll: element.scrollHeight, visible: element.clientHeight }));
  expect(routeScroll.scroll).toBeLessThanOrEqual(routeScroll.visible + 1);
  await noHorizontalOverflow(page);
  const overlapRow = page.getByTestId("planning-calendar-event-row").filter({ hasText: "Локальная встреча" });
  const ordinaryRow = page.getByTestId("planning-calendar-event-row").filter({ hasText: "Обычная встреча" });
  await expect(overlapRow).toHaveAttribute("data-overlap", "true");
  const overlapGeometry = await overlapRow.boundingBox();
  const ordinaryGeometry = await ordinaryRow.boundingBox();
  const overlapMainGeometry = await overlapRow.locator(".planning-route-row__main").boundingBox();
  const overlapStatusGeometry = await overlapRow.locator(".calendar-event-row__badges").boundingBox();
  expect(overlapGeometry?.height).toBeGreaterThanOrEqual(48);
  expect(ordinaryGeometry?.height).toBeGreaterThanOrEqual(48);
  expect(overlapStatusGeometry?.x).toBeGreaterThanOrEqual((overlapMainGeometry?.x ?? 0) + (overlapMainGeometry?.width ?? 0) - 1);
  expect(overlapStatusGeometry?.y).toBeLessThan((overlapMainGeometry?.y ?? 0) + (overlapMainGeometry?.height ?? 0));
  expect((overlapStatusGeometry?.y ?? 0) + (overlapStatusGeometry?.height ?? 0)).toBeLessThanOrEqual((overlapGeometry?.y ?? 0) + (overlapGeometry?.height ?? 0));
  await capture(page, testInfo, "day-compact-overlap.png");
  await capture(page, testInfo, "day-normal.png");

  await page.locator('[data-testid="planning-calendar-month-cell"][data-date="2026-08-14"]').tap();
  await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(4);
  await expect(page.getByTestId("planning-calendar-all-day-band")).toHaveCSS("background-color", /rgb/);
  const dots = page.getByTestId("planning-calendar-event-color-dot");
  await expect(dots).toHaveCount(4);
  expect(new Set(await dots.evaluateAll((items) => items.map((item) => item.getAttribute("data-color")))).size).toBeGreaterThanOrEqual(2);
  await capture(page, testInfo, "day-multiple-calendars.png");
  data.setSourceStale(true);
  await page.getByTestId("planning-calendar-refresh").tap();
  await expect(page.getByTestId("planning-calendar-stale-cue").first()).toBeVisible();
  await capture(page, testInfo, "day-stale-provider.png");

  await page.getByRole("button", { name: "Создать событие" }).tap();
  const editor = page.getByTestId("planning-calendar-mutation");
  await expect(editor.getByTestId("calendar-editor-destination")).toContainText("Локальный календарь");
  await capture(page, testInfo, "day-create-structured.png");
  await editor.getByRole("button", { name: /Конец/ }).tap();
  await capture(page, testInfo, "day-time-picker.png");
  await editor.getByRole("switch", { name: "Весь день" }).tap();
  await expect(editor.getByTestId("calendar-time-picker")).toHaveCount(0);
  await capture(page, testInfo, "day-all-day-editor.png");
  await editor.getByRole("button", { name: "Отмена" }).tap();

  await page.goto("/calendar?date=2026-08-12&theme=night");
  await capture(page, testInfo, "night-normal.png");
  await page.getByTestId("planning-calendar-event-row").filter({ hasText: "Локальная встреча" }).tap();
  await capture(page, testInfo, "night-detail.png");
  await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Изменить" }).tap();
  await capture(page, testInfo, "night-edit-structured.png");
  await page.getByTestId("planning-calendar-mutation").getByRole("button", { name: /Конец/ }).tap();
  await capture(page, testInfo, "night-time-picker.png");
  await page.getByTestId("planning-calendar-mutation").getByRole("button", { name: "Отмена" }).tap();
  await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Закрыть" }).tap();
  await page.getByTestId("planning-calendar-event-row").filter({ hasText: "Рабочая встреча" }).tap();
  await expect(page.getByTestId("planning-calendar-detail")).toContainText("Только просмотр");
  await capture(page, testInfo, "night-external-read-only.png");
});

test("Calendar bars mode keeps the selected-day agenda compact and removes dots", async ({ page }, testInfo) => {
  await fixture(page, "bars");
  await page.goto("/calendar?date=2026-08-12&theme=day");
  const rows = page.getByTestId("planning-calendar-event-row");
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId("planning-calendar-event-color-dot")).toHaveCount(0);
  await expect(rows.first()).toHaveAttribute("data-marker-style", "bars");
  await expect(rows.first()).toHaveCSS("border-left-width", "3px");
  await noHorizontalOverflow(page);
  await capture(page, testInfo, "day-bars-mode.png");
});

test("Calendar marker selector persists bars and is visible in Settings", async ({ page }, testInfo) => {
  await fixture(page);
  await page.goto("/settings?theme=night");
  await page.getByTestId("settings-summary-calendars").tap();
  const selector = page.getByTestId("settings-calendar-marker-style");
  await expect(selector).toContainText("Отображение событий");
  await expect(selector.getByRole("button", { name: "Точки" })).toHaveAttribute("aria-pressed", "true");
  await capture(page, testInfo, "settings-calendar-marker-selector.png");
  await selector.getByRole("button", { name: "Полоски" }).tap();
  await expect(selector.getByRole("button", { name: "Полоски" })).toHaveAttribute("aria-pressed", "true");
  await page.goto("/calendar?date=2026-08-12&theme=night");
  await expect(page.getByTestId("planning-calendar-event-row").first()).toHaveAttribute("data-marker-style", "bars");
});

test("touch editor writes LOCAL-ONLY create, edit and delete with canonical readback", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const data = await fixture(page);
  await page.goto("/calendar?date=2026-08-12&theme=day");
  await page.getByRole("button", { name: "Создать событие" }).tap();
  const editor = page.getByTestId("planning-calendar-mutation");
  await editor.getByTestId("calendar-editor-title").fill("Новая локальная запись");
  await expect(editor.getByTestId("calendar-editor-start-date").locator('input[type="date"]')).toHaveValue("2026-08-12");
  await editor.getByTestId("calendar-time-hour-next").tap();
  await expect(editor.getByRole("button", { name: /Начало/ })).toContainText("10:00");
  await editor.getByTestId("calendar-time-minute-next").tap();
  await expect(editor.getByRole("button", { name: /Начало/ })).toContainText("10:01");
  await editor.getByTestId("calendar-time-minute-column").hover();
  await page.mouse.wheel(0, 100);
  await expect(editor.getByRole("button", { name: /Начало/ })).toContainText("10:02");
  await editor.getByRole("button", { name: "30 мин" }).tap();
  await expect(editor.getByRole("button", { name: /Конец/ })).toContainText("10:32");
  await editor.getByTestId("calendar-time-hour-selected").focus();
  await page.keyboard.press("ArrowDown");
  await expect(editor.getByTestId("calendar-time-hour-selected")).toBeFocused();
  await expect(editor.getByRole("button", { name: /Начало/ })).toContainText("11:02");
  await expect(editor.getByRole("button", { name: /Конец/ })).toContainText("11:32");
  await editor.getByRole("button", { name: /Конец/ }).tap();
  await editor.getByTestId("calendar-time-minute-next").tap();
  await expect(editor.getByRole("button", { name: "30 мин" })).toHaveAttribute("aria-pressed", "false");
  await editor.getByRole("textbox", { name: "Заметки необязательно" }).fill("После ручной правки");
  await editor.getByRole("textbox", { name: "Место необязательно" }).fill("Зал 2");
  await editor.getByRole("button", { name: "Сохранить" }).tap();
  await expect.poll(() => data.requests.filter((request) => request.method === "POST").length).toBe(1);
  expect(data.requests.find((request) => request.method === "POST")?.body).toMatchObject({ title: "Новая локальная запись", start_at_utc: "2026-08-12T08:02:00Z", end_at_utc: "2026-08-12T08:33:00Z", notes: "После ручной правки", location: "Зал 2" });
  await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Закрыть" }).tap();
  await page.reload();
  await page.getByTestId("planning-calendar-event-row").filter({ hasText: "Новая локальная запись" }).tap();
  await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Изменить" }).tap();
  await expect(page.getByTestId("calendar-editor-title")).toHaveValue("Новая локальная запись");
  await expect(page.getByRole("textbox", { name: "Заметки необязательно" })).toHaveValue("После ручной правки");
  await page.getByTestId("calendar-editor-title").fill("Обновлённая локальная запись");
  await page.getByRole("textbox", { name: "Заметки необязательно" }).fill("Изменено");
  await page.getByTestId("planning-calendar-mutation").getByRole("button", { name: "Сохранить" }).tap();
  await expect.poll(() => data.requests.filter((request) => request.method === "PATCH").length).toBe(1);
  expect(data.requests.find((request) => request.method === "PATCH")?.ifMatch).toBe("1");
  await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Закрыть" }).tap();
  await page.reload();
  await page.getByTestId("planning-calendar-event-row").filter({ hasText: "Обновлённая локальная запись" }).tap();
  await expect(page.getByTestId("planning-calendar-detail")).toContainText("Изменено");
  await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Удалить" }).tap();
  await expect.poll(() => data.requests.filter((request) => request.method === "DELETE").length).toBe(1);
  expect(data.requests.find((request) => request.method === "DELETE")?.ifMatch).toBe("2");
  await page.reload();
  await expect(page.getByTestId("planning-calendar-event-row").filter({ hasText: "Обновлённая локальная запись" })).toHaveCount(0);
  expect(data.requests.every((request) => request.id !== "00000000-0000-4000-8000-000000002791")).toBe(true);
  await capture(page, testInfo, "day-after-local-delete.png");
});

test("reduced motion, backdrop safety and compact visible viewport keep controls reachable", async ({ page }) => {
  test.setTimeout(60_000);
  await fixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/calendar?date=2026-08-12&theme=night");
  const selected = page.locator('[data-testid="planning-calendar-month-cell"][data-date="2026-08-12"]');
  await page.getByRole("button", { name: "Создать событие" }).tap();
  const editor = page.getByTestId("planning-calendar-mutation");
  await expect(editor).toHaveCSS("animation-name", "none");
  await expect(editor.getByTestId("calendar-time-hour-selected")).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(editor).toHaveCount(0);
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 960, height: 720 });
  await noHorizontalOverflow(page);
  await page.getByRole("button", { name: "Создать событие" }).tap();
  await expect(page.getByTestId("planning-calendar-mutation").locator(".cc-overlay__footer")).toBeInViewport();
  await page.setViewportSize({ width: 640, height: 360 });
  await expect(page.getByTestId("planning-calendar-mutation").locator(".cc-overlay__footer")).toBeInViewport();
  await page.getByTestId("calendar-editor-title").focus();
  await expect(page.getByTestId("calendar-editor-title")).toBeFocused();
  await noHorizontalOverflow(page);
});
