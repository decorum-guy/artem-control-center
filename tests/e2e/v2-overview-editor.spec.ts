import { expect, test, type Page } from "@playwright/test";
import { unlockTouchLockIfNeeded } from "./touch-lock-test-helpers";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const overviewV2Enabled = process.env.VITE_OVERVIEW_V2_ENABLED === "true";
const overviewEditorEnabled = process.env.VITE_OVERVIEW_EDITOR_ENABLED === "true";

type LayoutItem = {
  instanceId: string;
  widgetType: string;
  visibility: "visible" | "hidden";
  placement: { x: number; y: number; w: number; h: number };
  sizeVariant: string;
  config: Record<string, boolean | number | string>;
};

type LayoutDocument = {
  schemaVersion: "overview.layout.v2";
  profileId: "samsung-control";
  presetId: "overview.default";
  presetVersion: 2;
  revision: number;
  viewportClass: "landscape-12";
  updatedAt: string;
  items: LayoutItem[];
  warnings: string[];
  unplaced: never[];
  writesEnabled: true;
};

type PatchMode = "success" | "conflict" | "validation-error" | "server-error" | "abort" | "abort-different" | "abort-unavailable";
type LayoutGateMode = "writer-true" | "writer-false" | "metadata-missing";

function artifactDirectory(testInfo: { outputPath: (name: string) => string }): string {
  return process.env.V2_OVERVIEW_EDITOR_ARTIFACT_DIR ?? testInfo.outputPath("v2-overview-editor-review");
}

async function captureArtifact(
  page: Page,
  testInfo: { outputPath: (name: string) => string },
  name: string
): Promise<void> {
  const directory = artifactDirectory(testInfo);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), animations: "disabled" });
}

const foundationItems: LayoutItem[] = [
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
    config: { density: "comfortable" }
  },
  {
    instanceId: "fixture.quick-actions",
    widgetType: "home.quick-actions",
    visibility: "visible",
    placement: { x: 0, y: 5, w: 7, h: 2 },
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
];

function cloneItems(items: readonly LayoutItem[] = foundationItems): LayoutItem[] {
  return items.map((item) => ({
    ...item,
    placement: { ...item.placement },
    config: { ...item.config }
  }));
}

function makeDocument(revision = 0, items: readonly LayoutItem[] = foundationItems): LayoutDocument {
  return {
    schemaVersion: "overview.layout.v2",
    profileId: "samsung-control",
    presetId: "overview.default",
    presetVersion: 2,
    revision,
    viewportClass: "landscape-12",
    updatedAt: "2026-08-14T12:00:00+00:00",
    items: cloneItems(items),
    warnings: [],
    unplaced: [],
    writesEnabled: true
  };
}

async function installLayoutRoute(
  page: Page,
  initialMode: PatchMode = "success",
  initialItems: readonly LayoutItem[] = foundationItems
) {
  const state: {
    document: LayoutDocument;
    mode: PatchMode;
    getCount: number;
    patchCount: number;
    lastPatch: LayoutItem[] | null;
  } = {
    document: makeDocument(0, initialItems),
    mode: initialMode,
    getCount: 0,
    patchCount: 0,
    lastPatch: null
  };

  await page.route("**/api/v1/overview/layout*", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      state.getCount += 1;
      if (state.mode === "abort-unavailable" && state.patchCount >= 1 && state.getCount >= 2) {
        await route.abort("connectionreset");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "cache-control": "no-store",
          etag: `"${state.document.revision}"`,
          "x-overview-layout-writes-enabled": "true"
        },
        body: JSON.stringify(state.document)
      });
      return;
    }

    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }

    state.patchCount += 1;
    const body = request.postDataJSON() as { items?: LayoutItem[] };
    state.lastPatch = cloneItems(body.items ?? []);
    if (state.mode === "conflict") {
      state.document = makeDocument(1);
      await route.fulfill({
        status: 412,
        contentType: "application/json",
        body: JSON.stringify({ detail: "revision_conflict" })
      });
      return;
    }

    if (state.mode === "validation-error" || state.mode === "server-error") {
      await route.fulfill({
        status: state.mode === "validation-error" ? 422 : 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: state.mode === "validation-error" ? "invalid_overview_layout_patch" : "internal_error" })
      });
      return;
    }

    if (state.mode === "abort" || state.mode === "abort-different" || state.mode === "abort-unavailable") {
      state.document = state.mode === "abort-different" ? makeDocument(1) : makeDocument(1, state.lastPatch);
      await route.abort("connectionreset");
      return;
    }

    state.document = makeDocument(state.document.revision + 1, state.lastPatch);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "cache-control": "no-store",
        etag: `"${state.document.revision}"`
      },
      body: JSON.stringify(state.document)
    });
  });

  return state;
}

async function openEditor(page: Page, url = "/overview?theme=night"): Promise<void> {
  await page.goto(url);
  await unlockTouchLockIfNeeded(page);
  await expect(page.getByTestId("route-overview-v2")).toBeVisible();
  await expect(page.getByTestId("overview-configure")).toBeEnabled();
  await page.getByTestId("overview-configure").click();
  await expect(page.getByTestId("overview-edit-toolbar")).toBeVisible();
  await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "editing");
}

async function installLayoutGateRoute(page: Page, mode: LayoutGateMode): Promise<{ patchCount: () => number }> {
  let patches = 0;
  await page.route("**/api/v1/overview/layout*", async (route) => {
    if (route.request().method() !== "GET") {
      patches += route.request().method() === "PATCH" ? 1 : 0;
      await route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ detail: "layout_write_not_expected" }) });
      return;
    }
    const document = makeDocument();
    const payload = mode === "metadata-missing"
      ? Object.fromEntries(Object.entries(document).filter(([key]) => key !== "writesEnabled"))
      : { ...document, writesEnabled: mode === "writer-true" };
    const headers: Record<string, string> = { "cache-control": "no-store", etag: '"0"' };
    if (mode !== "metadata-missing") headers["x-overview-layout-writes-enabled"] = String(mode === "writer-true");
    await route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(payload) });
  });
  return { patchCount: () => patches };
}

