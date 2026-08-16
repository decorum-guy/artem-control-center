import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const localId = "00000000-0000-4000-8000-000000001001";
const timedId = "00000000-0000-4000-8000-000000001002";
const allDayId = "00000000-0000-4000-8000-000000001003";
const sourceId = "external-icloud-phase-b";
const workCalendarId = "calendar-icloud-work";
const homeCalendarId = "calendar-icloud-home";

const artifactDirectory = (testInfo: TestInfo) =>
  process.env.ICLOUD_CALENDAR_PHASE_B_ARTIFACT_DIR ?? testInfo.outputPath("icloud-calendar-phase-b-review");

const nativeSource = {
  id: "native-planning",
  kind: "native",
  provider: "local",
  label: "Local Planning",
  status: "current",
  configured: true,
  lastSyncedAt: "2026-08-12T09:00:00Z",
  observedAt: "2026-08-12T09:00:00Z",
  calendars: []
};

function externalSource(status: "current" | "stale" | "error" | "disabled" | "not_configured" = "current") {
  return {
    id: sourceId,
    kind: "external",
    provider: "icloud",
    label: "iCloud",
    status,
    configured: status !== "not_configured",
    lastSyncedAt: status === "not_configured" ? null : "2026-08-12T08:42:00Z",
    observedAt: "2026-08-12T09:00:00Z",
    calendars: [
      {
        id: workCalendarId,
        label: "Работа · #a1b2c3",
        color: null,
        enabled: true,
        status,
        lastSyncedAt: status === "not_configured" ? null : "2026-08-12T08:42:00Z",
        observedAt: "2026-08-12T09:00:00Z"
      },
      {
        id: homeCalendarId,
        label: "Работа · #d4e5f6",
        color: "#4477AA",
        enabled: true,
        status,
        lastSyncedAt: status === "not_configured" ? null : "2026-08-12T08:42:00Z",
        observedAt: "2026-08-12T09:00:00Z"
      }
    ]
  };
}

const localEvent = {
  id: localId,
  version: 1,
  source: "panel-agent",
  sourceLabel: "Panel Agent",
  calendarIdentity: { providerId: "native-planning", providerLabel: "Local Planning", calendarId: "local", calendarLabel: "Локальный" },
  title: "Локальная встреча",
  notes: "Локальный контекст",
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

const timedIcloudEvent = {
  ...localEvent,
  id: timedId,
  source: "calendar-provider",
  sourceLabel: "Calendar provider",
  calendarIdentity: { providerId: sourceId, providerLabel: "iCloud", calendarId: workCalendarId, calendarLabel: "Работа · #a1b2c3" },
  title: "<img src=x onerror=alert(1)>",
  notes: "Заметка внешнего события",
  location: "Apple Park",
  syncState: "synced",
  localOnlyMutable: false,
  updatedAt: "2026-08-12T09:02:00Z"
};

const allDayIcloudEvent = {
  ...timedIcloudEvent,
  id: allDayId,
  calendarIdentity: { providerId: sourceId, providerLabel: "iCloud", calendarId: homeCalendarId, calendarLabel: "Работа · #d4e5f6" },
  title: "Внешний день",
  allDay: true,
  startAtUtc: null,
  endAtUtc: null,
  startDate: "2026-08-12",
  endDateExclusive: "2026-08-13"
};

function listEnvelope(items: Array<Record<string, unknown>>, sources: unknown[]) {
  return {
    schemaVersion: "planning.panel.v1",
    kind: "list",
    domain: "calendar_event",
    generatedAt: "2026-08-12T09:00:00Z",
    sourceStatus: "current",
    lastSyncedAt: "2026-08-12T09:00:00Z",
    staleAfter: "2026-08-12T09:05:00Z",
    sources,
    items,
    limit: 20,
    offset: 0,
    count: items.length,
    hasMore: false
  };
}

function objectEnvelope(object: Record<string, unknown>, sources: unknown[]) {
  return {
    schemaVersion: "planning.panel.v1",
    kind: "object",
    domain: "calendar_event",
    object,
    sourceStatus: "current",
    lastSyncedAt: "2026-08-12T09:00:00Z",
    staleAfter: "2026-08-12T09:05:00Z",
    sources
  };
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const directory = artifactDirectory(testInfo);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), animations: "disabled" });
}

