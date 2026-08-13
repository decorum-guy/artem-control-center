import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

test.describe.configure({ mode: "serial" });

async function expectNoDocumentOverflow(page: Page) {
  const result = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(result.documentWidth).toBeLessThanOrEqual(result.viewportWidth + 1);
}

async function readBox(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function expectStableBox(before: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>, after: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>) {
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.y).toBeCloseTo(before.y, 0);
  expect(after.width).toBeCloseTo(before.width, 0);
  expect(after.height).toBeCloseTo(before.height, 0);
}

function artifactDirectory(testInfo: { outputPath: (name: string) => string }): string {
  return process.env.V2_OVERLAY_ARTIFACT_DIR ?? testInfo.outputPath("v2-overlay-artifacts");
}

test("NoticeCenter is a fixed root overlay and does not reflow the route", async ({ page }) => {
  await page.goto("/overview?theme=night");
  const route = page.getByTestId("route-overview");
  await expect(route).toBeVisible();
  const before = await readBox(route);

  await page.goto("/overview?theme=night&b0=triple-notice");
  const stack = page.getByTestId("global-notice-stack");
  await expect(stack).toBeVisible();
  const after = await readBox(route);
  await expectStableBox(before, after);

  const stackBox = await readBox(stack);
  expect(stackBox.x + stackBox.width).toBeCloseTo(1260, 0);
  expect(stackBox.y).toBeCloseTo(76, 0);
  expect(stackBox.width).toBeCloseTo(360, 0);
  expect(await stack.evaluate((element) => ({
    parentIsBody: element.parentElement === document.body,
    position: getComputedStyle(element).position
  }))).toEqual({ parentIsBody: true, position: "fixed" });
  expect(await stack.evaluate((element) => getComputedStyle(element).backdropFilter)).toBe("none");

  const notices = stack.locator(".global-notice");
  await expect(notices).toHaveCount(3);
  const noticeBoxes = await notices.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height };
  }));
  expect(noticeBoxes.every((box) => box.height >= 80)).toBeTruthy();
  for (let index = 1; index < noticeBoxes.length; index += 1) {
    expect(noticeBoxes[index].top - noticeBoxes[index - 1].bottom).toBeCloseTo(8, 0);
  }
  const targets = await notices.locator("button").evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  expect(targets.every((target) => target.width >= 48 && target.height >= 48)).toBeTruthy();
});

test("NoticeCenter reconciles identity, expiry modes, reduced motion, and compact count", async ({ page }) => {
  await page.goto("/overview?b0=duplicate-notice");
  await expect(page.getByTestId("global-notice-stack").locator(".global-notice")).toHaveCount(1);
  await expect(page.getByText("Дубликат устранён")).toBeVisible();

  await page.goto("/overview?b0=notice-lifecycle");
  await expect(page.getByText("Операция завершена.")).toBeVisible();
  await expect(page.getByTestId("global-notice-stack").locator(".global-notice")).toHaveCount(1);
  await expect(page.locator("[data-notice-id='b0.lifecycle-progress']")).toHaveCount(0);
  await expect(page.locator("[data-notice-id='b0.lifecycle-success']")).toBeVisible();

  await page.goto("/overview?b0=triple-notice&motion=reduced");
  await expect(page.locator(".global-notice--progress .global-notice__indicator")).toHaveCSS("animation-name", "none");

  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto("/overview?b0=triple-notice");
  await expect(page.locator(".global-notice:visible")).toHaveCount(1);
  await expect(page.getByTestId("global-notice-count")).toHaveText("Ещё уведомлений: 2");
  await expectNoDocumentOverflow(page);
  const mobileStack = await readBox(page.getByTestId("global-notice-stack"));
  expect(mobileStack.x).toBeCloseTo(12, 0);
  expect(mobileStack.x + mobileStack.width).toBeCloseTo(628, 0);
  const mobileDismiss = await readBox(page.locator(".global-notice:visible .global-notice__dismiss"));
  expect(mobileDismiss.width).toBeGreaterThanOrEqual(48);
  expect(mobileDismiss.height).toBeGreaterThanOrEqual(48);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/overview?b0=notice-four");
  await expect(page.getByTestId("global-notice-stack").locator(".global-notice")).toHaveCount(3);
  await page.goto("/overview?b0=notice-action");
  const noticeButtons = page.locator(".global-notice__dismiss, .global-notice__action");
  const noticeButtonBoxes = await noticeButtons.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  expect(noticeButtonBoxes.every((box) => box.width >= 48 && box.height >= 48)).toBeTruthy();
});

