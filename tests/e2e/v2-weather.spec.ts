import { expect, test, type Page } from "@playwright/test";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

test.use({ hasTouch: true });

type WeatherFixture =
  | "clear-day"
  | "clear-night"
  | "partly-day"
  | "partly-night"
  | "cloudy"
  | "fog"
  | "rain-day"
  | "rain-night"
  | "storm"
  | "snow-day"
  | "snow-night"
  | "stale"
  | "offline"
  | "long-location";

const artifactNames = [
  "weather-clear-day.png",
  "weather-clear-night.png",
  "weather-partly-cloudy-day.png",
  "weather-partly-cloudy-night.png",
  "weather-cloudy.png",
  "weather-fog.png",
  "weather-rain-day.png",
  "weather-rain-night.png",
  "weather-storm.png",
  "weather-snow-day.png",
  "weather-snow-night.png",
  "weather-stale.png",
  "weather-long-location.png",
  "weather-200-percent.png",
  "weather-management-sheet.png",
  "weather-reduced-motion.png",
  "weather-cloud-seam-before.png",
  "weather-cloud-seam-zero.png",
  "weather-rain-seam-before.png",
  "weather-rain-seam-zero.png",
  "weather-snow-near-seam-before.png",
  "weather-snow-near-seam-zero.png",
  "weather-snow-far-seam-before.png",
  "weather-snow-far-seam-zero.png"
] as const;

async function openWeather(page: Page, fixture: WeatherFixture, query = "") {
  const suffix = query ? `&${query}` : "";
  await page.goto(`/weather?weatherFixture=${fixture}${suffix}`);
  await expect(page.getByTestId("route-weather")).toBeVisible();
  if (fixture !== "offline") await expect(page.getByTestId("weather-hero")).toBeVisible();
}

async function expectNoDocumentOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
}

async function expectWeatherTouchTargets(page: Page) {
  const violations = await page.locator(".weather-page--v2 button, .weather-page--v2 input").evaluateAll((elements) => elements.flatMap((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return [];
    return rect.width >= 48 && rect.height >= 48
      ? []
      : [{ text: element.textContent?.trim(), width: rect.width, height: rect.height }];
  }));
  expect(violations, JSON.stringify(violations)).toEqual([]);
}

async function artifactDirectory(testInfo: { outputPath: (name: string) => string }) {
  const directory = process.env.V2_WEATHER_ARTIFACT_DIR ?? testInfo.outputPath("v2-weather-artifacts");
  await mkdir(directory, { recursive: true });
  return directory;
}