async function installAccess(page: Page): Promise<void> {
  await page.route("**/api/v1/access", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const capabilities = ["planning.calendar.create", "planning.calendar.edit", "planning.calendar.delete"];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        baseProfile: "standard",
        effectiveProfile: "standard",
        temporaryFull: false,
        temporaryFullExpiresAt: null,
        pinConfigured: true,
        lockoutUntil: null,
        capabilities: Object.fromEntries(capabilities.map((capability) => [capability, {
          capability,
          minimumProfile: "standard",
          effectiveProfile: "standard",
          allowed: true,
          availability: "allowed"
        }]))
      })
    });
  });
}

type FixtureOptions = {
  sourceStatus?: "current" | "stale" | "error" | "disabled" | "not_configured";
  includeIcloudEvents?: boolean;
  mutation?: boolean;
};

async function installCalendarFixtures(page: Page, options: FixtureOptions = {}) {
  const sourceStatus = options.sourceStatus ?? "current";
  const sources = [nativeSource, externalSource(sourceStatus)];
  let currentLocal = { ...localEvent } as Record<string, unknown>;
  const requests: string[] = [];
  const items = () => options.includeIcloudEvents === false
    ? [currentLocal]
    : [currentLocal, timedIcloudEvent, allDayIcloudEvent];

  await page.route(/\/api\/v1\/planning\/events(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/events")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(listEnvelope(items(), sources)) });
      return;
    }
    if (request.method() === "GET") {
      const event = url.pathname.endsWith(`/${localId}`) ? currentLocal : timedIcloudEvent;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(objectEnvelope(event, sources)) });
      return;
    }
    requests.push(request.method());
    if (!options.mutation) {
      await route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ detail: "read_only_fixture" }) });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    if (request.method() === "PATCH") {
      currentLocal = { ...currentLocal, title: body.title ?? currentLocal.title, version: 2, updatedAt: "2026-08-12T09:03:00Z" };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(objectEnvelope(currentLocal, sources)) });
  });

  if (options.mutation) {
    await page.route("**/api/v1/planning/parse", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: "planning.v1",
          kind: "parse_preview",
          candidate: {
            domain: "calendar_event",
            operation: "create",
            fields: {
              title: "Обновлённая локальная встреча",
              all_day: false,
              timezone: "Europe/Moscow",
              start_at_utc: "2026-08-12T10:00:00Z",
              end_at_utc: "2026-08-12T11:00:00Z"
            },
            normalized_paraphrase: "Обновлённая локальная встреча"
          },
          confidence: "high",
          ambiguities: [],
          requires_confirmation: false,
          normalized_text: "Обновлённая локальная встреча",
          error_code: null,
          correlation_id: "00000000-0000-4000-8000-000000000099"
        })
      });
    });
  }
  return { requests };
}

