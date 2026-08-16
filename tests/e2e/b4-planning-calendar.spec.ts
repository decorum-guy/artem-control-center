import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const calendarRouteEnabled = process.env.B3_PLANNING_CALENDAR_ROUTE_ENABLED === "true";
const calendarMutationsEnabled = process.env.VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED === "true";
const artifactDirectory = (testInfo: TestInfo) => process.env.B4_CALENDAR_ARTIFACT_DIR ?? testInfo.outputPath("b4-calendar-mutations");

const localId = "00000000-0000-4000-8000-000000000701";
const externalId = "00000000-0000-4000-8000-000000000702";

const localEvent = {
  id: localId,
  version: 1,
  source: "panel-agent",
  sourceLabel: "Panel Agent",
  calendarIdentity: { providerId: "local-planning", providerLabel: "Local Planning", calendarId: "local", calendarLabel: "Локальный" },
  title: "Локальная встреча",
  notes: "Сохранить контекст",
  location: "Переговорная",
  allDay: false,
  timezone: "Europe/Moscow",
  syncState: "local_only",
  localOnlyMutable: true,
  startAtUtc: "2026-08-12T10:00:00Z",
  endAtUtc: "2026-08-12T11:00:00Z",
  startDate: null,
  endDateExclusive: null,
  deletedAt: null,
  createdAt: "2026-08-12T09:00:00Z",
  updatedAt: "2026-08-12T09:00:00Z"
};

const externalEvent = {
  ...localEvent,
  id: externalId,
  source: "calendar-provider",
  sourceLabel: "Calendar provider",
  calendarIdentity: { providerId: "calendar-provider", providerLabel: "Calendar provider", calendarId: "external", calendarLabel: "Внешний календарь" },
  title: "Внешняя встреча",
  syncState: "synced",
  localOnlyMutable: false
};

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const directory = artifactDirectory(testInfo);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name) });
}

async function installAccess(page: Page, profile: "read_only" | "standard"): Promise<void> {
  const ids = ["planning.calendar.create", "planning.calendar.edit", "planning.calendar.delete"];
  await page.route("**/api/v1/access", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const allowed = profile === "standard";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        baseProfile: profile,
        effectiveProfile: profile,
        temporaryFull: false,
        temporaryFullExpiresAt: null,
        pinConfigured: true,
        lockoutUntil: null,
        capabilities: Object.fromEntries(ids.map((capability) => [capability, {
          capability,
          minimumProfile: "standard",
          effectiveProfile: profile,
          allowed,
          availability: allowed ? "allowed" : "profile_blocked"
        }]))
      })
    });
  });
}

function objectEnvelope(object: Record<string, unknown>) {
  return {
    schemaVersion: "planning.panel.v1",
    kind: "object",
    domain: "calendar_event",
    object,
    sourceStatus: "current",
    lastSyncedAt: "2026-08-12T09:00:00Z",
    staleAfter: "2026-08-12T09:05:00Z"
  };
}

type EventFixtureOptions = {
  loseCreateResponse?: boolean;
  loseEditResponse?: boolean;
  loseDeleteResponse?: boolean;
};

