import { expect, test, type Locator, type Page } from "@playwright/test";
import { diagnosticsProblem, installDiagnosticsFixture } from "./diagnosticsFixture";

const v2Enabled = process.env.VITE_V2_VISUAL_SHELL === "true";
type Snapshot = { services: Array<Record<string, any>>; [key: string]: any };
type SnapshotMutator = (snapshot: Snapshot) => Snapshot;

async function installSnapshotMock(page: Page, mutate: SnapshotMutator) {
  let revision: number | null = null;
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = mutate(await response.json() as Snapshot);
    revision = snapshot.revision;
    await route.fulfill({ response, body: JSON.stringify(snapshot), headers: { ...response.headers(), "content-type": "application/json" } });
  });
  return {
    revision: () => {
      if (revision === null) throw new Error("Snapshot revision was not observed before diagnostics");
      return revision;
    }
  };
}

const summarySystemProblem = diagnosticsProblem("service:summary-system-service", "Системный сервис", "degraded", "Системный сервис работает с ограничениями");

async function installSystemFixture(page: Page, mutate: SnapshotMutator, problems = [] as typeof summarySystemProblem[]) {
  const snapshot = await installSnapshotMock(page, mutate);
  await installDiagnosticsFixture(page, snapshot.revision, problems);
}

function healthy(snapshot: Snapshot): Snapshot {
  return { ...snapshot, services: snapshot.services.map((service) => ({ ...service, health: "healthy" })) };
}

function withServiceAttention(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    services: snapshot.services.map((service) => service.id === "fixture-multi-action"
      ? { ...service, health: "offline", summary: "Сервис не отвечает" }
      : service)
  };
}

function systemService(health: "healthy" | "degraded") {
  return {
    id: "summary-system-service",
    title: "Системный сервис",
    enabled: true,
    dataContract: "system.summary.v1",
    health,
    source: "fixture",
    summary: health === "healthy" ? "Состояние подтверждено" : "Требуется проверка",
    actions: [],
    data: {},
    presentation: { category: "system", group: "System", overview: "none", priority: 1, freshnessLabel: "проверено только что", incidents: health === "healthy" ? 0 : 1 }
  };
}

function onlyHealthySystem(snapshot: Snapshot): Snapshot {
  return { ...healthy(snapshot), services: [systemService("healthy")] };
}

function systemAttention(snapshot: Snapshot): Snapshot {
  return { ...healthy(snapshot), services: [systemService("degraded")] };
}

function noSystemServices(snapshot: Snapshot): Snapshot {
  return { ...healthy(snapshot), services: [] };
}

async function expectNoOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function expectGeometry(summary: Locator, hasEyebrow: boolean) {
  const metrics = await summary.evaluate((element) => {
    const rect = (node: Element | null) => {
      if (!node) throw new Error("Expected summary child");
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const outer = rect(element);
    const status = rect(element.querySelector(".v2-status-text"));
    const detail = rect(element.querySelector(".v2-operational-status-summary__detail"));
    const eyebrow = element.querySelector(".section-kicker");
    return { outer, status, detail, eyebrow: eyebrow ? rect(eyebrow) : null, overflow: element.scrollWidth > element.clientWidth };
  });
  expect(metrics.outer.height).toBeGreaterThanOrEqual(84);
  expect(metrics.overflow).toBe(false);
  expect(metrics.status.x).toBeGreaterThanOrEqual(metrics.outer.x - 1);
  expect(metrics.detail.right).toBeLessThanOrEqual(metrics.outer.right + 1);
  if (hasEyebrow) expect(metrics.eyebrow).not.toBeNull();
}

test.describe("#106 shared operational status summary", () => {
  test.skip(!v2Enabled, "Run with VITE_V2_VISUAL_SHELL=true for the V2 browser gate.");

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("keeps Services aggregate copy and shared marker for healthy and attention states", async ({ page }) => {
    await installSnapshotMock(page, healthy);
    await page.goto("/services");
    const summary = page.getByTestId("services-attention-summary");
    await expect(summary).toHaveAttribute("data-operational-status-summary", "true");
    await expect(summary).toContainText("Всё в норме");
    await expect(summary).toContainText("5 в норме · 0 деградировали или устарели · 0 недоступны");
    await expectGeometry(summary, false);

    await page.unroute("**/api/v1/snapshot**");
    await installSnapshotMock(page, withServiceAttention);
    await page.goto("/services");
    await expect(summary).toContainText("Требуют внимания · 1");
    await expect(summary).toContainText("4 в норме · 0 деградировали или устарели · 1 недоступны");
    await expect(summary).toHaveClass(/v2-operational-status-summary--attention/);
  });

  test("keeps System aggregate copy, eyebrow, attention, and unavailable states", async ({ page }) => {
    await installSystemFixture(page, onlyHealthySystem);
    await page.goto("/system");
    const summary = page.getByTestId("system-aggregate-strip");
    await expect(summary).toHaveAttribute("data-operational-status-summary", "true");
    await expect(summary.locator(".section-kicker")).toHaveText("Диагностика и хосты");
    await expect(summary).toContainText("В норме");
    await expect(summary).toContainText("0 текущих проблем · 1 системных сервисов в норме");
    await expectGeometry(summary, true);

    await page.unroute("**/api/v1/snapshot**");
    await page.unroute(/\/api\/v1\/diagnostics(?:\?.*)?$/);
    await installSystemFixture(page, systemAttention, [summarySystemProblem]);
    await page.goto("/system");
    await expect(summary).toContainText("Требуют внимания · 1");
    await expect(summary).toContainText("1 текущих проблем · 0 системных сервисов в норме");
    await expect(summary).toHaveClass(/v2-operational-status-summary--attention/);

    await page.unroute("**/api/v1/snapshot**");
    await page.unroute(/\/api\/v1\/diagnostics(?:\?.*)?$/);
    await installSystemFixture(page, noSystemServices);
    await page.goto("/system");
    await expect(summary).toContainText("Состояние недоступно");
    await expect(summary).toContainText("Нет подтверждённых системных сервисов");
  });

  test("contains both summaries at desktop and narrow widths and excludes Home", async ({ page }) => {
    for (const width of [1280, 640]) {
      await page.setViewportSize({ width, height: 720 });
      await page.goto("/services");
      await expectGeometry(page.getByTestId("services-attention-summary"), false);
      await expectNoOverflow(page);
      await page.goto("/system");
      await expectGeometry(page.getByTestId("system-aggregate-strip"), true);
      await expectNoOverflow(page);
    }
    await page.goto("/home?scenario=home-coffee-kettle");
    await expect(page.getByTestId("home-authority-line")).not.toHaveAttribute("data-operational-status-summary", "true");
    await expect(page.locator("[data-operational-status-summary='true']")).toHaveCount(0);
  });
});