test.describe("Issue #22 read-only iCloud Calendar Phase B", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: "2026-08-12T09:00:00Z" });
  });

  test("combined current agenda keeps source identities, all-day semantics, overlap, and literal text", async ({ page }, testInfo) => {
    await installCalendarFixtures(page);
    await page.goto("/calendar?theme=day");
    await expect(page.getByTestId("planning-source-strip")).toContainText("iCloud");
    await expect(page.getByTestId("planning-source").filter({ hasText: "актуально" })).toHaveCount(2);
    await expect(page.getByTestId("planning-calendar-identity").filter({ hasText: "iCloud · Работа · #a1b2c3" })).toBeVisible();
    await expect(page.getByTestId("planning-calendar-identity").filter({ hasText: "iCloud · Работа · #d4e5f6" })).toBeVisible();
    await expect(page.getByTestId("planning-calendar-all-day-band")).toContainText("Внешний день");
    await expect(page.getByTestId("planning-calendar-event-row").filter({ hasText: "<img src=x onerror=alert(1)>" })).toBeVisible();
    await expect(page.getByTestId("planning-calendar-event-row").filter({ hasText: "<img src=x onerror=alert(1)>" }).locator("img,script")).toHaveCount(0);
    await expect(page.getByTestId("planning-calendar-event-row").filter({ hasText: "<img src=x onerror=alert(1)>" })).toHaveAttribute("data-overlap", "true");
    await capture(page, testInfo, "icloud-combined-current.png");
    await capture(page, testInfo, "icloud-same-name-calendars.png");
    await capture(page, testInfo, "icloud-all-day-and-timed.png");
  });

  test("stale cached iCloud stays visible and marks only external rows", async ({ page }, testInfo) => {
    await installCalendarFixtures(page, { sourceStatus: "stale" });
    await page.goto("/calendar?theme=day");
    await expect(page.getByTestId("planning-source").filter({ hasText: "сохранённая копия" })).toBeVisible();
    await expect(page.getByTestId("planning-source-strip")).toContainText("обновлено 11:42");
    await expect(page.getByTestId("planning-calendar-stale-cue")).toHaveCount(2);
    await expect(page.getByTestId("planning-calendar-event-row").filter({ hasText: "Локальная встреча" }).getByTestId("planning-calendar-stale-cue")).toHaveCount(0);
    await page.getByTestId("planning-calendar-event-row").filter({ hasText: "<img src=x onerror=alert(1)>" }).tap();
    await expect(page.getByTestId("planning-calendar-detail")).toContainText("Сохранённая копия");
    await expect(page.getByTestId("planning-calendar-detail")).toContainText("Последнее обновление");
    await capture(page, testInfo, "icloud-stale-cache.png");
  });

  test("provider error with native current keeps Calendar readable", async ({ page }, testInfo) => {
    await installCalendarFixtures(page, { sourceStatus: "error", includeIcloudEvents: false });
    await page.goto("/calendar?theme=day");
    await expect(page.getByTestId("route-calendar")).toBeVisible();
    await expect(page.getByTestId("planning-source").filter({ hasText: "недоступен" })).toBeVisible();
    await expect(page.getByTestId("planning-calendar-event-row").filter({ hasText: "Локальная встреча" })).toBeVisible();
    await expect(page.getByTestId("planning-route-error")).toHaveCount(0);
    await capture(page, testInfo, "icloud-error-native-current.png");
  });

  test("local mutation remains available while iCloud is stale and external detail is read-only", async ({ page }, testInfo) => {
    await installAccess(page);
    const fixture = await installCalendarFixtures(page, { sourceStatus: "stale", mutation: true });
    await page.goto("/calendar?theme=day");
    await page.getByTestId("planning-calendar-event-row").filter({ hasText: "Локальная встреча" }).tap();
    const localDetail = page.getByTestId("planning-calendar-detail");
    await expect(localDetail.getByRole("button", { name: "Изменить" })).toBeVisible();
    await expect(localDetail.getByRole("button", { name: "Удалить" })).toBeVisible();
    await localDetail.getByRole("button", { name: "Изменить" }).tap();
    await page.getByTestId("planning-calendar-mutation").locator("textarea").fill("Обновлённая локальная встреча");
    await page.getByTestId("planning-calendar-mutation").getByRole("button", { name: "Сохранить" }).tap();
    await expect.poll(() => fixture.requests).toContain("PATCH");
    await page.getByTestId("planning-calendar-detail").getByRole("button", { name: "Закрыть" }).tap();
    await page.getByTestId("planning-calendar-event-row").filter({ hasText: "<img src=x onerror=alert(1)>" }).tap();
    const externalDetail = page.getByTestId("planning-calendar-detail");
    await expect(externalDetail).toContainText("только чтение");
    await expect(externalDetail.getByRole("button", { name: "Изменить" })).toHaveCount(0);
    await expect(externalDetail.getByRole("button", { name: "Удалить" })).toHaveCount(0);
    await capture(page, testInfo, "icloud-local-mutable-while-provider-stale.png");
    await capture(page, testInfo, "icloud-external-read-only.png");
  });

  test("disabled and not-configured sources are calm and do not become global outage", async ({ page }) => {
    await installCalendarFixtures(page, { sourceStatus: "disabled", includeIcloudEvents: false });
    await page.goto("/calendar?theme=day");
    await expect(page.getByTestId("planning-source").filter({ hasText: "отключён" })).toBeVisible();
    await expect(page.getByTestId("planning-route-error")).toHaveCount(0);
    await page.unroute(/\/api\/v1\/planning\/events(?:\/[^/?]+)?(?:\?.*)?$/);
    await installCalendarFixtures(page, { sourceStatus: "not_configured", includeIcloudEvents: false });
    await page.reload();
    await expect(page.getByTestId("planning-source").filter({ hasText: "не настроен" })).toBeVisible();
    await expect(page.getByTestId("planning-route-error")).toHaveCount(0);
  });

  test("150 percent Samsung geometry has no horizontal overflow", async ({ page }, testInfo) => {
    await installCalendarFixtures(page);
    await page.setViewportSize({ width: 960, height: 720 });
    await page.goto("/calendar?theme=day");
    await expect(page.getByTestId("planning-source-strip")).toBeVisible();
    await expect(page.getByTestId("planning-calendar-event-row")).toHaveCount(3);
    const dimensions = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
    await capture(page, testInfo, "icloud-150-percent.png");
  });
});