async function installEventFixtures(page: Page, options: EventFixtureOptions = {}): Promise<{ requests: Array<{ method: string; body: string; key: string }>; getCurrent: () => Record<string, unknown> }> {
  let current = { ...localEvent } as Record<string, unknown>;
  let nextVersion = 1;
  const requests: Array<{ method: string; body: string; key: string }> = [];
  let createResponseLost = false;
  let editResponseLost = false;
  let deleteResponseLost = false;
  const events = () => [current, externalEvent];
  await page.route("**/api/v1/planning/parse", async (route) => {
    const body = route.request().postDataJSON() as { text?: string };
    const text = body.text ?? "";
    const ambiguous = text.includes("вечером");
    const proposal = text.includes("18:30") && !text.includes("19:30");
    const allDay = text.includes("весь день");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "planning.v1",
        kind: "parse_preview",
        candidate: ambiguous ? null : {
          domain: "calendar_event",
          operation: "create",
          fields: allDay ? {
            title: "День без времени",
            all_day: true,
            timezone: "Europe/Moscow",
            start_date: "2026-08-14",
            end_date_exclusive: "2026-08-15"
          } : {
            title: "Новая встреча",
            all_day: false,
            timezone: "Europe/Moscow",
            start_at_utc: "2026-08-14T15:30:00Z",
            ...(proposal ? { proposed_end_at_utc: "2026-08-14T16:30:00Z", proposed_end_local: "16:30" } : { end_at_utc: "2026-08-14T16:30:00Z" })
          },
          normalized_paraphrase: allDay ? "Событие «День без времени» на 14 августа, весь день." : "Событие «Новая встреча» на 14 августа с 15:30 до 16:30."
        },
        confidence: ambiguous ? "medium" : "high",
        ambiguities: ambiguous ? [{ field: "time", candidates: [], reason: "«Вечером» не задаёт точное время." }] : [],
        requires_confirmation: proposal,
        normalized_text: text,
        error_code: null,
        correlation_id: "00000000-0000-4000-8000-000000000799"
      })
    });
  });
  await page.route(new RegExp("/api/v1/planning/events(?:/[^/?]+)?(?:\\?.*)?$"), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/events")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: "planning.panel.v1",
          kind: "list",
          domain: "calendar_event",
          generatedAt: "2026-08-12T09:00:00Z",
          sourceStatus: "current",
          lastSyncedAt: "2026-08-12T09:00:00Z",
          staleAfter: "2026-08-12T09:05:00Z",
          items: events(),
          limit: 20,
          offset: 0,
          count: 2,
          hasMore: false
        })
      });
      return;
    }
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(objectEnvelope(current)) });
      return;
    }
    const body = request.postData() ?? "{}";
    requests.push({ method: request.method(), body, key: request.headers()["idempotency-key"] ?? "" });
    const input = JSON.parse(body) as Record<string, unknown>;
    const fieldMap: Record<string, string> = {
      all_day: "allDay",
      start_at_utc: "startAtUtc",
      end_at_utc: "endAtUtc",
      start_date: "startDate",
      end_date_exclusive: "endDateExclusive"
    };
    const projectedInput = Object.fromEntries(Object.entries(input).map(([key, value]) => [fieldMap[key] ?? key, value]));
    if (request.method() === "POST") {
      current = { ...current, ...projectedInput, id: localId, version: 1, localOnlyMutable: true, syncState: "local_only" };
    } else if (request.method() === "PATCH") {
      nextVersion += 1;
      current = { ...current, ...projectedInput, version: nextVersion };
    } else if (request.method() === "DELETE") {
      nextVersion += 1;
      current = { ...current, version: nextVersion, deletedAt: "2026-08-12T09:02:00Z" };
    }
    if (request.method() === "POST" && options.loseCreateResponse && !createResponseLost) {
      createResponseLost = true;
      await route.abort();
      return;
    }
    if (request.method() === "PATCH" && options.loseEditResponse && !editResponseLost) {
      editResponseLost = true;
      await route.abort();
      return;
    }
    if (request.method() === "DELETE" && options.loseDeleteResponse && !deleteResponseLost) {
      deleteResponseLost = true;
      await route.abort();
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(objectEnvelope(current)) });
  });
  return { requests, getCurrent: () => current };
}