test.describe("Control Center V2 Weather", () => {
  test("keeps the canonical first viewport geometry and operational hierarchy", async ({ page }) => {
    await openWeather(page, "clear-day", "theme=day");
    const toolbar = await page.locator(".weather-toolbar--v2").boundingBox();
    const hero = await page.getByTestId("weather-hero").boundingBox();
    const hourly = await page.getByTestId("weather-hourly-zone").boundingBox();
    const context = await page.getByTestId("weather-context-zone").boundingBox();
    expect(toolbar).toMatchObject({ height: 48 });
    expect(hero?.height).toBe(260);
    expect(hourly?.height).toBe(184);
    expect(context?.height).toBe(184);
    expect((hourly?.width ?? 0)).toBeGreaterThan(context?.width ?? 0);
    expect(hourly?.x).toBeLessThan(context?.x ?? 0);
    expect((hourly?.y ?? 0) - (hero?.y ?? 0) - (hero?.height ?? 0)).toBeCloseTo(12, 0);
    expect((context?.y ?? 0) - (hero?.y ?? 0) - (hero?.height ?? 0)).toBeCloseTo(12, 0);
    await expect(page.getByTestId("weather-hourly-zone")).toContainText("Почасовой прогноз");
    await expect(page.getByTestId("weather-context-zone")).toContainText("Ветер");
    await expect(page.getByTestId("weather-daily-zone")).toContainText("Прогноз");
    await expectNoDocumentOverflow(page);
    await expectWeatherTouchTargets(page);
  });

  test("keeps app theme and Weather isDay independent", async ({ page }) => {
    for (const theme of ["day", "night"] as const) {
      for (const [fixture, celestial] of [["clear-day", "sun"], ["clear-night", "moon"]] as const) {
        await openWeather(page, fixture, `theme=${theme}`);
        const compositor = page.locator(".weather-compositor");
        await expect(compositor).toHaveAttribute("data-weather-is-day", fixture === "clear-day" ? "true" : "false");
        await expect(page.locator(".weather-hero__condition-glyph")).toHaveAttribute("data-weather-celestial", celestial);
        await expect(page.getByTestId("weather-hero")).toHaveAttribute("data-weather-tone", fixture);
      }
    }
  });

  test("uses fixed fixture conditions without arbitrary presentation injection", async ({ page }) => {
    const cases: Array<[WeatherFixture, string, number]> = [
      ["clear-day", "clear", 0],
      ["clear-night", "clear", 0],
      ["partly-day", "partly", 1],
      ["partly-night", "partly", 1],
      ["cloudy", "cloudy", 1],
      ["fog", "fog", 2],
      ["rain-day", "rain", 1],
      ["rain-night", "rain", 1],
      ["storm", "storm", 1],
      ["snow-day", "snow", 2],
      ["snow-night", "snow", 2]
    ];
    for (const [fixture, kind, movingCount] of cases) {
      await openWeather(page, fixture);
      await expect(page.locator(".weather-compositor")).toHaveAttribute("data-weather-kind", kind);
      await expect(page.locator(".weather-compositor")).toHaveAttribute("data-weather-moving-count", String(movingCount));
      await expect(page.locator(".weather-hero__primary")).toContainText(/°/);
      await expect(page.locator(".weather-hero__primary")).toContainText(/ясно|облач|морось|ливни|туман|дождь|гроза|снег/i);
    }
    await openWeather(page, "offline");
    await expect(page.locator(".weather-empty--v2")).toHaveAttribute("data-weather-state", "offline");
    await expect(page.locator(".weather-empty--v2")).toContainText("Актуальные данные недоступны");
  });

  test("pauses and resumes ambience for every established motion policy", async ({ page }) => {
    await openWeather(page, "rain-day", "motion=full");
    const compositor = page.locator(".weather-compositor");
    const semanticTemperature = await page.locator(".weather-temperature").innerText();
    await expect(compositor).toHaveAttribute("data-weather-motion", "running");
    await expect(page.locator(".weather-layer[data-weather-moving-layer='rain']")).toHaveCSS("animation-name", "weather-rain-tile");

    for (const mode of ["reduced", "low-performance", "battery-saving"] as const) {
      await openWeather(page, "rain-day", `motion=${mode}`);
      await expect(compositor).toHaveAttribute("data-weather-motion", "stopped");
      await expect(compositor).toHaveAttribute("data-weather-motion-policy", mode === "reduced" ? "reduced" : mode);
      await expect(page.locator(".weather-layer[data-weather-moving-layer='rain']")).toHaveCSS("animation-name", "none");
      await expect(page.locator(".weather-temperature")).toContainText(semanticTemperature.replace("\n", ""));
      await expect(page.getByTestId("weather-hero")).toContainText("Дождь");
    }

    await openWeather(page, "rain-day", "motion=full");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(compositor).toHaveAttribute("data-weather-motion-policy", "hidden");
    await expect(compositor).toHaveAttribute("data-weather-visibility", "hidden");
    await expect(page.locator(".weather-layer[data-weather-moving-layer='rain']")).toHaveCSS("animation-name", "none");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(compositor).toHaveAttribute("data-weather-motion", "running");
    await expect(compositor).toHaveAttribute("data-weather-visibility", "visible");
    await expect(page.locator(".weather-layer[data-weather-moving-layer='rain']")).toHaveCSS("animation-name", "weather-rain-tile");
  });

  test("proves transform-only, tile-exact seam boundaries", async ({ page }) => {
    const cases = [
      { fixture: "partly-day" as const, layer: "clouds", end: "translate3d(-560px, 0px, 0px)", tile: "560x160" },
      { fixture: "rain-day" as const, layer: "rain", end: "translate3d(-24px, 72px, 0px)", tile: "24x72" },
      { fixture: "snow-day" as const, layer: "snow-near", end: "translate3d(-40px, 80px, 0px)", tile: "40x80" },
      { fixture: "snow-day" as const, layer: "snow-far", end: "translate3d(-64px, 96px, 0px)", tile: "64x96" },
      { fixture: "fog" as const, layer: "fog-far", end: "translate3d(-420px, 0px, 0px)", tile: "420x160" },
      { fixture: "fog" as const, layer: "fog-near", end: "translate3d(-520px, 0px, 0px)", tile: "520x180" }
    ];

    for (const item of cases) {
      await openWeather(page, item.fixture, `weatherPhase=before`);
      const layer = page.locator(`[data-weather-moving-layer='${item.layer}']`);
      await expect(layer).toHaveAttribute("data-weather-loop-end", item.end);
      await expect(layer).toHaveAttribute("data-weather-tile", item.tile);
      const before = await layer.evaluate((element) => getComputedStyle(element).transform);
      expect(before).not.toBe("none");

      await openWeather(page, item.fixture, `weatherPhase=end`);
      const end = await page.locator(`[data-weather-moving-layer='${item.layer}']`).evaluate((element) => getComputedStyle(element).transform);
      expect(end).toMatch(/matrix\(1, 0, 0, 1, -/);

      await openWeather(page, item.fixture, `weatherPhase=zero`);
      const zero = await page.locator(`[data-weather-moving-layer='${item.layer}']`).evaluate((element) => getComputedStyle(element).transform);
      expect(zero).toMatch(/matrix\(1, 0, 0, 1, 0, 0\)/);
    }
  });

  test("scopes animation regression to compositor styles", async ({ page }) => {
    await openWeather(page, "rain-day");
    const css = await page.evaluate(async () => fetch("/src/Weather.css").then((response) => response.text()));
    const compositorCss = css.slice(css.indexOf("/* Control Center V2 Weather compositor"));
    const keyframeStart = compositorCss.indexOf("@keyframes weather-cloud-track");
    const keyframeEnd = compositorCss.indexOf(".weather-compositor[data-weather-motion");
    const keyframeSection = compositorCss.slice(keyframeStart, keyframeEnd);
    expect(keyframeSection.match(/@keyframes /g)?.length).toBeGreaterThanOrEqual(6);
    expect(keyframeSection).not.toMatch(/background-position|filter|blur\(|(?:^|[;{ ])(?:top|left|width|height):/);
    expect(compositorCss).not.toMatch(/requestAnimationFrame|background-position|\bfilter\s*:|\bblur\(/);
    const animatedLayers = await page.locator(".weather-layer").evaluateAll((elements) => elements.map((element) => ({
      animation: getComputedStyle(element).animationName,
      transform: getComputedStyle(element).transform
    })));
    expect(animatedLayers.every((layer) => layer.animation !== "none")).toBeTruthy();
    expect(animatedLayers.every((layer) => layer.transform === "none" || layer.transform.startsWith("matrix"))).toBeTruthy();
  });

  test("keeps management in the shared Sheet and restores focus", async ({ page }, testInfo) => {
    await openWeather(page, "clear-day");
    const trigger = page.getByRole("button", { name: "Управление" });
    await trigger.focus();
    await trigger.press("Enter");
    const sheet = page.getByTestId("weather-management-sheet");
    await expect(sheet).toBeVisible();
    await expect(page.locator(".weather-page--v2 > .weather-location-manager")).toHaveCount(0);
    await expect(sheet.locator(".weather-location-manager")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();

    const directory = await artifactDirectory(testInfo);
    await page.getByRole("button", { name: "Управление" }).click();
    await expect(sheet).toBeVisible();
    await page.screenshot({ path: path.join(directory, "weather-management-sheet.png"), animations: "disabled" });
  });

  test("stays bounded at 200 percent and supports long trusted location labels", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 640, height: 360 });
    await openWeather(page, "long-location", "theme=night");
    await expectNoDocumentOverflow(page);
    await expect(page.getByRole("button", { name: "+ Место" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Управление" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Обновить прогноз" })).toBeVisible();
    await expect(page.getByTestId("weather-hero")).toContainText("Санкт-Петербургский городской округ");
    await expect(page.locator(".weather-location-tabs button")).toHaveAttribute("title", /Санкт-Петербургский/);
    const toolbarBounds = await page.locator(".weather-toolbar--v2").evaluate((toolbar) => {
      const viewportWidth = document.documentElement.clientWidth;
      const location = toolbar.querySelector<HTMLElement>(".weather-location-tabs");
      const locationRect = location?.getBoundingClientRect();
      const actionBoxes = Array.from(toolbar.querySelectorAll<HTMLElement>(".weather-toolbar__actions button")).map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      return { viewportWidth, locationBox: locationRect ? { left: locationRect.left, right: locationRect.right, top: locationRect.top, bottom: locationRect.bottom } : null, actionBoxes };
    });
    expect(toolbarBounds.locationBox).not.toBeNull();
    expect(toolbarBounds.locationBox!.left).toBeGreaterThanOrEqual(0);
    expect(toolbarBounds.locationBox!.right).toBeLessThanOrEqual(toolbarBounds.viewportWidth);
    expect(toolbarBounds.actionBoxes.every((box) => box.left >= 0 && box.right <= toolbarBounds.viewportWidth && box.top >= 112)).toBeTruthy();
    await expectWeatherTouchTargets(page);
    const positions = await page.locator(".weather-content-grid--v2 > section").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
    expect(positions[1]).toBeGreaterThan(positions[0]);
    const directory = await artifactDirectory(testInfo);
    await page.screenshot({ path: path.join(directory, "weather-200-percent.png"), animations: "disabled" });
  });

  test("captures the complete synthetic Weather review family", async ({ page }, testInfo) => {
    const directory = await artifactDirectory(testInfo);
    const capture = async (name: string, fixture: WeatherFixture, query = "") => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await openWeather(page, fixture, query);
      await page.screenshot({ path: path.join(directory, name), animations: "disabled" });
    };

    await capture("weather-clear-day.png", "clear-day", "theme=day");
    await capture("weather-clear-night.png", "clear-night", "theme=night");
    await capture("weather-partly-cloudy-day.png", "partly-day", "theme=day");
    await capture("weather-partly-cloudy-night.png", "partly-night", "theme=night");
    await capture("weather-cloudy.png", "cloudy", "theme=night");
    await capture("weather-fog.png", "fog", "theme=day");
    await capture("weather-rain-day.png", "rain-day", "theme=day");
    await capture("weather-rain-night.png", "rain-night", "theme=night");
    await capture("weather-storm.png", "storm", "theme=night");
    await capture("weather-snow-day.png", "snow-day", "theme=day");
    await capture("weather-snow-night.png", "snow-night", "theme=night");
    await capture("weather-stale.png", "stale", "theme=night");
    await capture("weather-long-location.png", "long-location", "theme=day");

    await page.setViewportSize({ width: 640, height: 360 });
    await openWeather(page, "rain-day", "motion=reduced&theme=night");
    await expect(page.locator(".weather-compositor")).toHaveAttribute("data-weather-motion", "stopped");
    await page.screenshot({ path: path.join(directory, "weather-reduced-motion.png"), animations: "disabled" });

    for (const seam of [
      ["weather-cloud-seam", "partly-day", "clouds"],
      ["weather-rain-seam", "rain-day", "rain"],
      ["weather-snow-near-seam", "snow-day", "snow-near"],
      ["weather-snow-far-seam", "snow-day", "snow-far"]
    ] as const) {
      await page.setViewportSize({ width: 1280, height: 720 });
      await openWeather(page, seam[1], "weatherPhase=before");
      await page.screenshot({ path: path.join(directory, `${seam[0]}-before.png`), animations: "disabled" });
      await openWeather(page, seam[1], "weatherPhase=zero");
      await page.screenshot({ path: path.join(directory, `${seam[0]}-zero.png`), animations: "disabled" });
    }

    const files = (await readdir(directory)).filter((file) => file.endsWith(".png")).sort();
    expect(files).toEqual([...artifactNames].sort());
  });
});