async function selectFrame(page: Page, instanceId: string): Promise<void> {
  await page.locator(`.overview-edit-frame[data-instance-id="${instanceId}"]`).press("Enter");
}

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

function rectIntersects(left: Rect, right: Rect): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

async function assertEditorChromeGeometry(page: Page, instanceId: string, neighborIds: string[]): Promise<void> {
  const geometry = await page.evaluate(({ instanceId: currentId, neighborIds: currentNeighborIds }) => {
    const rectFor = (element: Element | null): Rect | null => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const frame = document.querySelector(`.overview-edit-frame[data-instance-id="${currentId}"]`);
    const controls = Array.from(frame?.querySelectorAll(
      ".overview-edit-frame__drag-handle, .overview-edit-frame__actions button, .overview-edit-frame__resize-handle, .overview-edit-frame__menu-toggle, .overview-edit-frame__size"
    ) ?? []).map((element) => ({
      className: element.className,
      label: element.getAttribute("aria-label") ?? "",
      rect: rectFor(element),
      visualRect: element.classList.contains("overview-edit-frame__size") ? rectFor(element) : (() => {
        const rect = rectFor(element);
        return rect ? { ...rect, left: rect.left + 8, top: rect.top + 8, right: rect.right - 8, bottom: rect.bottom - 8, width: rect.width - 16, height: rect.height - 16 } : null;
      })()
    }));
    const neighbors = Object.fromEntries(currentNeighborIds.map((neighborId) => [
      neighborId,
      rectFor(document.querySelector(`.overview-edit-frame[data-instance-id="${neighborId}"]`))
    ]));
    const semanticSelectors = currentId === "fixture.rog"
      ? [
          ".overview-rog-widget__identity",
          ".overview-rog-widget__status",
          ".overview-rog-widget__freshness",
          ".overview-rog-widget__action",
          ".overview-rog-widget__unavailable"
        ]
      : currentId === "fixture.quick-actions"
        ? [
            ".overview-home-widget__heading h2",
            ".overview-home-widget__cell-kicker",
            ".overview-home-widget__cell strong",
            ".overview-home-widget__cell-state"
          ]
        : currentId === "fixture.health"
          ? [
              ".overview-health-widget__heading h2",
              ".overview-health-widget__aggregate",
              ".overview-health-widget__incident",
              ".overview-health-widget__footer",
              ".overview-health-widget__recovery-slot"
            ]
          : [];
    return {
      frame: rectFor(frame),
      controls,
      neighbors,
      semanticContent: semanticSelectors
        .map((selector) => rectFor(frame?.querySelector(selector) ?? null))
        .filter(Boolean),
      coffeeContent: currentId === "fixture.coffee"
        ? [
            ".coffee-panel--overview .coffee-panel__heading h2",
            ".coffee-panel--overview .coffee-panel__heading .v2-status-text",
            ".coffee-panel--overview .coffee-panel__state",
            ".coffee-panel--overview .coffee-authority",
            ".coffee-panel--overview .coffee-asset",
            ".coffee-panel--overview .coffee-state-marker"
          ].map((selector) => ({ selector, rect: rectFor(frame?.querySelector(selector) ?? null) })).filter(({ rect }) => rect)
        : []
    };
  }, { instanceId, neighborIds });

  expect(geometry.frame).not.toBeNull();
  for (const control of geometry.controls) {
    if (!control.className.includes("overview-edit-frame__size")) {
      expect(control.rect?.width ?? 0, control.className).toBeGreaterThanOrEqual(48);
      expect(control.rect?.height ?? 0, control.className).toBeGreaterThanOrEqual(48);
    }
    for (const neighborId of neighborIds) {
      const neighbor = geometry.neighbors[neighborId as keyof typeof geometry.neighbors];
      if (control.rect && neighbor) expect(rectIntersects(control.rect, neighbor)).toBe(false);
    }
    if (instanceId === "fixture.coffee") {
      for (const content of geometry.coffeeContent) {
        if (control.visualRect && content.rect) expect(rectIntersects(control.visualRect, content.rect), `${control.label} intersects ${content.selector}`).toBe(false);
      }
    }
    if (instanceId === "fixture.rog" || instanceId === "fixture.quick-actions" || instanceId === "fixture.health") {
      for (const content of geometry.semanticContent) {
        if (control.visualRect && content) expect(rectIntersects(control.visualRect, content), `${control.label} intersects semantic content`).toBe(false);
      }
    }
  }
}

