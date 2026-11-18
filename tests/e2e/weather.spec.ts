import { expect, test } from "@playwright/test";

test.use({ hasTouch: true });

test("weather page supports touch-first forecast and location preview", async ({ page }) => {
  await page.goto("/weather?scenario=ha-healthy");

  await expect(page.getByTestId("route-weather")).toBeVisible();
  const hero = page.getByTestId("weather-hero");
  await expect(hero).toContainText("Москва");
  await expect(hero).toContainText("22°");
  await expect(hero).toContainText("Преимущественно ясно");
  await expect(page.getByRole("heading", { name: "Почасовой прогноз" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "7 дней" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Солнце" })).toBeVisible();

  await page.getByRole("button", { name: "+ Место" }).tap();
  const search = page.getByTestId("weather-location-search");
  await search.getByRole("searchbox", { name: "Поиск места" }).fill("Роттердам");
  await search.getByRole("button", { name: "Найти" }).tap();
  await search.getByRole("button", { name: /Роттердам/ }).tap();

  await expect(page.getByText("Это предпросмотр")).toBeVisible();
  await expect(hero).toContainText("Роттердам");
  await page.getByRole("button", { name: "Сохранить место" }).tap();

  await expect(page.getByRole("tab", { name: /Роттердам/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Это предпросмотр")).toHaveCount(0);

  await page.getByRole("button", { name: "Управление" }).tap();
  await expect(page.getByRole("heading", { name: "Мои места" })).toBeVisible();
  await expect(page.getByText("Хранятся только локально")).toBeVisible();
});

test("header weather summary opens the dedicated weather route", async ({ page }) => {
  await page.goto("/overview?scenario=ha-healthy");
  const summary = page.getByRole("button", { name: "Открыть погоду" });
  await expect(summary).toContainText("Москва");
  await summary.tap();
  await expect(page).toHaveURL(/\/weather/);
  await expect(page.getByTestId("route-weather")).toBeVisible();
});

test("the header dates a stale forecast before opening Weather", async ({ page }) => {
  await page.route(/\/api\/v1\/weather\?locationId=/, async (route) => {
    const response = await route.fetch();
    const forecast = await response.json();
    await route.fulfill({ response, json: { ...forecast, stale: true, sourceMode: "stale", observedAt: "2026-10-29T16:45:15Z" } });
  });
  await page.goto("/overview?scenario=ha-healthy");
  const summary = page.getByRole("button", { name: "Открыть погоду" });
  await expect(summary).toContainText("Устарел");
  await expect(summary).toContainText(/29.+19:45/);
});
