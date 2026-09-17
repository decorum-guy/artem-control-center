import type { Page } from "@playwright/test";

/**
 * The visual-review layout is deliberately independent of both the mutable
 * Samsung layout store and the no-file shipped fallback. It encodes the
 * canonical Overview Coffee composition approved in #202; it is not a copy
 * of any machine-local configuration.
 */
const canonicalCoffeeReviewLayout = {
  schemaVersion: "overview.layout.v2",
  profileId: "samsung-control",
  presetId: "overview.default",
  presetVersion: 3,
  revision: 173,
  viewportClass: "landscape-12",
  updatedAt: "2026-09-05T20:25:59+00:00",
  writesEnabled: false,
  warnings: [],
  unplaced: [],
  items: [
    {
      instanceId: "fixture.rog",
      widgetType: "system.rog-g703-operational",
      visibility: "visible",
      placement: { x: 0, y: 0, w: 12, h: 1 },
      sizeVariant: "standard",
      config: {}
    },
    {
      instanceId: "fixture.coffee",
      widgetType: "home.coffee-machine",
      visibility: "visible",
      placement: { x: 0, y: 1, w: 7, h: 4 },
      sizeVariant: "standard",
      config: {
        imageScalePct: 100,
        imageXStep: 0,
        imageYStep: 0,
        composition: "auto",
        buttonLayout: "balanced",
        showStateMarker: true,
        showAuthority: true,
        showImage: true
      }
    },
    {
      instanceId: "fixture.planning",
      widgetType: "planning.summary",
      visibility: "visible",
      placement: { x: 7, y: 1, w: 5, h: 4 },
      sizeVariant: "standard",
      config: {}
    },
    {
      instanceId: "fixture.climate",
      widgetType: "home.climate",
      visibility: "visible",
      placement: { x: 0, y: 5, w: 7, h: 4 },
      sizeVariant: "standard",
      config: {}
    },
    {
      instanceId: "fixture.health",
      widgetType: "system.health-summary",
      visibility: "visible",
      placement: { x: 7, y: 5, w: 5, h: 2 },
      sizeVariant: "compact",
      config: {}
    }
  ]
} as const;

export async function installCanonicalCoffeeVisualReviewLayout(page: Page): Promise<void> {
  await page.route("**/api/v1/overview/layout", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        ETag: '"173"',
        "X-Overview-Layout-Writes-Enabled": "false"
      },
      body: JSON.stringify(canonicalCoffeeReviewLayout)
    });
  });
}