async function assertCoffeeContentGeometry(page: Page, scenarioLabel = "current Coffee state"): Promise<void> {
  const geometry = await page.evaluate(() => {
    const rectFor = (element: Element | null): Rect | null => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const coffee = document.querySelector(".coffee-panel--overview");
    const asset = rectFor(coffee?.querySelector(".coffee-asset") ?? null);
    const image = rectFor(coffee?.querySelector(".coffee-asset__image") ?? null);
    const activity = rectFor(coffee?.querySelector(".coffee-activity") ?? null);
    const activityBars = Array.from(coffee?.querySelectorAll(".coffee-activity i") ?? []).map((element) => rectFor(element)).filter(Boolean);
    const semanticContent = [
      ".coffee-panel__heading h2",
      ".coffee-panel__heading .health-mark",
      ".coffee-panel__state",
      ".coffee-progress",
      ".coffee-policy-note",
      ".coffee-panel__copy .primary-action",
      ".coffee-authority",
      ".coffee-state-marker"
    ].map((selector) => ({ selector, rect: rectFor(coffee?.querySelector(selector) ?? null) })).filter(({ rect }) => rect);
    return { asset, image, activity, activityBars, semanticContent };
  });

  expect(geometry.image).not.toBeNull();
  if (geometry.asset && geometry.activity) {
    expect(geometry.activity.left).toBeGreaterThanOrEqual(geometry.asset.left - 1);
    expect(geometry.activity.right).toBeLessThanOrEqual(geometry.asset.right + 1);
    expect(geometry.activity.top).toBeGreaterThanOrEqual(geometry.asset.top - 1);
    expect(geometry.activity.bottom).toBeLessThanOrEqual(geometry.asset.bottom + 1);
    const gap = geometry.image!.top - geometry.activity.bottom;
    expect(gap, `${scenarioLabel}: activity-to-image gap`).toBeGreaterThanOrEqual(3);
    expect(gap, `${scenarioLabel}: activity-to-image gap`).toBeLessThanOrEqual(18);
    expect(rectIntersects(geometry.activity, geometry.image), `${scenarioLabel}: activity intersects image`).toBe(false);
    const activityVisualBottom = Math.max(...geometry.activityBars.map((bar) => bar!.bottom));
    const activityVisualGap = geometry.image!.top - activityVisualBottom;
    expect(activityVisualGap, `${scenarioLabel}: animated activity-to-image gap`).toBeGreaterThanOrEqual(2);
    expect(activityVisualGap, `${scenarioLabel}: animated activity-to-image gap`).toBeLessThanOrEqual(16);
    for (const bar of geometry.activityBars) {
      if (bar) expect(rectIntersects(bar, geometry.image), `${scenarioLabel}: animated activity intersects image`).toBe(false);
    }
  }
  for (const content of geometry.semanticContent) {
    if (geometry.image) expect(rectIntersects(geometry.image, content.rect), `${scenarioLabel}: image intersects ${content.selector}`).toBe(false);
    if (geometry.activity) expect(rectIntersects(geometry.activity, content.rect), `${scenarioLabel}: activity intersects ${content.selector}`).toBe(false);
  }
  for (const bar of geometry.activityBars) {
    for (const content of geometry.semanticContent) {
      if (bar) expect(rectIntersects(bar, content.rect), `${scenarioLabel}: activity intersects ${content.selector}`).toBe(false);
    }
  }
}

async function assertCoffeeActivityHidden(page: Page): Promise<void> {
  await expect(page.locator(".coffee-panel--overview .coffee-activity")).toHaveCount(0);
  await expect(page.locator(".coffee-panel--overview .coffee-panel__state strong")).toHaveText("Разогревается");
}

async function assertCoffeeActivityPhases(page: Page): Promise<void> {
  for (const phase of [0.1, 0.8, 1.5]) {
    await page.evaluate((phaseOffset) => {
      document.querySelectorAll(".coffee-activity i").forEach((element, index) => {
        (element as HTMLElement).style.animationDelay = `${-(phaseOffset + index * 0.18)}s`;
      });
    }, phase);
    await page.waitForTimeout(20);
    await assertCoffeeContentGeometry(page);
  }
}

async function setCoffeeScale(page: Page, value: string): Promise<void> {
  const frame = page.locator('.overview-edit-frame[data-instance-id="fixture.coffee"]');
  await selectFrame(page, "fixture.coffee");
  await frame.getByRole("button", { name: "Настройки виджета" }).click();
  const sheet = page.getByTestId("overview-widget-appearance");
  await expect(sheet).toBeVisible();
  const range = sheet.getByLabel("Размер изображения");
  await range.fill(value);
  await sheet.getByRole("button", { name: "Закрыть" }).click();
}

async function readCoffeeTransform(page: Page) {
  return page.locator(".coffee-panel--overview").evaluate((panel) => {
    const visual = panel.querySelector<HTMLElement>(".coffee-asset__visual")!;
    const image = panel.querySelector<HTMLImageElement>(".coffee-asset__image")!;
    const asset = panel.querySelector<HTMLElement>(".coffee-asset")!;
    const imageRect = image.getBoundingClientRect();
    const transformOrigin = getComputedStyle(visual).transformOrigin;
    const [originX, originY] = transformOrigin.split(" ").map((value) => Number.parseFloat(value));
    return {
      scale: panel.getAttribute("data-image-scale"),
      x: panel.getAttribute("data-image-x"),
      y: panel.getAttribute("data-image-y"),
      image: { left: imageRect.left, top: imageRect.top, width: imageRect.width, height: imageRect.height },
      imageCenter: { x: imageRect.left + imageRect.width / 2, y: imageRect.top + imageRect.height / 2 },
      visual: {
        transform: getComputedStyle(visual).transform,
        transformOrigin,
        originX,
        originY,
        layoutWidth: visual.offsetWidth,
        layoutHeight: visual.offsetHeight
      },
      assetTransform: getComputedStyle(asset).transform
    };
  });
}

