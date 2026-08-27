import { expect, test, type Page } from "@playwright/test";

const v2Enabled = process.env.VITE_V2_VISUAL_SHELL === "true";

type CopyState = Record<string, any>;

async function mockInterfaceCopy(page: Page, scenario: "defaults-only" | "custom-navigation" | "removed-subtitle" = "defaults-only") {
  const seed = await page.request.get(`/api/v1/settings/interface-copy?fixtureScenario=${scenario}`);
  expect(seed.ok()).toBeTruthy();
  const state = await seed.json() as CopyState;
  state.writesEnabled = true;
  state.available = true;
  state.warnings = [];

  await page.route("**/api/v1/settings/interface-copy", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) });
      return;
    }
    if (route.request().method() === "PATCH") {
      const payload = route.request().postDataJSON() as { expectedRevision: number; field?: string; value?: string | null; resetAll?: boolean };
      if (payload.expectedRevision !== state.revision) {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "revision_conflict" }) });
        return;
      }
      if (payload.resetAll) {
        state.overrides = {
          navigation: {}, navigationGroup: {},
          page: { overview: {}, weather: {}, home: {}, services: {}, calendar: {}, tasks: {}, reminders: {}, backups: {}, apps: {}, system: {}, settings: {} }
        };
        state.effective = structuredClone(state.defaults);
      } else if (payload.field) {
        const parts = payload.field.split(".");
        const scope = parts[0] === "navigationGroup" ? "navigationGroup" : parts[0] === "navigation" ? "navigation" : "page";
        const pageName = scope === "page" ? parts[1] : null;
        const key = scope === "navigationGroup" ? parts[1] : scope === "navigation" ? parts[1] : parts[2];
        const target = scope === "navigationGroup"
          ? state.overrides.navigationGroup
          : scope === "navigation"
            ? state.overrides.navigation
            : state.overrides.page[pageName];
        const effectiveTarget = scope === "navigationGroup"
          ? state.effective.navigationGroup
          : scope === "navigation"
            ? state.effective.navigation
            : state.effective.page[pageName];
        if (payload.value === null) delete target[key];
        else target[key] = payload.value;
        effectiveTarget[key] = payload.value === null
          ? scope === "navigationGroup"
            ? state.defaults.navigationGroup[key]
            : scope === "navigation"
              ? state.defaults.navigation[key]
              : state.defaults.page[pageName][key]
          : payload.value;
      }
      state.revision += 1;
      state.updatedAt = "2026-08-27T00:00:00Z";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) });
      return;
    }
    await route.continue();
  });

  return state;
}

test.describe("Issue #102 owner-configurable interface copy", () => {
  test.skip(!v2Enabled, "Run with VITE_V2_VISUAL_SHELL=true for the V2 browser gate.");

  test("custom labels remain presentation-only and survive a fixture reload", async ({ page }) => {
    const state = await mockInterfaceCopy(page, "custom-navigation");
    await page.goto("/overview");
    await expect(page.getByTestId("v2-shell")).toBeVisible();
    await expect(page.locator(".v2-nav-link[data-nav-route='/overview']")).toHaveText("Главная");
    await expect(page.locator(".v2-nav-link[data-nav-route='/calendar']")).toHaveText("Расписание");
    await expect(page.locator(".v2-nav-link[data-nav-route='/overview']")).toHaveAttribute("href", "/overview");
    await expect(page.locator(".v2-nav-link[data-nav-route='/calendar']")).toHaveAttribute("href", "/calendar");
    await page.locator(".v2-nav-link[data-nav-route='/calendar']").click();
    await expect(page.getByTestId("route-calendar")).toBeVisible();
    await expect(page).toHaveURL(/\/calendar$/);
    await page.reload();
    await expect(page.locator(".v2-nav-link[data-nav-route='/calendar']")).toHaveText("Расписание");
    expect(state.effective.navigation.calendar).toBe("Расписание");
  });

  test("page copy can be edited and an optional subtitle can be removed", async ({ page }) => {
    await mockInterfaceCopy(page, "defaults-only");
    await page.goto("/settings");
    await expect(page.getByTestId("route-settings")).toBeVisible();
    await page.getByTestId("settings-summary-interface-copy").click();
    await expect(page.getByTestId("settings-interface-copy-sheet")).toBeVisible();
    const title = page.getByTestId("interface-copy-input-page-overview-title");
    await title.fill("Мой день");
    await page.getByTestId("interface-copy-field-page-overview-title").getByRole("button", { name: "Сохранить" }).click();
    await expect(page.getByText("Название сохранено.")).toBeVisible();
    const subtitle = page.getByTestId("interface-copy-input-page-overview-subtitle");
    await subtitle.fill("");
    await page.getByTestId("interface-copy-field-page-overview-subtitle").getByRole("button", { name: "Сохранить" }).click();
    await expect(page.getByText("Название сохранено.")).toBeVisible();
    await page.getByTestId("settings-interface-copy-sheet").getByRole("button", { name: "Закрыть" }).click();
    await expect(page.getByTestId("route-settings")).toBeVisible();
    await page.locator(".v2-nav-link[data-nav-route='/overview']").click();
    await expect(page.locator(".overview-v2-toolbar h1")).toHaveText("Мой день");
    await expect(page.locator(".overview-v2-toolbar p")).toHaveCount(0);

    await page.goto("/settings");
    await page.getByTestId("settings-summary-interface-copy").click();
    await page.getByRole("button", { name: "Вернуть стандартные названия" }).click();
    await expect(page.getByTestId("action-confirmation")).toBeVisible();
    await page.getByTestId("action-confirmation").getByRole("button", { name: "Вернуть стандартные названия" }).click();
    await expect(page.getByTestId("interface-copy-input-page-overview-title")).toHaveValue("Обзор");
  });

  test("valid long labels do not create horizontal viewport overflow", async ({ page }) => {
    const state = await mockInterfaceCopy(page, "defaults-only");
    state.effective.navigation.overview = "Очень длинное, но допустимое название обзора";
    state.overrides.navigation.overview = state.effective.navigation.overview;
    await page.goto("/overview");
    await expect(page.getByTestId("v2-shell")).toBeVisible();
    const geometry = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      links: Array.from(document.querySelectorAll<HTMLElement>(".v2-nav-link")).every((link) => link.getBoundingClientRect().width >= 48 && link.getBoundingClientRect().height >= 48)
    }));
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.links).toBeTruthy();
  });
});