test("shared Sheet keeps route geometry, focus, inert background, collision safety, and close behavior", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/tasks?b0=triple-notice");
  const opener = page.getByRole("button", { name: "Проект", exact: true });
  await expect(opener).toBeVisible();
  const route = page.getByTestId("route-tasks");
  const before = await readBox(route);
  await opener.focus();
  await opener.press("Enter");

  const sheet = page.getByTestId("planning-project-sheet");
  await expect(sheet).toBeVisible();
  const sheetBox = await readBox(sheet);
  expect(sheetBox.width).toBeCloseTo(560, 0);
  expect(sheetBox.x).toBeCloseTo(708, 0);
  expect(sheetBox.y).toBeCloseTo(28, 0);
  expect(sheetBox.x + sheetBox.width).toBeCloseTo(1268, 0);
  expect(sheetBox.y + sheetBox.height).toBeCloseTo(708, 0);
  const noticeStack = page.getByTestId("global-notice-stack");
  const noticeBox = await readBox(noticeStack);
  expect(noticeBox.x + noticeBox.width).toBeLessThanOrEqual(sheetBox.x - 8);
  await expectStableBox(before, await readBox(route));

  await expect(page.locator(".app")).toHaveAttribute("inert", "");
  expect(await page.evaluate(() => ({
    bodyOverflow: getComputedStyle(document.body).overflow,
    activeInside: Boolean(document.querySelector("[data-testid='planning-project-sheet']")?.contains(document.activeElement))
  }))).toEqual({ bodyOverflow: "hidden", activeInside: true });
  await expect(sheet.locator(".cc-overlay__header")).toHaveCSS("position", "sticky");
  await expect(sheet.locator(".cc-overlay__body")).toHaveCSS("overflow-y", "auto");

  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBeTruthy();
  }
  await page.keyboard.press("Shift+Tab");
  expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBeTruthy();

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.press("Enter");
  await expect(sheet).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(sheet).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expectNoDocumentOverflow(page);
});

test("intermediate Sheet and NoticeCenter widths stay side-by-side", async ({ page }) => {
  for (const width of [1280, 952, 900, 761]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/tasks?theme=night&b0=triple-notice");
    const opener = page.getByRole("button", { name: "Проект", exact: true });
    await opener.press("Enter");

    const sheet = page.getByTestId("planning-project-sheet");
    const notice = page.locator(".global-notice-stack .global-notice").first();
    await expect(sheet).toBeVisible();
    await expect(notice).toBeVisible();
    const sheetBox = await readBox(sheet);
    const noticeBox = await readBox(notice);
    expect(noticeBox.x).toBeGreaterThanOrEqual(0);
    expect(noticeBox.x + noticeBox.width).toBeLessThanOrEqual(sheetBox.x - 8);
    expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(width);
    expect(await notice.locator("button").evaluateAll((elements) => elements.every((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 48 && rect.height >= 48;
    }))).toBeTruthy();
    await expectNoDocumentOverflow(page);
  }
});

test("760px keeps the compact NoticeCenter projection while a Sheet is open", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 720 });
  await page.goto("/tasks?theme=night&b0=triple-notice");
  await page.getByRole("button", { name: "Проект", exact: true }).press("Enter");

  const sheet = page.getByTestId("planning-project-sheet");
  const stack = page.getByTestId("global-notice-stack");
  await expect(sheet).toBeVisible();
  await expect(stack.locator(".global-notice:visible")).toHaveCount(1);
  await expect(page.getByTestId("global-notice-count")).toHaveText("Ещё уведомлений: 2");
  const stackBox = await readBox(stack);
  const sheetBox = await readBox(sheet);
  expect(stackBox.x).toBeCloseTo(12, 0);
  expect(stackBox.x + stackBox.width).toBeCloseTo(748, 0);
  expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(760);
  await expectNoDocumentOverflow(page);
});

