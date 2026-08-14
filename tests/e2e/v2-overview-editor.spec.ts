import { expect, test, type Page } from "@playwright/test";
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

async function installLayoutRoute(page: Page, initialMode: PatchMode = "success") {
  const state: {
    document: LayoutDocument;
    mode: PatchMode;
    getCount: number;
    patchCount: number;
    lastPatch: LayoutItem[] | null;
  } = {
    document: makeDocument(),
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

async function openEditor(page: Page): Promise<void> {
  await page.goto("/overview?theme=night");
  await expect(page.getByTestId("route-overview-v2")).toBeVisible();
  await expect(page.getByTestId("overview-configure")).toBeEnabled();
  await page.getByTestId("overview-configure").click();
  await expect(page.getByTestId("overview-edit-toolbar")).toBeVisible();
  await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "editing");
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
    return {
      frame: rectFor(frame),
      controls,
      neighbors,
      coffeeContent: currentId === "fixture.coffee"
        ? [
            ".coffee-panel--overview .coffee-panel__heading h2",
            ".coffee-panel--overview .coffee-panel__heading .v2-status-text",
            ".coffee-panel--overview .coffee-panel__state",
            ".coffee-panel--overview .coffee-authority",
            ".coffee-panel--overview .coffee-asset",
            ".coffee-panel--overview .coffee-state-marker"
          ].map((selector) => rectFor(frame?.querySelector(selector) ?? null)).filter(Boolean)
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
        if (control.visualRect && content) expect(rectIntersects(control.visualRect, content)).toBe(false);
      }
    }
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

test.describe("Overview V2 Edit mode and persistence", () => {
  test.beforeEach(() => {
    test.skip(!overviewV2Enabled || !overviewEditorEnabled, "Run with V2 and the Overview editor flags enabled.");
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