test.describe("Overview V2 Edit mode and persistence", () => {
  test.beforeEach(() => {
    test.skip(!overviewV2Enabled || !overviewEditorEnabled, "Run with V2 and the Overview editor flags enabled.");
  });

  test("communicates true, server-disabled, and unconfirmed layout writer gates", async ({ page }) => {
    for (const [mode, gate, enabled, copy] of [
      ["writer-true", "available", true, "Редактор панели готов."],
      ["writer-false", "server-disabled", false, "Запись раскладки отключена сервером или deployment gate."],
      ["metadata-missing", "metadata-unavailable", false, "Серверная доступность раскладки не подтверждена; запись отключена."]
    ] as const) {
      await page.unroute("**/api/v1/overview/layout*").catch(() => undefined);
      const state = await installLayoutGateRoute(page, mode);
      await page.goto("/overview?theme=night");
      const toolbar = page.getByTestId("overview-toolbar");
      const configure = page.getByTestId("overview-configure");
      const note = page.locator("#overview-configure-note");
      await expect(toolbar).toHaveAttribute("data-configure-gate", gate);
      await expect(configure).toHaveJSProperty("disabled", !enabled);
      await expect(note).toHaveText(copy);
      await expect(note).toBeVisible();
      await expect(configure).toHaveAttribute("aria-describedby", "overview-configure-note");
      if (!enabled) await expect(configure).toHaveCSS("cursor", "not-allowed");
      expect(state.patchCount()).toBe(0);
    }
  });

  test("keeps widget bodies inert and exposes touch-safe accessible handles", async ({ page }, testInfo) => {
    await installLayoutRoute(page);
    await openEditor(page);
    await captureArtifact(page, testInfo, "overview-edit-default.png");

    const operationalPosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/v1\/(actions|settings)\//.test(request.url())) {
        operationalPosts.push(request.url());
      }
    });

    const bodyAction = page.locator(".overview-edit-frame__body button").first();
    await expect(bodyAction).toHaveCount(1);
    const beforeUrl = page.url();
    await page.locator(".overview-edit-frame__body button").evaluateAll((elements) => {
      elements.forEach((element) => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    });
    expect(page.url()).toBe(beforeUrl);
    expect(operationalPosts).toEqual([]);

    const body = page.locator('.overview-edit-frame[data-instance-id="fixture.coffee"] .overview-edit-frame__body');
    const bodyBox = await body.boundingBox();
    expect(bodyBox).not.toBeNull();
    await page.mouse.move((bodyBox?.x ?? 0) + (bodyBox?.width ?? 0) / 2, (bodyBox?.y ?? 0) + (bodyBox?.height ?? 0) / 2);
    await page.mouse.down();
    await page.mouse.move((bodyBox?.x ?? 0) + (bodyBox?.width ?? 0) / 2 + 120, (bodyBox?.y ?? 0) + (bodyBox?.height ?? 0) / 2, { steps: 3 });
    await expect(page.locator(".overview-edit-frame--dragging")).toHaveCount(0);
    await page.mouse.up();

    const coffeeFrame = page.locator('.overview-edit-frame[data-instance-id="fixture.coffee"]');
    const planningFrame = page.locator('.overview-edit-frame[data-instance-id="fixture.planning"]');
    await selectFrame(page, "fixture.planning");
    await expect(coffeeFrame.locator(".overview-edit-frame__actions button")).toHaveCount(0);
    await expect(coffeeFrame.locator(".overview-edit-frame__resize-handle")).toHaveCount(0);
    await captureArtifact(page, testInfo, "overview-edit-unselected.png");
    await selectFrame(page, "fixture.coffee");
    await expect(coffeeFrame).toHaveAttribute("data-selected", "true");
    await expect(coffeeFrame.getByRole("button", { name: "Настройки виджета" })).toBeVisible();
    await expect(coffeeFrame.getByRole("button", { name: /Убрать/ })).toBeVisible();
    await expect(coffeeFrame.locator(".overview-edit-frame__resize-handle")).toBeVisible();
    await selectFrame(page, "fixture.planning");
    await expect(planningFrame).toHaveAttribute("data-selected", "true");
    await expect(coffeeFrame.locator(".overview-edit-frame__actions button")).toHaveCount(0);
    await expect(planningFrame.locator(".overview-edit-frame__actions button")).toHaveCount(2);
    await selectFrame(page, "fixture.coffee");
    await captureArtifact(page, testInfo, "overview-edit-selected.png");

    const undersizedHandles = await page.locator(
      ".overview-edit-frame__drag-handle, .overview-edit-frame__actions button, .overview-edit-frame__resize-handle, .overview-edit-frame__menu-toggle"
    ).evaluateAll((elements) => elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 48 && rect.height >= 48 ? [] : [{ width: rect.width, height: rect.height }];
    }));
    expect(undersizedHandles).toEqual([]);

    const dragHandle = page.locator('.overview-edit-frame[data-instance-id="fixture.coffee"] .overview-edit-frame__drag-handle');
    const handleBox = await dragHandle.boundingBox();
    expect(handleBox).not.toBeNull();
    await page.mouse.move((handleBox?.x ?? 0) + 24, (handleBox?.y ?? 0) + 24);
    await page.mouse.down();
    await page.mouse.move((handleBox?.x ?? 0) + 124, (handleBox?.y ?? 0) + 24, { steps: 5 });
    await captureArtifact(page, testInfo, "overview-edit-drag.png");
    await page.mouse.move((handleBox?.x ?? 0) - 180, (handleBox?.y ?? 0) + 24, { steps: 5 });
    await expect(page.locator(".overview-edit-frame--invalid")).toHaveCount(1);
    await expect(page.getByTestId("overview-invalid-drop-label")).toHaveText("Место занято");
    await captureArtifact(page, testInfo, "overview-edit-invalid-drop.png");
    await page.mouse.up();
    await expect(page.getByTestId("overview-invalid-drop-label")).toHaveCount(0);

    const coffeeMenu = page.locator('.overview-edit-frame[data-instance-id="fixture.coffee"] .overview-edit-frame__menu-toggle');
    await coffeeMenu.click();
    await page.getByRole("menuitem", { name: "Размер 8 × 5" }).click();
    await captureArtifact(page, testInfo, "overview-edit-resize.png");
  });

  test("keeps the canonical toolbar compact and selected chrome within widget ownership bounds", async ({ page }, testInfo) => {
    await installLayoutRoute(page);
    await openEditor(page);

    const canonicalGeometry = await page.evaluate(() => {
      const toolbar = document.querySelector("[data-testid=overview-edit-toolbar]");
      const grid = document.querySelector("[data-testid=overview-grid]");
      const coffee = document.querySelector('.overview-edit-frame[data-instance-id="fixture.coffee"]');
      const rectFor = (element: Element | null) => {
        const rect = element?.getBoundingClientRect();
        return rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null;
      };
      const buttonTops = Array.from(toolbar?.querySelectorAll("button") ?? []).map((button) => button.getBoundingClientRect().top);
      return {
        toolbar: rectFor(toolbar),
        grid: rectFor(grid),
        coffee: rectFor(coffee),
        buttonTops,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    });
    expect(canonicalGeometry.toolbar?.height ?? 999).toBeLessThanOrEqual(64);
    expect(Math.max(...canonicalGeometry.buttonTops) - Math.min(...canonicalGeometry.buttonTops)).toBeLessThanOrEqual(2);
    expect(canonicalGeometry.grid?.top ?? 999).toBeLessThanOrEqual(200);
    expect(canonicalGeometry.coffee?.top ?? 999).toBeLessThanOrEqual(300);
    expect(Math.min(canonicalGeometry.coffee?.bottom ?? 0, 720) - (canonicalGeometry.coffee?.top ?? 720)).toBeGreaterThanOrEqual(240);
    expect(canonicalGeometry.horizontalOverflow).toBe(false);

    await selectFrame(page, "fixture.coffee");
    await assertEditorChromeGeometry(page, "fixture.coffee", ["fixture.rog", "fixture.planning", "fixture.quick-actions", "fixture.health"]);
    await captureArtifact(page, testInfo, "overview-edit-selected-coffee.png");

    await selectFrame(page, "fixture.rog");
    await assertEditorChromeGeometry(page, "fixture.rog", ["fixture.coffee", "fixture.planning"]);
    await captureArtifact(page, testInfo, "overview-edit-selected-rog.png");

    await selectFrame(page, "fixture.quick-actions");
    await assertEditorChromeGeometry(page, "fixture.quick-actions", ["fixture.coffee", "fixture.health"]);
    await captureArtifact(page, testInfo, "overview-edit-selected-lower-widget.png");

    await selectFrame(page, "fixture.health");
    await assertEditorChromeGeometry(page, "fixture.health", ["fixture.coffee", "fixture.quick-actions"]);
    await captureArtifact(page, testInfo, "overview-edit-selected-health.png");
  });

  test("keeps Coffee imagery and warming activity in the asset safe zone", async ({ page }, testInfo) => {
    const routeState = await installLayoutRoute(page);
    for (const [scale, screenshot] of [
      [70, "overview-coffee-warming-scale-70.png"],
      [85, "overview-coffee-warming-scale-85.png"],
      [100, "overview-coffee-warming-scale-100.png"]
    ] as const) {
      routeState.document = makeDocument(0, (() => {
        const items = cloneItems();
        const coffee = items.find((item) => item.instanceId === "fixture.coffee");
        if (coffee) coffee.config.imageScalePct = scale;
        return items;
      })());
      await page.goto("/overview?scenario=coffee-warming&theme=night");
      await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", "warming");
      await expect(page.locator(".coffee-panel--overview")).toHaveAttribute("data-image-scale", String(scale));
      await expect(page.locator(".coffee-panel--overview")).toHaveAttribute("data-image-x", "0");
      await expect(page.locator(".coffee-panel--overview")).toHaveAttribute("data-image-y", "0");
      await assertCoffeeContentGeometry(page, `coffee-warming scale ${scale}`);
      await captureArtifact(page, testInfo, screenshot);
    }

    routeState.document = makeDocument(0, (() => {
      const items = cloneItems();
      const coffee = items.find((item) => item.instanceId === "fixture.coffee");
      if (coffee) coffee.config.showImage = false;
      return items;
    })());
    await page.goto("/overview?scenario=coffee-warming&theme=night");
    await assertCoffeeActivityHidden(page);

    routeState.document = makeDocument();
    for (const [scenario, stage] of [
      ["coffee-off", "off"],
      ["coffee-warming", "warming"],
      ["coffee-ready", "ready"],
      ["coffee-running-too-long", "running_too_long"],
      ["coffee-stale", "stale"],
      ["ha-offline-policy-available", "unavailable"]
    ] as const) {
      await page.goto(`/overview?scenario=${scenario}&theme=night`);
      await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", stage);
      await assertCoffeeContentGeometry(page, scenario);
    }

    await openEditor(page, "/overview?scenario=coffee-off&theme=night");
    await selectFrame(page, "fixture.coffee");
    await assertEditorChromeGeometry(page, "fixture.coffee", ["fixture.rog", "fixture.planning", "fixture.quick-actions", "fixture.health"]);
    await assertCoffeeContentGeometry(page, "coffee-off selected");
    await captureArtifact(page, testInfo, "overview-edit-coffee-off-selected.png");

    await page.goto("/overview?scenario=coffee-warming&theme=night");
    await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", "warming");
    await assertCoffeeContentGeometry(page, "coffee-warming");
    await assertCoffeeActivityPhases(page);
    await captureArtifact(page, testInfo, "overview-coffee-warming.png");

    await page.getByTestId("overview-configure").click();
    await expect(page.getByTestId("overview-edit-toolbar")).toBeVisible();
    await selectFrame(page, "fixture.coffee");
    await assertEditorChromeGeometry(page, "fixture.coffee", ["fixture.rog", "fixture.planning", "fixture.quick-actions", "fixture.health"]);
    await assertCoffeeActivityPhases(page);
    await captureArtifact(page, testInfo, "overview-edit-coffee-warming-selected.png");

    await setCoffeeScale(page, "70");
    await assertCoffeeContentGeometry(page, "selected coffee-warming scale 70");
    await captureArtifact(page, testInfo, "overview-edit-coffee-warming-scale-70-selected.png");
    await setCoffeeScale(page, "100");
    await assertCoffeeContentGeometry(page, "selected coffee-warming scale 100");
    await captureArtifact(page, testInfo, "overview-edit-coffee-warming-scale-100-selected.png");
  });

  test("keeps the larger Coffee composition inside compact, standard, and large variants", async ({ page }) => {
    const routeState = await installLayoutRoute(page);
    for (const variant of ["compact", "standard", "large"] as const) {
      const items = cloneItems();
      const coffee = items.find((item) => item.instanceId === "fixture.coffee");
      const planning = items.find((item) => item.instanceId === "fixture.planning");
      const quickActions = items.find((item) => item.instanceId === "fixture.quick-actions");
      const health = items.find((item) => item.instanceId === "fixture.health");
      if (coffee) {
        coffee.sizeVariant = variant;
        coffee.placement = variant === "compact"
          ? { x: 0, y: 1, w: 4, h: 3 }
          : variant === "large"
            ? { x: 0, y: 1, w: 8, h: 5 }
            : { x: 0, y: 1, w: 7, h: 4 };
      }
      if (planning) {
        planning.sizeVariant = variant === "large" ? "compact" : "standard";
        planning.placement = variant === "compact"
          ? { x: 4, y: 1, w: 8, h: 3 }
          : variant === "large"
            ? { x: 8, y: 1, w: 4, h: 3 }
            : { x: 7, y: 1, w: 5, h: 4 };
      }
      if (quickActions) quickActions.placement = variant === "large" ? { x: 0, y: 6, w: 7, h: 2 } : { x: 0, y: 5, w: 7, h: 2 };
      if (health) health.placement = variant === "large" ? { x: 7, y: 6, w: 5, h: 2 } : { x: 7, y: 5, w: 5, h: 2 };
      routeState.document = makeDocument(0, items);

      await page.goto("/overview?scenario=coffee-off&theme=night");
      const panel = page.getByTestId("widget-coffee-machine");
      await expect(panel).toHaveAttribute("data-overview-size-variant", variant);
      await expect(panel.locator(".coffee-asset__image")).toBeVisible();
      await assertCoffeeContentGeometry(page, `Coffee ${variant}`);
      const bounds = await panel.evaluate((element) => {
        const panelRect = element.getBoundingClientRect();
        const imageRect = element.querySelector(".coffee-asset__image")!.getBoundingClientRect();
        return {
          imageInsidePanel: imageRect.left >= panelRect.left && imageRect.right <= panelRect.right &&
            imageRect.top >= panelRect.top && imageRect.bottom <= panelRect.bottom,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        };
      });
      expect(bounds.imageInsidePanel, `Coffee ${variant} image clipped by its card`).toBe(true);
      expect(bounds.horizontalOverflow, `Coffee ${variant} introduced horizontal overflow`).toBe(false);
    }
  });

  test("scales the coffee image around its visual center without changing position", async ({ page }) => {
    const routeState = await installLayoutRoute(page);
    await openEditor(page, "/overview?scenario=coffee-off&theme=night");
    await selectFrame(page, "fixture.coffee");
    const frame = page.locator('.overview-edit-frame[data-instance-id="fixture.coffee"]');
    await frame.getByRole("button", { name: "Настройки виджета" }).click();
    const appearance = page.getByTestId("overview-widget-appearance");
    await appearance.getByLabel("Размер изображения").fill("70");
    await appearance.getByLabel("По горизонтали").fill("-2");
    await appearance.getByLabel("По вертикали").fill("1");
    await appearance.getByRole("button", { name: "Закрыть" }).click();

    const at70 = await readCoffeeTransform(page);
    expect(at70).toMatchObject({ scale: "70", x: "-2", y: "1" });
    expect(at70.visual.originX).toBeCloseTo(at70.visual.layoutWidth / 2, 0);
    expect(at70.visual.originY).toBeCloseTo(at70.visual.layoutHeight / 2, 0);
    expect(at70.visual.transform).toMatch(/^matrix\(0\.7, 0, 0, 0\.7, 0, 0\)$/);
    expect(at70.assetTransform).toMatch(/^matrix\(1, 0, 0, 1, /);

    await setCoffeeScale(page, "120");
    const at120 = await readCoffeeTransform(page);
    expect(at120).toMatchObject({ scale: "120", x: "-2", y: "1", assetTransform: at70.assetTransform });
    expect(at120.visual.transform).toMatch(/^matrix\(1\.2, 0, 0, 1\.2, 0, 0\)$/);
    expect(Math.abs(at120.imageCenter.x - at70.imageCenter.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(at120.imageCenter.y - at70.imageCenter.y)).toBeLessThanOrEqual(1);

    await setCoffeeScale(page, "70");
    const at70Again = await readCoffeeTransform(page);
    expect(at70Again).toMatchObject({ scale: "70", x: "-2", y: "1", assetTransform: at70.assetTransform });
    expect(Math.abs(at70Again.image.left - at70.image.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(at70Again.image.top - at70.image.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(at70Again.image.width - at70.image.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(at70Again.image.height - at70.image.height)).toBeLessThanOrEqual(1);
    expect(routeState.patchCount).toBe(0);

    await page.getByTestId("overview-save").click();
    await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "normal");
    expect(routeState.lastPatch?.find((item) => item.instanceId === "fixture.coffee")?.config).toMatchObject({
      imageScalePct: 70,
      imageXStep: -2,
      imageYStep: 1
    });
  });

  test("adds bounded widgets and sends one complete canonical save", async ({ page }, testInfo) => {
    const routeState = await installLayoutRoute(page);
    await openEditor(page);

    const coffeeFrame = page.locator('.overview-edit-frame[data-instance-id="fixture.coffee"]');
    await selectFrame(page, "fixture.coffee");
    await coffeeFrame.getByRole("button", { name: "Настройки виджета" }).click();
    const appearance = page.getByTestId("overview-widget-appearance");
    await expect(appearance).toBeVisible();
    await expect(appearance.getByRole("heading", { name: "Настройки: Кофемашина" })).toBeVisible();
    await expect(appearance).not.toContainText("standard");
    await expect(coffeeFrame.locator(".overview-edit-frame__drag-handle")).toHaveCount(0);
    await expect(coffeeFrame.locator(".overview-edit-frame__actions")).toHaveCount(0);
    await expect(coffeeFrame.locator(".overview-edit-frame__resize-handle")).toHaveCount(0);
    await expect(coffeeFrame.locator(".overview-edit-frame__size")).toHaveCount(0);
    await expect(coffeeFrame.locator(".overview-edit-frame__menu-toggle")).toHaveCount(0);
    await captureArtifact(page, testInfo, "overview-edit-sheet-preview.png");
    await captureArtifact(page, testInfo, "overview-edit-coffee-settings.png");
    await appearance.getByLabel("Размер изображения").fill("120");
    await appearance.getByLabel("По горизонтали").fill("-2");
    await appearance.getByLabel("По вертикали").fill("1");
    await expect(appearance.getByText("Немного левее")).toBeVisible();
    await expect(appearance.getByText("Немного ниже")).toBeVisible();
    await expect(coffeeFrame.locator(".coffee-panel--overview")).toHaveAttribute("data-image-x", "-2");
    await expect(coffeeFrame.locator(".coffee-panel--overview")).toHaveAttribute("data-image-y", "1");
    await expect(appearance.getByLabel("Показывать изображение")).toBeChecked();
    await expect(appearance.getByLabel("Показывать источник")).toBeChecked();
    await appearance.getByRole("button", { name: "Просторно" }).click();
    await appearance.getByLabel("Показывать источник").click();
    await expect(appearance.getByLabel("Показывать источник")).not.toBeChecked();
    const undersizedAppearanceTargets = await appearance.locator("button, input").evaluateAll((elements) => elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 48 && rect.height >= 48 ? [] : [{ tag: element.tagName, width: rect.width, height: rect.height }];
    }));
    expect(undersizedAppearanceTargets).toEqual([]);
    await appearance.getByRole("button", { name: "Закрыть" }).click();
    await expect(coffeeFrame.locator(".overview-edit-frame__drag-handle")).toBeVisible();
    await expect(coffeeFrame.locator(".overview-edit-frame__resize-handle")).toBeVisible();
    await captureArtifact(page, testInfo, "overview-edit-coffee-customized.png");
    await captureArtifact(page, testInfo, "overview-edit-dirty.png");
    await page.getByTestId("overview-add-widget").click();
    const picker = page.getByTestId("overview-widget-picker");
    await expect(picker).toBeVisible();
    await captureArtifact(page, testInfo, "overview-edit-picker.png");
    const weatherRow = picker.locator('[data-widget-type="weather.alert"]');
    await weatherRow.getByRole("button", { name: "Добавить" }).click();
    await expect(weatherRow.getByRole("button")).toHaveText("Уже добавлен");
    await picker.getByRole("button", { name: "Закрыть" }).click();

    expect(routeState.patchCount).toBe(0);
    await expect(page.getByTestId("overview-save")).toBeEnabled();
    await page.getByTestId("overview-save").click();
    await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "normal");
    expect(routeState.patchCount).toBe(1);
    expect(routeState.lastPatch?.find((item) => item.instanceId === "fixture.coffee")?.config.imageScalePct).toBe(120);
    expect(routeState.lastPatch?.find((item) => item.instanceId === "fixture.coffee")?.config.imageXStep).toBe(-2);
    expect(routeState.lastPatch?.find((item) => item.instanceId === "fixture.coffee")?.config.imageYStep).toBe(1);
    expect(routeState.lastPatch?.find((item) => item.instanceId === "fixture.coffee")?.config.showAuthority).toBe(false);
    expect(routeState.lastPatch?.some((item) => item.widgetType === "weather.alert")).toBe(true);

    await page.reload();
    await expect(page.locator('.overview-v2-grid-item[data-widget-type="weather.alert"]')).toHaveCount(1);
  });

  test("returns to usable editing after an explicit 422 without retrying", async ({ page }) => {
    const routeState = await installLayoutRoute(page, "validation-error");
    await openEditor(page);
    await setCoffeeScale(page, "115");

    await page.getByTestId("overview-save").click();
    await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "editing");
    await expect(page.getByTestId("overview-edit-toolbar").getByText("Сервер отклонил конфигурацию панели.")).toBeVisible();
    await expect(page.getByText("Сохраняем…")).toHaveCount(0);
    await expect(page.getByTestId("overview-save")).toBeEnabled();
    await expect(page.getByTestId("overview-add-widget")).toBeEnabled();
    expect(routeState.patchCount).toBe(1);
    expect(routeState.lastPatch?.find((item) => item.instanceId === "fixture.coffee")?.config.imageScalePct).toBe(115);

    await page.locator('.overview-edit-frame[data-instance-id="fixture.coffee"]').getByRole("button", { name: "Настройки виджета" }).click();
    await expect(page.getByTestId("overview-widget-appearance").getByLabel("Размер изображения")).toHaveValue("115");
    await page.getByTestId("overview-widget-appearance").getByRole("button", { name: "Закрыть" }).click();
    await expect.poll(() => routeState.patchCount).toBe(1);

    await page.getByTestId("overview-cancel").click();
    await expect(page.getByTestId("overview-edit-toolbar")).toHaveCount(0);
    expect(routeState.patchCount).toBe(1);
  });

  test("returns to usable editing after an explicit 500 without retrying", async ({ page }) => {
    const routeState = await installLayoutRoute(page, "server-error");
    await openEditor(page);
    await setCoffeeScale(page, "110");

    await page.getByTestId("overview-save").click();
    await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "editing");
    await expect(page.getByTestId("overview-edit-toolbar").getByText("Сервер отклонил конфигурацию панели.")).toBeVisible();
    await expect(page.getByText("Сохраняем…")).toHaveCount(0);
    await expect(page.getByTestId("overview-save")).toBeEnabled();
    await expect(page.getByTestId("overview-reset")).toBeEnabled();
    expect(routeState.patchCount).toBe(1);
    expect(routeState.lastPatch?.find((item) => item.instanceId === "fixture.coffee")?.config.imageScalePct).toBe(110);
    await expect.poll(() => routeState.patchCount).toBe(1);

    await page.getByTestId("overview-cancel").click();
    await expect(page.getByTestId("overview-edit-toolbar")).toHaveCount(0);
    expect(routeState.patchCount).toBe(1);
  });

  test("reset is confirmed in the draft and cancel performs no write", async ({ page }) => {
    const routeState = await installLayoutRoute(page);
    await openEditor(page);
    await setCoffeeScale(page, "105");

    await page.getByTestId("overview-reset").click();
    await expect(page.getByTestId("overview-reset-dialog")).toBeVisible();
    await page.getByTestId("overview-reset-dialog").getByRole("button", { name: "Сбросить" }).click();
    await expect(page.getByTestId("overview-save")).toBeEnabled();
    expect(routeState.patchCount).toBe(0);

    await page.getByTestId("overview-cancel").click();
    await expect(page.getByTestId("overview-edit-toolbar")).toHaveCount(0);
    expect(routeState.patchCount).toBe(0);
  });

  test("keeps a conflicting draft until the user loads the current server version", async ({ page }, testInfo) => {
    const routeState = await installLayoutRoute(page, "conflict");
    await openEditor(page);
    await setCoffeeScale(page, "105");

    await page.getByTestId("overview-save").click();
    await expect(page.getByTestId("overview-load-current")).toBeVisible();
    await expect(page.getByTestId("overview-edit-toolbar")).toContainText("Конфликт версии");
    await expect(page.getByTestId("overview-edit-toolbar")).toContainText("Загрузить актуальную");
    await expect(page.getByTestId("overview-edit-toolbar")).not.toContainText("Панель изменилась в другом окне");
    await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "editing");
    expect(routeState.patchCount).toBe(1);
    await captureArtifact(page, testInfo, "overview-edit-conflict.png");

    await page.getByTestId("overview-load-current").click();
    await expect(page.getByTestId("overview-load-current")).toHaveCount(0);
    await expect(page.getByTestId("overview-save")).toBeDisabled();
    await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "editing");
  });

  test("marks an aborted save uncertain and confirms the committed candidate by read-back", async ({ page }) => {
    const routeState = await installLayoutRoute(page, "abort");
    await openEditor(page);
    await setCoffeeScale(page, "115");

    await page.getByTestId("overview-save").click();
    await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "normal");
    expect(routeState.patchCount).toBe(1);
    expect(routeState.getCount).toBeGreaterThanOrEqual(2);
    expect(routeState.document.items.find((item) => item.instanceId === "fixture.coffee")?.config.imageScalePct).toBe(115);
  });

  test("does not claim success when read-back proves a different layout", async ({ page }) => {
    const routeState = await installLayoutRoute(page, "abort-different");
    await openEditor(page);
    await setCoffeeScale(page, "115");

    await page.getByTestId("overview-save").click();
    await expect(page.getByTestId("overview-load-current")).toBeVisible();
    await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "editing");
    expect(routeState.patchCount).toBe(1);
    expect(routeState.getCount).toBeGreaterThanOrEqual(2);
  });

  test("stays uncertain when read-back is unavailable and never retries blindly", async ({ page }) => {
    const routeState = await installLayoutRoute(page, "abort-unavailable");
    await openEditor(page);
    await setCoffeeScale(page, "115");

    await page.getByTestId("overview-save").click();
    await expect(page.getByTestId("overview-reconcile-save")).toBeVisible();
    await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "uncertain");
    expect(routeState.patchCount).toBe(1);
    expect(routeState.getCount).toBeGreaterThanOrEqual(2);
  });

  test("keeps edit controls usable at a 200 percent presentation scale", async ({ page }, testInfo) => {
    await installLayoutRoute(page);
    await openEditor(page);
    await page.evaluate(() => {
      document.body.style.zoom = "2";
    });
    await captureArtifact(page, testInfo, "overview-edit-200-percent.png");
    const toolbarButtons = page.locator("[data-testid=overview-edit-toolbar] button");
    expect(await toolbarButtons.evaluateAll((elements) => elements.every((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 48 && rect.height >= 48;
    }))).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.getByTestId("overview-add-widget")).toHaveText("Добавить");
    await expect(page.getByTestId("overview-add-widget")).toBeVisible();
    await expect(page.getByTestId("overview-reset")).toHaveText("Сбросить");
    await expect(page.getByTestId("overview-reset")).toBeVisible();
    await expect(page.getByTestId("overview-cancel")).toHaveText("Отмена");
    await expect(page.getByTestId("overview-cancel")).toBeVisible();
    await expect(page.getByTestId("overview-save")).toHaveText("Готово");
    await expect(page.getByTestId("overview-save")).toBeVisible();
  });
});