test("Weather management uses a non-reflow Sheet and retains existing operations", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/weather");
  const weather = page.getByTestId("route-weather");
  const trigger = page.getByRole("button", { name: "Управление" });
  const before = await readBox(weather);
  await trigger.focus();
  await trigger.press("Enter");

  const sheet = page.getByTestId("weather-management-sheet");
  await expect(sheet).toBeVisible();
  await expect(weather.locator(".weather-location-manager")).toHaveCount(0);
  await expect(sheet.locator(".weather-location-manager")).toBeVisible();
  await expectStableBox(before, await readBox(weather));
  const sheetBox = await readBox(sheet);
  expect(sheetBox.width).toBeCloseTo(560, 0);
  await sheet.getByRole("button", { name: /Сохранить/ }).first().click();
  await sheet.getByRole("button", { name: "Закрыть" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.press("Enter");
  await expect(sheet).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("compact Sheet geometry responds to the visible viewport and keeps a focused field safe", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto("/weather");
  const trigger = page.getByRole("button", { name: "Управление" });
  await trigger.focus();
  await trigger.press("Enter");
  const sheet = page.getByTestId("weather-management-sheet");
  await expect(sheet).toBeVisible();
  const sheetBox = await readBox(sheet);
  expect(sheetBox.width).toBeCloseTo(560, 0);
  expect(sheetBox.x).toBeCloseTo(68, 0);
  expect(sheetBox.y + sheetBox.height).toBeCloseTo(348, 0);
  expect(await sheet.locator(".cc-overlay__header").boundingBox()).toMatchObject({ height: 60 });
  expect(await sheet.locator(".cc-overlay__body").evaluate((element) => ({
    minHeight: getComputedStyle(element).minHeight,
    overflowY: getComputedStyle(element).overflowY
  }))).toEqual({ minHeight: "204px", overflowY: "auto" });

  const field = sheet.locator("input").first();
  await field.focus();
  await expect(field).toBeFocused();
  const safeBody = await sheet.locator(".cc-overlay__body").boundingBox();
  const fieldBox = await field.boundingBox();
  expect(safeBody).not.toBeNull();
  expect(fieldBox).not.toBeNull();
  expect(fieldBox!.y + fieldBox!.height).toBeLessThanOrEqual(safeBody!.y + safeBody!.height + 1);
  await expectNoDocumentOverflow(page);

  const artifactDir = artifactDirectory(testInfo);
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, "sheet-360.png"), animations: "disabled" });
});

test("captures the PR2 visual review pack", async ({ page }, testInfo) => {
  const artifactDir = artifactDirectory(testInfo);
  await mkdir(artifactDir, { recursive: true });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/overview?theme=night&b0=triple-notice");
  await expect(page.getByTestId("global-notice-stack")).toBeVisible();
  await page.screenshot({ path: path.join(artifactDir, "notice-matrix.png"), animations: "disabled" });

  await page.goto("/weather?theme=night");
  const trigger = page.getByRole("button", { name: "Управление" });
  await trigger.press("Enter");
  await expect(page.getByTestId("weather-management-sheet")).toBeVisible();
  await page.screenshot({ path: path.join(artifactDir, "weather-management.png"), animations: "disabled" });

  await page.setViewportSize({ width: 900, height: 720 });
  await page.goto("/tasks?theme=night&b0=triple-notice");
  await page.getByRole("button", { name: "Проект", exact: true }).press("Enter");
  await expect(page.getByTestId("planning-project-sheet")).toBeVisible();
  await page.screenshot({ path: path.join(artifactDir, "overlay-intermediate.png"), animations: "disabled" });
});
