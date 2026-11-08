import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
// Contract fixtures intentionally independent of renderer imports (browser-only assets).
const overviewWidgetRegistry = [
  { widgetType: "home.coffee-machine", defaultSizeVariant: "standard", sizes: { compact: { w: 4, h: 3 }, standard: { w: 7, h: 4 }, large: { w: 8, h: 5 } } },
  { widgetType: "home.kettle", defaultSizeVariant: "standard", sizes: { compact: { w: 4, h: 4 }, standard: { w: 5, h: 4 }, large: { w: 7, h: 5 }, detail: { w: 7, h: 3 } } },
  { widgetType: "home.light-strip", defaultSizeVariant: "standard", sizes: { compact: { w: 4, h: 4 }, standard: { w: 5, h: 4 }, large: { w: 8, h: 6 } } },
  { widgetType: "home.climate", defaultSizeVariant: "standard", sizes: { compact: { w: 4, h: 5 }, standard: { w: 7, h: 3 }, large: { w: 8, h: 5 } } },
  { widgetType: "home.station-mini-2", defaultSizeVariant: "standard", sizes: { compact: { w: 4, h: 4 }, standard: { w: 5, h: 4 }, large: { w: 7, h: 5 } } },
  { widgetType: "system.rog-g703-operational", defaultSizeVariant: "standard", sizes: { compact: { w: 6, h: 1 }, standard: { w: 12, h: 1 }, detail: { w: 6, h: 2 } } },
  { widgetType: "planning.summary", defaultSizeVariant: "standard", sizes: { compact: { w: 4, h: 3 }, standard: { w: 5, h: 4 }, large: { w: 7, h: 5 } } },
  { widgetType: "system.health-summary", defaultSizeVariant: "compact", sizes: { compact: { w: 5, h: 2 }, large: { w: 7, h: 3 } } },
  { widgetType: "weather.alert", defaultSizeVariant: "standard", sizes: { compact: { w: 4, h: 1 }, standard: { w: 6, h: 2 } } },
  { widgetType: "planning.calendar-agenda", defaultSizeVariant: "standard", sizes: { compact: { w: 4, h: 3 }, standard: { w: 6, h: 4 }, large: { w: 8, h: 5 } } },
  { widgetType: "planning.task-list", defaultSizeVariant: "standard", sizes: { compact: { w: 4, h: 3 }, standard: { w: 6, h: 4 }, large: { w: 8, h: 5 } } },
];
import { unlockTouchLockIfNeeded } from "./touch-lock-test-helpers";