test.describe("B4.3 local-only Calendar mutations", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: "2026-08-12T09:00:00Z" });
  });

  test("writer gate is off and exposes no mutation controls", async ({ page }, testInfo) => {
    test.skip(!calendarRouteEnabled || calendarMutationsEnabled, "run in the gate-off CI invocation");
    await page.goto("/calendar");
    await expect(page.getByTestId("route-calendar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Создать событие" })).toHaveCount(0);
    await capture(page, testInfo, "b4-calendar-gate-off.png");
  });

  test("read-only access suppresses Calendar mutations while preserving provider readback", async ({ page }, testInfo) => {
    test.skip(!calendarRouteEnabled || !calendarMutationsEnabled, "run in the writer CI invocation");
    await installAccess(page, "read_only");
    await installEventFixtures(page);
    await page.goto("/calendar");
    await expect(page.getByRole("button", { name: "Создать событие" })).toHaveCount(0);
    await page.getByTestId("planning-calendar-event-row").filter({ hasText: "Внешняя встреча" }).tap();
    await expect(page.getByTestId("planning-calendar-detail")).toContainText("Внешний календарь · только чтение");
    await expect(page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Изменить" })).toHaveCount(0);
    await expect(page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Удалить" })).toHaveCount(0);
    await capture(page, testInfo, "b4-calendar-read-only.png");
  });

  test("standard local event flow keeps parser proposals explicit and external events read-only", async ({ page }, testInfo) => {
    test.skip(!calendarRouteEnabled || !calendarMutationsEnabled, "run in the writer CI invocation");
    await installAccess(page, "standard");
    const fixture = await installEventFixtures(page, { loseCreateResponse: true, loseEditResponse: true, loseDeleteResponse: true });
    await page.goto("/calendar");
    await expect(page.getByRole("button", { name: "Создать событие" })).toBeVisible();

    await page.getByRole("button", { name: "Создать событие" }).tap();
    const sheet = page.getByTestId("planning-calendar-mutation");
    await sheet.locator("textarea").fill("завтра вечером встреча");
    await expect(page.getByTestId("planning-calendar-ambiguities")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Сохранить" })).toBeDisabled();
    await capture(page, testInfo, "b4-calendar-ambiguous.png");
    await sheet.getByRole("button", { name: "Отмена" }).tap();

    await page.getByRole("button", { name: "Создать событие" }).tap();
    await page.getByTestId("planning-calendar-mutation").locator("textarea").fill("завтра в 18:30 встреча");
    await expect(page.getByTestId("planning-calendar-proposal")).toContainText("Предлагаемый конец");
    await expect(page.getByTestId("planning-calendar-mutation").getByRole("button", { name: "Сохранить" })).toBeDisabled();
    await capture(page, testInfo, "b4-calendar-start-only-proposal.png");
    await page.getByTestId("planning-calendar-proposal").getByRole("button", { name: "Принять 60 минут" }).tap();
    await expect(page.getByTestId("planning-calendar-mutation").getByRole("button", { name: "Сохранить" })).toBeEnabled();
    await page.getByTestId("planning-calendar-mutation").getByRole("button", { name: "Сохранить" }).tap();
    const createRequests = () => fixture.requests.filter((request) => request.method === "POST");
    await expect.poll(() => createRequests().length).toBe(2);
    expect(createRequests()[0]).toEqual(createRequests()[1]);
    await expect(page.getByText("Результат подтверждён чтением")).toBeVisible();
    await capture(page, testInfo, "b4-calendar-local-create-timed.png");
    await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Закрыть" }).tap();

    await page.getByRole("button", { name: "Создать событие" }).tap();
    await page.getByTestId("planning-calendar-mutation").locator("textarea").fill("весь день день без времени");
    await expect(page.getByTestId("planning-calendar-mutation").getByRole("button", { name: "Сохранить" })).toBeEnabled();
    await page.getByTestId("planning-calendar-mutation").getByRole("button", { name: "Сохранить" }).tap();
    await capture(page, testInfo, "b4-calendar-local-create-all-day.png");
    await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Закрыть" }).tap();
    await page.getByRole("button", { name: "Повестка" }).tap();

    await page.getByTestId("planning-calendar-event-row").filter({ hasText: "Внешняя встреча" }).tap();
    await expect(page.getByTestId("planning-calendar-detail")).toContainText("Внешний календарь · только чтение");
    await capture(page, testInfo, "b4-calendar-external-read-only.png");
    await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Закрыть" }).tap();

    await page.getByTestId("planning-calendar-event-row").filter({ hasText: "День без времени" }).tap();
    await expect(page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Изменить" })).toBeVisible();
    await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Изменить" }).tap();
    await page.getByTestId("planning-calendar-mutation").locator("textarea").fill("завтра в 18:30–19:30 новая встреча");
    await expect(page.getByTestId("planning-calendar-mutation").getByRole("button", { name: "Сохранить" })).toBeEnabled();
    await page.getByTestId("planning-calendar-mutation").getByRole("button", { name: "Сохранить" }).tap();
    await expect.poll(() => fixture.requests.filter((request) => request.method === "PATCH").length).toBe(1);
    expect(fixture.getCurrent().notes).toBe("Сохранить контекст");
    expect(fixture.getCurrent().location).toBe("Переговорная");
    await expect(page.getByText("Результат подтверждён чтением")).toBeVisible();
    await capture(page, testInfo, "b4-calendar-local-edit.png");
    await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Закрыть" }).tap();

    await page.getByTestId("planning-calendar-event-row").filter({ hasText: "Новая встреча" }).tap();
    await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Удалить" }).tap();
    await expect(page.getByTestId("action-confirmation")).toBeVisible();
    await capture(page, testInfo, "b4-calendar-delete-confirmation.png");
    await page.getByTestId("action-confirmation").getByRole("button", { name: "Отмена" }).tap();
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
    await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Удалить" }).tap();
    await page.getByTestId("action-confirmation").getByRole("button", { name: "Удалить событие" }).tap();
    await expect.poll(() => fixture.requests.filter((request) => request.method === "DELETE").length).toBe(1);
    await expect(page.getByText("Удаление подтверждено чтением")).toBeVisible();
    await capture(page, testInfo, "b4-calendar-reconciled.png");

    await page.setViewportSize({ width: 1280, height: 720 });
    await capture(page, testInfo, "b4-calendar-200-percent.png");
  });
});
