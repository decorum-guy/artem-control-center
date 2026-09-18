import { expect, test } from "@playwright/test";

test("Jarvis is global, bounded, private, and can navigate without leaving its overlay", async ({ page }) => {
  await page.goto("/overview");
  const routeBefore = await page.getByTestId("route-overview").boundingBox();
  await expect(page.getByTestId("jarvis-launcher")).toBeVisible();
  await page.getByTestId("jarvis-launcher").click();
  await expect(page.getByTestId("jarvis-panel")).toBeVisible();
  await page.getByLabel("Сообщение Jarvis").fill("Открой настройки");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(page.getByTestId("route-settings")).toBeVisible();
  await expect(page.getByTestId("jarvis-panel")).toBeVisible();
  await expect(page.getByTestId("jarvis-messages")).toContainText("Открываю раздел.");
  const routeAfter = await page.getByTestId("route-settings").boundingBox();
  expect(routeBefore?.width).toBe(routeAfter?.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBeTruthy();
  expect(await page.evaluate(() => Object.keys(localStorage).some((key) => key.toLowerCase().includes("jarvis")))).toBeFalsy();
});

test("Jarvis renders server text as text and has touch-sized controls", async ({ page }) => {
  await page.route("**/api/v1/jarvis/turn", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      schemaVersion: "jarvis.turn.v1", status: "ready", intentId: "general.question",
      responseText: "<img src=x onerror=window.__jarvisXss=true>", navigation: null
    }) });
  });
  await page.goto("/home");
  await page.getByTestId("jarvis-launcher").click();
  await page.getByLabel("Сообщение Jarvis").fill("тест");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(page.getByTestId("jarvis-messages")).toContainText("<img src=x onerror=window.__jarvisXss=true>");
  expect(await page.evaluate(() => (window as Window & { __jarvisXss?: boolean }).__jarvisXss === true)).toBeFalsy();
  const violations = await page.locator(".jarvis-launcher, .jarvis-panel button, .jarvis-panel input").evaluateAll((elements) => elements.flatMap((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width >= 48 && rect.height >= 48 ? [] : [{ width: rect.width, height: rect.height }];
  }));
  expect(violations).toEqual([]);
});

test("a newer ephemeral voice update auto-opens Jarvis without a second overlay", async ({ page }) => {
  await page.route("**/api/v1/jarvis/voice/state", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      schemaVersion: "jarvis.voice.v1", enabled: true, configured: true, health: "healthy",
      state: "listening", sequence: 1, recognizedText: null, responseText: null,
      safeErrorCode: null, wakeLatencyMs: 10, sttLatencyMs: null
    }) });
  });
  await page.goto("/overview");
  await expect(page.getByTestId("jarvis-panel")).toBeVisible();
  await expect(page.getByTestId("jarvis-state")).toHaveText("Слушаю");
  await expect(page.locator("[data-testid=jarvis-panel]")).toHaveCount(1);
});

test("a critical confirmation stays above the Jarvis layer", async ({ page }) => {
  await page.goto("/overview?scenario=coffee-off");
  await page.getByTestId("jarvis-launcher").click();
  await page.locator("[data-coffee-action='off-primary']").click();
  const confirmation = page.getByTestId("action-confirmation");
  await expect(confirmation).toBeVisible();
  const layers = await page.evaluate(() => ({
    jarvis: Number(getComputedStyle(document.querySelector(".jarvis-root")!).zIndex),
    confirmation: Number(getComputedStyle(document.querySelector(".action-confirmation-backdrop")!).zIndex)
  }));
  expect(layers.confirmation).toBeGreaterThan(layers.jarvis);
});