const enabled = process.env.VITE_V2_VISUAL_SHELL === "true" && process.env.VITE_OVERVIEW_V2_ENABLED === "true";
test.skip(!enabled, "Portrait browser profile requires the V2 shell and Overview");
const routes = ["overview", "home", "weather", "services", "calendar", "tasks", "reminders", "coffee-diary", "backups", "system", "settings", "apps"];
const sizes = [{ width: 720, height: 1280 }, { width: 768, height: 1366 }, { width: 1080, height: 1920 }, { width: 540, height: 960 }, { width: 1280, height: 720 }];
async function access(page: Page) {
  const ids = ["overview.layout.edit", "todoist.tasks.write", "planning.calendar.create", "planning.calendar.edit", "planning.calendar.delete"];
  await page.route("**/api/v1/access", (route) => route.fulfill({ json: { schemaVersion: 1, revision: 1, baseProfile: "standard", effectiveProfile: "standard", temporaryFull: false, temporaryFullExpiresAt: null, pinConfigured: true, lockoutUntil: null, confirmationPolicy: { actionConfirmationRequired: true, mode: "profile_default" }, capabilities: Object.fromEntries(ids.map((capability) => [capability, { capability, allowed: true, minimumProfile: "standard", effectiveProfile: "standard", availability: "allowed" }])) } }));
}
async function open(page: Page, route: string) {
  await page.goto(`/${route}${route.includes("?") ? "&" : "?"}theme=night`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await unlockTouchLockIfNeeded(page);
}
async function boundedControls(page: Page, selector = "main button, main input:not([type=hidden]), main select, main textarea") {
  const issues = await page.locator(selector).evaluateAll((nodes) => nodes.flatMap((element) => {
    const r = element.getBoundingClientRect(); const style = getComputedStyle(element);
    if (!r.width || !r.height || style.visibility === "hidden") return [];
    return r.left < -1 || r.right > innerWidth + 1 || r.width < 47.5 || r.height < 47.5 ? [{ text: element.getAttribute("aria-label") ?? element.textContent?.slice(0, 45), class: element.className, x: r.x, right: r.right, w: r.width, h: r.height }] : [];
  }));
  expect(issues).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
for (const viewport of sizes) test(`all routes and navigation at CSS ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize(viewport);
  const portrait = viewport.height >= viewport.width;
  await access(page);
  const directory = `artifacts/issue-322/after/${viewport.width}x${viewport.height}`;
  await mkdir(directory, { recursive: true });
  for (const route of routes) {
    await test.step(route, async () => {
      await open(page, route);
      await expect(page.getByTestId("v2-shell")).toHaveAttribute("data-viewport-layout", portrait ? "portrait" : "landscape");
      await expect(page.getByTestId("product-header")).toBeInViewport();
      const floatingNavigation = page.getByTestId("portrait-floating-navigation-toggle");
      if (portrait) {
        await expect(floatingNavigation).toBeVisible();
        await expect(floatingNavigation).toHaveAccessibleName("Открыть разделы");
        expect(await floatingNavigation.evaluate((element) => element.innerText.trim())).toBe("");
        await expect(floatingNavigation.locator("svg path")).toHaveCount(1);
        const geometry = await floatingNavigation.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, rightGap: innerWidth - rect.right, bottomGap: innerHeight - rect.bottom };
        });
        expect(geometry.width).toBe(56);
        expect(geometry.height).toBe(56);
        expect(geometry.rightGap).toBeGreaterThanOrEqual(15);
        expect(geometry.rightGap).toBeLessThanOrEqual(17);
        expect(geometry.bottomGap).toBeGreaterThanOrEqual(15);
        expect(geometry.bottomGap).toBeLessThanOrEqual(17);
        if (route === "overview" && viewport.width === 720 && viewport.height === 1280) {
          await page.screenshot({ path: "artifacts/issue-322/after/720x1280/overview-floating-navigation.png", animations: "disabled" });
        }
        if (route === "overview" && viewport.width === 768 && viewport.height === 1366) {
          await page.screenshot({ path: "artifacts/issue-322/after/768x1366/overview-floating-navigation.png", animations: "disabled" });
        }
      } else {
        await expect(floatingNavigation).toBeHidden();
      }
      await boundedControls(page);
      await page.screenshot({ path: `${directory}/${route}.png`, animations: "disabled" });
    });
  }
  const floatingNavigation = page.getByTestId("portrait-floating-navigation-toggle");
  if (portrait) {
    await page.getByRole("button", { name: "Разделы", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Разделы" });
    await expect(dialog).toBeVisible();
    await expect(page.locator(".cc-overlay-backdrop")).toHaveCount(1);
    await expect(page.locator(".portrait-navigation-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(floatingNavigation).toHaveAttribute("aria-expanded", "true");
    await expect(dialog.locator("a")).toHaveCount(routes.length);
    await boundedControls(page, '[role=dialog] a, [role=dialog] button');
    const menuGeometry = await Promise.all([
      floatingNavigation.evaluate((element) => Number(getComputedStyle(element).zIndex)),
      page.locator(".cc-overlay-backdrop").evaluate((element) => Number(getComputedStyle(element).zIndex))
    ]);
    expect(menuGeometry[0]).toBeLessThan(menuGeometry[1]);
    await dialog.locator('a[href="/backups"]').click();
    await expect(page).toHaveURL(/\/backups/);
    await floatingNavigation.click();
    await expect(page.getByRole("dialog", { name: "Разделы" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(floatingNavigation).toBeFocused();
    await page.getByRole("button", { name: "Разделы", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Разделы", exact: true })).toBeFocused();
    await floatingNavigation.click();
    await page.locator(".cc-overlay-backdrop--sheet").click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole("dialog", { name: "Разделы" })).toHaveCount(0);
    await expect(floatingNavigation).toBeFocused();
    await page.getByRole("button", { name: "Разделы", exact: true }).click();
    await dialog.locator('a[href="/settings"]').click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByRole("dialog", { name: "Разделы" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Разделы", exact: true })).toBeFocused();

  }
  await testInfo.attach("viewport", { body: JSON.stringify(viewport), contentType: "application/json" });
});

test("floating navigation stays fixed while Settings scrolls and clears the final action", async ({ page }) => {
  await page.setViewportSize(sizes[0]);
  await access(page);
  await open(page, "settings");
  const floatingNavigation = page.getByTestId("portrait-floating-navigation-toggle");
  const routeContent = page.locator(".v2-route-content");
  const buttonBeforeScroll = await floatingNavigation.boundingBox();
  await routeContent.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => routeContent.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => {
    const buttonAfterScroll = await floatingNavigation.boundingBox();
    return buttonAfterScroll?.x === buttonBeforeScroll?.x && buttonAfterScroll?.y === buttonBeforeScroll?.y;
  }).toBe(true);

  const lastAction = page.getByTestId("route-settings").locator("button").last();
  await lastAction.scrollIntoViewIfNeeded();
  await expect(lastAction).toBeInViewport();
  const controlsOverlap = await Promise.all([lastAction.boundingBox(), floatingNavigation.boundingBox()])
    .then(([lastRect, menuRect]) => Boolean(lastRect && menuRect
      && lastRect.x < menuRect.x + menuRect.width
      && lastRect.x + lastRect.width > menuRect.x
      && lastRect.y < menuRect.y + menuRect.height
      && lastRect.y + lastRect.height > menuRect.y));
  expect(controlsOverlap).toBe(false);

  await floatingNavigation.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Разделы" })).toBeVisible();
  await page.setViewportSize(sizes[4]);
  await expect(page.getByRole("dialog", { name: "Разделы" })).toHaveCount(0);
  await expect(page.locator('.v2-navigation-rail [aria-current="page"]')).toBeFocused();
  await expect(page).toHaveURL(/\/settings/);
});

test("floating navigation follows rotation without reloading or leaving the current route", async ({ page }) => {
  await page.setViewportSize(sizes[0]);
  await access(page);
  await open(page, "settings");
  const floatingNavigation = page.getByTestId("portrait-floating-navigation-toggle");
  await expect(floatingNavigation).toBeVisible();
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const routeUrl = new URL(page.url());

  await page.setViewportSize(sizes[4]);
  await expect(floatingNavigation).toBeHidden();
  await expect(page.getByTestId("route-settings")).toBeVisible();
  await expect(page).toHaveURL(routeUrl.toString());

  await page.setViewportSize(sizes[1]);
  await expect(floatingNavigation).toBeVisible();
  await expect(page.getByTestId("route-settings")).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  await expect(page).toHaveURL(routeUrl.toString());
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).resolves.toBe(true);
});

async function layoutFixture(page: Page, variant?: string) {
  let y = 0;
  const items = overviewWidgetRegistry.map((definition) => {
    const sizeVariant = variant && definition.sizes[variant as keyof typeof definition.sizes] ? variant : definition.defaultSizeVariant;
    const size = definition.sizes[sizeVariant as keyof typeof definition.sizes]!;
    const item = { instanceId: definition.widgetType, widgetType: definition.widgetType, sizeVariant, visibility: "visible", placement: { x: 0, y, ...size }, config: {} };
    y += size.h; return item;
  });
  const base = { schemaVersion: "overview.layout.v2", profileId: "samsung-control", presetId: "overview.default", presetVersion: 6, revision: 0, viewportClass: "landscape-12", updatedAt: "2026-11-06T10:00:00Z", items, warnings: [], unplaced: [], writesEnabled: true };
  const state = { landscape: structuredClone(base), portrait: structuredClone(base), patches: [] as string[], hold: false, release: () => {} };
  await access(page);
  await page.route(/\/api\/v1\/overview\/layout(?:\/portrait)?$/, async (route) => {
    const portrait = new URL(route.request().url()).pathname.endsWith("/portrait");
    const key = portrait ? "portrait" : "landscape";
    if (route.request().method() === "PATCH") {
      state.patches.push(key);
      if (state.hold) await new Promise<void>((resolve) => { state.release = resolve; });
      state[key] = { ...state[key], items: route.request().postDataJSON().items, revision: state[key].revision + 1 };
    }
    await route.fulfill({ headers: { etag: `"${state[key].revision}"` }, json: portrait ? { schemaVersion: "overview.portrait.v1", profile: "portrait", layout: state[key] } : state[key] });
  });
  return state;
}
for (const variant of ["compact", "standard", "large", "detail"]) test(`all widgets retain meaningful ${variant} variants in portrait`, async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 1280 });
  await layoutFixture(page, variant);
  await open(page, "overview");
  await expect(page.getByTestId("overview-grid-item")).toHaveCount(overviewWidgetRegistry.length);
  await expect(page.locator('[data-grid-state="fallback"]')).toHaveCount(0);
  await boundedControls(page);
  for (const widget of await page.getByTestId("overview-grid-item").all()) {
    await widget.scrollIntoViewIfNeeded();
    // Interactive content may scroll vertically with the route, but must fit its card.
    const clipped = await widget.locator("button, select").evaluateAll((nodes) => nodes.filter((node) => { const r = node.getBoundingClientRect(); const card = node.closest('[data-testid="overview-grid-item"]')!.getBoundingClientRect(); return r.width > 0 && (r.bottom > card.bottom + 1 || r.top < card.top - 1); }).map((node) => node.getAttribute("aria-label") ?? node.textContent));
    expect(clipped).toEqual([]);
    if (variant === "standard") {
      await mkdir("artifacts/issue-322/widgets", { recursive: true });
      await widget.screenshot({ path: `artifacts/issue-322/widgets/${await widget.getAttribute("data-widget-type")}.png`, animations: "disabled" });
    }
  }
});

test("portrait editor pointer, resize menu, picker, appearance, persisted profile and rotation isolation", async ({ page }) => {
  const state = await layoutFixture(page);
  const landscape = JSON.stringify(state.landscape);
  await page.setViewportSize({ width: 720, height: 1280 });
  await open(page, "overview?overviewEdit=1");
  await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "editing");
  const coffee = page.getByTestId("overview-edit-frame").filter({ has: page.getByRole("button", { name: "Переместить Кофемашина", exact: true }) });
  const handle = coffee.getByRole("button", { name: "Переместить Кофемашина", exact: true });
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  const orderBefore = await page.getByTestId("overview-edit-frame").evaluateAll((frames) => frames.map((frame) => frame.getAttribute("data-instance-id")));
  // Chromium delivers pointercancel during touch scrolling/rotation: never commit it.
  await page.mouse.move(box.x + 24, box.y + 24); await page.mouse.down();
  await page.mouse.move(box.x + 24, box.y + 110, { steps: 3 });
  await handle.dispatchEvent("pointercancel", { pointerId: 1 }); await page.mouse.up();
  expect(await page.getByTestId("overview-edit-frame").evaluateAll((frames) => frames.map((frame) => frame.getAttribute("data-instance-id")))).toEqual(orderBefore);
  await page.mouse.move(box.x + 24, box.y + 24); await page.mouse.down(); await page.mouse.move(box.x + 24, box.y + 110, { steps: 6 }); await page.mouse.up();
  await expect(coffee).toHaveAttribute("data-selected", "true");
  await boundedControls(page);
  await coffee.getByRole("button", { name: "Изменить размер Кофемашина", exact: true }).click();
  await coffee.getByRole("menuitem", { name: "Размер 4 × 3" }).click();
  await page.screenshot({ path: "artifacts/issue-322/editor.png", animations: "disabled" });
  await coffee.getByRole("button", { name: "Настройки виджета", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await boundedControls(page, '[role=dialog] button, [role=dialog] select, [role=dialog] input');
  const floatingNavigation = page.getByTestId("portrait-floating-navigation-toggle");
  const modalHitTest = await floatingNavigation.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { hitIsFloatingButton: hit === element, floatingZ: Number(getComputedStyle(element).zIndex), overlayZ: Number(getComputedStyle(document.querySelector(".cc-overlay-backdrop")!).zIndex) };
  });
  expect(modalHitTest.floatingZ).toBeLessThan(modalHitTest.overlayZ);
  expect(modalHitTest.hitIsFloatingButton).toBe(false);
  await page.screenshot({ path: "artifacts/issue-322/appearance.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await page.getByTestId("overview-add-widget").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-layout-profile", "portrait");
  await expect(page.getByTestId("overview-save")).toBeEnabled();
  state.hold = true;
  await page.getByTestId("overview-save").click();
  await expect.poll(() => state.patches.length).toBe(1);
  for (const viewport of [sizes[0], sizes[4], sizes[0]]) { await page.setViewportSize(viewport); await expect(page.getByTestId("overview-save")).toBeDisabled(); }
  state.release();
  await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-editor-mode", "normal");
  expect(state.patches).toEqual(["portrait"]);
  expect(JSON.stringify(state.landscape)).toBe(landscape);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-widget-type="home.coffee-machine"][data-testid="overview-grid-item"]')).toHaveAttribute("data-size-variant", "compact");
  await page.setViewportSize(sizes[4]);
  await expect(page.getByTestId("route-overview-v2")).toHaveAttribute("data-layout-profile", "landscape");
  await expect(page.locator('[data-widget-type="home.coffee-machine"][data-testid="overview-grid-item"]')).toHaveAttribute("data-size-variant", "standard");
  expect(state.patches).toEqual(["portrait"]);
});

test("task draft/focus survives rotation and keyboard viewport; pending command stays single", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-06T10:00:00Z"));
  await access(page);
  let posts = 0; let release = () => {};
  const tasks = [{ id: "6Task", project_id: "6Project", content: "Купить кофе", description: "Зёрна", priority: 4, due: null }];
  await page.route("**/api/v1/todoist/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") { posts++; await new Promise<void>((resolve) => { release = resolve; }); return route.fulfill({ json: { provider: "todoist", accepted: true } }); }
    if (path.endsWith("/status")) return route.fulfill({ json: { provider: "todoist", enabled: true, configured: true, activeSource: "todoist", writesEnabled: true } });
    return route.fulfill({ json: { provider: "todoist", activeSource: "todoist", generatedAt: "2026-11-06T10:00:00Z", lastSyncedAt: "2026-11-06T10:00:00Z", results: path.endsWith("/projects") ? [{ id: "6Project", name: "Личное" }] : tasks, nextCursor: null } });
  });
  await page.setViewportSize(sizes[4]);
  await open(page, "tasks");
  await page.getByRole("button", { name: "Новая задача" }).click();
  const title = page.getByLabel("Название", { exact: true });
  await title.fill("Несохранённая задача");
  for (const viewport of [sizes[0], sizes[4], sizes[0]]) { await page.setViewportSize(viewport); await expect(title).toBeFocused(); await expect(title).toHaveValue("Несохранённая задача"); await expect(page).toHaveURL(/\/tasks/); }
  expect(posts).toBe(0);
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, { height: { configurable: true, value: 550 }, offsetTop: { configurable: true, value: 0 } });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect.poll(() => page.getByTestId("portrait-floating-navigation-toggle").evaluate((element) => {
    const viewportBottom = window.visualViewport!.offsetTop + window.visualViewport!.height;
    return element.getBoundingClientRect().bottom <= viewportBottom + 1;
  })).toBe(true);
  await boundedControls(page, '[role=dialog] button, [role=dialog] input, [role=dialog] select, [role=dialog] textarea');
  await expect.poll(async () => (await page.getByRole("dialog").boundingBox())!.y + (await page.getByRole("dialog").boundingBox())!.height).toBeLessThanOrEqual(550);
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await page.setViewportSize(sizes[4]);
  await expect(page.getByRole("button", { name: "Отправляем…", exact: true })).toBeDisabled();
  await page.setViewportSize(sizes[0]);
  expect(posts).toBe(1); release();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Calendar selected day, editor and date/time controls remain usable on rotation", async ({ page }) => {
  test.skip(process.env.VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED !== "true", "Calendar writer browser profile required");
  await access(page);
  const now = new Date().toISOString(); let posts = 0;
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch(); const snapshot = await response.json();
    snapshot.planning.calendarMutationsEnabled = true;
    await route.fulfill({ response, json: snapshot });
  });
  await page.route(/\/api\/v1\/planning\/events(?:\?.*)?$/, (route) => {
    if (route.request().method() !== "GET") { posts++; return route.fulfill({ status: 503, json: { detail: "planning_unavailable" } }); }
    return route.fulfill({ json: { schemaVersion: "planning.panel.v1", kind: "list", domain: "calendar_event", generatedAt: now, sourceStatus: "current", lastSyncedAt: now, staleAfter: new Date(Date.now() + 300_000).toISOString(), items: [], limit: 100, offset: 0, count: 0, hasMore: false } });
  });
  await page.setViewportSize(sizes[0]);
  await open(page, "calendar");
  const day = page.getByTestId("planning-calendar-month-cell").filter({ hasText: /^15$/ });
  await day.click();
  await page.getByRole("button", { name: "Создать событие", exact: true }).click();
  const sheet = page.getByTestId("planning-calendar-mutation");
  const title = sheet.getByTestId("calendar-editor-title");
  await title.fill("Черновик встречи");
  await page.setViewportSize(sizes[4]); await expect(title).toBeFocused();
  await page.setViewportSize(sizes[0]); await expect(title).toHaveValue("Черновик встречи");
  await boundedControls(page, '[role=dialog] button, [role=dialog] input, [role=dialog] select, [role=dialog] textarea');
  await sheet.getByLabel("Дата начала", { exact: true }).fill("2026-11-15");
  await sheet.getByRole("button", { name: "Дата начала: следующий день", exact: true }).click();
  await expect(sheet.getByLabel("Дата начала", { exact: true })).toHaveValue("2026-11-16");
  await sheet.getByRole("button", { name: /^Начало / }).click();
  await boundedControls(page, '[role=dialog] button');
  await sheet.getByRole("switch", { name: "Весь день" }).click();
  await sheet.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await expect(sheet).toBeVisible();
  await expect(title).toHaveValue("Черновик встречи");
  expect(posts).toBe(1);
});
