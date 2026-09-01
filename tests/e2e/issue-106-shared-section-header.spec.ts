import { expect, test, type Locator, type Page } from "@playwright/test";

const v2Enabled = process.env.VITE_V2_VISUAL_SHELL === "true";

type Snapshot = { services: Array<Record<string, any>>; [key: string]: any };
type SnapshotMutator = (snapshot: Snapshot) => Snapshot;

async function installSnapshotMock(page: Page, mutate: SnapshotMutator) {
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = mutate(await response.json() as Snapshot);
    await route.fulfill({
      response,
      body: JSON.stringify(snapshot),
      headers: { ...response.headers(), "content-type": "application/json" }
    });
  });
}

function withAdditionalHomeDevice(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    services: snapshot.services.map((service) => service.id === "fixture-multi-action"
      ? { ...service, presentation: { ...service.presentation, category: "home-device" } }
      : service)
  };
}

function allHealthy(snapshot: Snapshot): Snapshot {
  return { ...snapshot, services: snapshot.services.map((service) => ({ ...service, health: "healthy" })) };
}

function withAttention(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    services: snapshot.services.map((service) => service.id === "fixture-multi-action"
      ? { ...service, health: "offline", summary: "Сервис не отвечает" }
      : service)
  };
}

type Bounds = { x: number; y: number; right: number; bottom: number };

async function expectContained(header: Locator) {
  const metrics = await header.evaluate((element) => {
    const bounds = (node: Element | null): Bounds => {
      if (!node) throw new Error("Expected section header child");
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
    };
    const outer = bounds(element);
    return {
      outer,
      title: bounds(element.querySelector("h2")),
      metadata: bounds(element.querySelector(":scope > span")),
      overflow: element.scrollWidth > element.clientWidth
    };
  });
  for (const inner of [metrics.title, metrics.metadata]) {
    expect(inner.x).toBeGreaterThanOrEqual(metrics.outer.x - 1);
    expect(inner.right).toBeLessThanOrEqual(metrics.outer.right + 1);
    expect(inner.y).toBeGreaterThanOrEqual(metrics.outer.y - 1);
    expect(inner.bottom).toBeLessThanOrEqual(metrics.outer.bottom + 1);
  }
  expect(metrics.overflow).toBe(false);
}

async function expectNoDocumentOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
}

test.describe("#106 shared operational section header", () => {
  test.skip(!v2Enabled, "Run with VITE_V2_VISUAL_SHELL=true for the V2 browser gate.");

  test("Home and healthy Services use the shared semantic header contract", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await installSnapshotMock(page, withAdditionalHomeDevice);
    await page.goto("/home?scenario=home-coffee-kettle");
    const homeHeader = page.getByTestId("home-secondary-devices").locator("[data-section-header]");
    await expect(homeHeader).toBeVisible();
    await expect(homeHeader.locator(".section-kicker")).toHaveText("Дом");
    await expect(homeHeader.locator("h2")).toHaveText("Другие устройства");
    await expect(homeHeader.locator(":scope > span")).toHaveText("1");
    await expect(homeHeader.locator("h2")).toHaveCount(1);
    await expectContained(homeHeader);
    await expectNoDocumentOverflow(page);

    await page.unroute("**/api/v1/snapshot**");
    await installSnapshotMock(page, allHealthy);
    await page.goto("/services");
    const servicesHeader = page.getByTestId("services-attention-zone").locator("[data-section-header]");
    await expect(servicesHeader).toBeVisible();
    await expect(servicesHeader.locator(".section-kicker")).toHaveText("Операционная зона");
    await expect(servicesHeader.locator("h2")).toHaveText("Сервисные состояния");
    await expect(servicesHeader.locator(":scope > span")).toHaveText("Нет открытых состояний");
    await expect(servicesHeader.locator("h2")).toHaveCount(1);
    await expectContained(servicesHeader);
    await expectNoDocumentOverflow(page);
  });

  test("Services retains attention copy and both headers remain contained at 640px", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 720 });
    await installSnapshotMock(page, withAdditionalHomeDevice);
    await page.goto("/home?scenario=home-coffee-kettle");
    const homeHeader = page.getByTestId("home-secondary-devices").locator("[data-section-header]");
    await expect(homeHeader).toBeVisible();
    await expectContained(homeHeader);
    await expectNoDocumentOverflow(page);

    await page.unroute("**/api/v1/snapshot**");
    await installSnapshotMock(page, withAttention);
    await page.goto("/services");
    const servicesHeader = page.getByTestId("services-attention-zone").locator("[data-section-header]");
    await expect(servicesHeader).toBeVisible();
    await expect(servicesHeader.locator("h2")).toHaveText("Сначала проверьте эти сервисы");
    await expect(servicesHeader.locator(":scope > span")).toHaveText("1 требуют внимания");
    await expect(servicesHeader.locator("h2")).toHaveCount(1);
    await expectContained(servicesHeader);
    await expectNoDocumentOverflow(page);
  });
});
