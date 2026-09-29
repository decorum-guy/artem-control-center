import { expect, test, type Page } from "@playwright/test";

const overviewV2Enabled = process.env.VITE_OVERVIEW_V2_ENABLED === "true";
const actionIds = [
  "media.alice.play",
  "media.alice.pause",
  "media.alice.volume_down",
  "media.alice.volume_up",
  "media.alice.previous",
  "media.alice.next",
  "media.alice.like"
];

async function installStationAvailability(page: Page): Promise<void> {
  await page.route("**/api/v1/actions/station/availability", async (route) => {
    const actions = Object.fromEntries(actionIds.map((actionId) => [actionId, {
      allowed: true,
      availability: "allowed",
      gateEnabled: true,
      integrationAvailable: true,
      busy: false
    }]));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ schemaVersion: 1, actions })
    });
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  )).toBe(true);
}

test.describe("Issue 298 Station Mini 2 owner artwork", () => {
  test("renders the bundled image contained in the art slot with the glow behind it", async ({ page }) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    await page.setViewportSize({ width: 1280, height: 720 });
    await installStationAvailability(page);
    let actionRequests = 0;
    await page.route("**/api/v1/actions/station", async (route) => {
      actionRequests += 1;
      await route.fulfill({ status: 204 });
    });

    await page.goto("/overview");
    const widget = page.getByTestId("overview-station-mini-widget");
    const slot = widget.getByTestId("station-artwork-slot");
    const image = slot.locator("img.station-mini-widget__image");
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    await expect(widget.locator("button[aria-label]")).toHaveCount(7);

    const imageMetrics = await image.evaluate((element: HTMLImageElement) => ({
      source: element.getAttribute("src"),
      resolvedSource: element.src,
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight,
      objectFit: getComputedStyle(element).objectFit,
      objectPosition: getComputedStyle(element).objectPosition,
      pointerEvents: getComputedStyle(element).pointerEvents,
      zIndex: getComputedStyle(element).zIndex,
      bounds: element.getBoundingClientRect().toJSON(),
      actionAncestor: element.closest("button, a, [role=button]") !== null
    }));
    expect(imageMetrics.source).toContain("/assets/widgets/station-mini-2.png");
    expect(new URL(imageMetrics.resolvedSource).origin).toBe(new URL(page.url()).origin);
    expect(imageMetrics.naturalWidth).toBeGreaterThan(0);
    expect(imageMetrics.naturalHeight).toBeGreaterThan(0);
    expect(imageMetrics.objectFit).toBe("contain");
    expect(imageMetrics.objectPosition).toBe("50% 50%");
    expect(imageMetrics.pointerEvents).toBe("none");
    expect(imageMetrics.zIndex).toBe("1");
    expect(imageMetrics.actionAncestor).toBe(false);

    const geometry = await slot.evaluate((element) => {
      const slot = element.getBoundingClientRect();
      const image = element.querySelector("img")!.getBoundingClientRect();
      const glow = element.querySelector(".station-mini-widget__glow")!;
      const glowBounds = glow.getBoundingClientRect();
      const controls = element.parentElement!.querySelector(".station-mini-widget__controls")!.getBoundingClientRect();
      const music = element.parentElement!.querySelector(".station-mini-widget__music")!.getBoundingClientRect();
      const message = element.parentElement!.querySelector(".station-mini-widget__message")!.getBoundingClientRect();
      return {
        slot: { top: slot.top, bottom: slot.bottom, width: slot.width, height: slot.height },
        imageInsideSlot: image.left >= slot.left && image.right <= slot.right && image.top >= slot.top && image.bottom <= slot.bottom,
        glowZIndex: getComputedStyle(glow).zIndex,
        glowOverlapsImage: glowBounds.left < image.right && glowBounds.right > image.left && glowBounds.top < image.bottom && glowBounds.bottom > image.top,
        controlsTop: controls.top,
        musicTop: music.top,
        messageTop: message.top
      };
    });
    expect(geometry.slot.height).toBeGreaterThanOrEqual(65);
    expect(geometry.slot.width).toBeGreaterThan(0);
    expect(geometry.imageInsideSlot, JSON.stringify({ imageMetrics, geometry })).toBe(true);
    expect(geometry.glowZIndex).toBe("0");
    expect(geometry.glowOverlapsImage).toBe(true);
    expect(geometry.slot.bottom).toBeLessThanOrEqual(geometry.controlsTop);
    expect(geometry.controlsTop).toBeLessThan(geometry.musicTop);
    expect(geometry.musicTop).toBeLessThan(geometry.messageTop);

    for (const button of await widget.locator("button[aria-label]").all()) {
      const box = await button.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(48);
      expect(box?.height).toBeGreaterThanOrEqual(48);
    }
    const musicButton = widget.getByRole("button", { name: /Музыка/ });
    expect((await musicButton.boundingBox())?.height).toBeGreaterThanOrEqual(48);

    await slot.click();
    expect(actionRequests).toBe(0);
    await expectNoHorizontalOverflow(page);
  });

  test("plays and restarts one smooth bounded pulse without moving artwork", async ({ page }) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    await page.setViewportSize({ width: 1280, height: 720 });
    await installStationAvailability(page);
    const requests: Array<{ actionId: string; requestId: string }> = [];
    let releaseFirstRequest: (() => Promise<void>) | undefined;
    await page.route("**/api/v1/actions/station", async (route) => {
      const request = route.request().postDataJSON() as { actionId: string; requestId: string };
      requests.push(request);
      if (requests.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstRequest = async () => {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ schemaVersion: 1, ...request, status: "dispatched" })
            });
            resolve();
          };
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ schemaVersion: 1, ...request, status: "dispatched" })
      });
    });

    await page.goto("/overview");
    const widget = page.getByTestId("overview-station-mini-widget");
    const slot = widget.getByTestId("station-artwork-slot");
    const image = slot.locator("img.station-mini-widget__image");
    const glow = slot.locator(".station-mini-widget__glow");
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    await expect(widget.locator("button[aria-label]")).toHaveCount(7);
    await widget.getByRole("button", { name: "Play" }).scrollIntoViewIfNeeded();
    const before = await Promise.all([
      slot.boundingBox(), image.boundingBox()
    ]);
    const baseStyle = await glow.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: style.width,
        height: style.height,
        filter: style.filter,
        background: style.backgroundImage,
        zIndex: style.zIndex,
        pointerEvents: style.pointerEvents
      };
    });
    expect(baseStyle).toMatchObject({
      width: "124px", height: "124px", filter: "blur(20px)", zIndex: "0", pointerEvents: "none"
    });
    expect(baseStyle.background).toContain("0.5)");
    expect(baseStyle.background).toContain("0.24)");

    await widget.getByRole("button", { name: "Play" }).click();
    await expect(widget.locator(".station-mini-widget__glow--active")).toHaveCount(1);
    const firstAnimation = await glow.evaluate((element) => {
      const animation = element.getAnimations()[0];
      return {
        count: element.parentElement?.querySelectorAll(".station-mini-widget__glow").length,
        name: animation?.animationName,
        duration: animation?.effect?.getTiming().duration,
        currentTime: Number(animation?.currentTime ?? 0)
      };
    });
    expect(firstAnimation).toMatchObject({ count: 1, name: "station-mini-widget-glow-pulse", duration: 1200 });
    const during = await Promise.all([slot.boundingBox(), image.boundingBox()]);
    expect(during).toEqual(before);
    await releaseFirstRequest?.();
    await expect(widget.getByRole("status")).toHaveText("Команда отправлена");

    await page.waitForTimeout(150);
    const firstTime = await glow.evaluate((element) => Number(element.getAnimations()[0]?.currentTime ?? 0));
    await widget.getByRole("button", { name: "Volume up" }).click();
    await expect(widget.getByRole("status")).toHaveText("Команда отправлена");
    const replay = await glow.evaluate((element) => ({
      count: element.parentElement?.querySelectorAll(".station-mini-widget__glow").length,
      currentTime: Number(element.getAnimations()[0]?.currentTime ?? 0),
      active: element.classList.contains("station-mini-widget__glow--active")
    }));
    expect(replay.count).toBe(1);
    expect(replay.active).toBe(true);
    expect(replay.currentTime).toBeLessThan(firstTime);
    expect(requests.map(({ actionId }) => actionId)).toEqual(["media.alice.play", "media.alice.volume_up"]);
    for (const request of requests) expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    await expect.poll(() => glow.evaluate((element) => element.classList.contains("station-mini-widget__glow--active"))).toBe(false);
    await expectNoHorizontalOverflow(page);
  });

  test("keeps reduced-motion feedback static and bounded, with existing dispatch error copy", async ({ page }) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installStationAvailability(page);
    let releaseFirstFailure: (() => Promise<void>) | undefined;
    let actionRequestCount = 0;
    await page.route("**/api/v1/actions/station", async (route) => {
      actionRequestCount += 1;
      if (actionRequestCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstFailure = async () => {
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ detail: "station_dispatch_uncertain" })
            });
            resolve();
          };
        });
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "station_dispatch_failed" })
      });
    });
    await page.goto("/overview");
    const widget = page.getByTestId("overview-station-mini-widget");
    const glow = widget.locator(".station-mini-widget__glow");
    const slot = widget.getByTestId("station-artwork-slot");
    const image = slot.locator("img.station-mini-widget__image");
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    await widget.getByRole("button", { name: "Play" }).scrollIntoViewIfNeeded();
    const before = await Promise.all([slot.boundingBox(), image.boundingBox()]);

    await widget.getByRole("button", { name: "Play" }).click();
    await expect(widget.locator(".station-mini-widget__glow--active")).toHaveCount(1);
    const reducedStyle = await glow.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        animationName: style.animationName,
        transitionProperty: style.transitionProperty,
        transform: style.transform,
        opacity: style.opacity,
        runningAnimations: element.getAnimations().length
      };
    });
    expect(reducedStyle.animationName).toBe("none");
    expect(reducedStyle.transitionProperty).toBe("none");
    expect(reducedStyle.transform).toBe("none");
    expect(reducedStyle.opacity).toBe("0.78");
    expect(reducedStyle.runningAnimations).toBe(0);
    expect(await Promise.all([slot.boundingBox(), image.boundingBox()])).toEqual(before);
    await releaseFirstFailure?.();
    await expect(widget.getByRole("status")).toHaveText("Результат отправки неизвестен");

    await widget.getByRole("button", { name: "Pause" }).click();
    await expect(widget.getByRole("status")).toHaveText("Не удалось отправить команду");
    await expect.poll(() => glow.evaluate((element) => element.classList.contains("station-mini-widget__glow--active"))).toBe(false);
    expect(await glow.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
    await expectNoHorizontalOverflow(page);
  });

  test("uses the existing SVG outline when the bundled image request fails", async ({ page }) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    await page.setViewportSize({ width: 1280, height: 720 });
    await installStationAvailability(page);
    await page.route("**/src/assets/widgets/station-mini-2.png", async (route) => route.fulfill({
      status: 404,
      contentType: "image/png",
      body: ""
    }));

    await page.goto("/overview");
    const widget = page.getByTestId("overview-station-mini-widget");
    const slot = widget.getByTestId("station-artwork-slot");
    await expect(slot.locator("svg.station-mini-widget__fallback")).toBeVisible();
    await expect(slot.locator("img.station-mini-widget__image")).toHaveCount(0);
    await expect(widget.locator("button[aria-label]")).toHaveCount(7);
    await expectNoHorizontalOverflow(page);
  });

  test("keeps the existing Music preset dispatch flow", async ({ page }) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    await page.setViewportSize({ width: 1280, height: 720 });
    await installStationAvailability(page);
    await page.route("**/api/v1/actions/station/presets", async (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        revision: "fixture-r1",
        updatedAt: "2026-09-27T00:00:00Z",
        presets: [{ id: "a1b2c3d4e5f6", title: "Избранное" }]
      })
    }));
    let executedPresetId: string | null = null;
    let executedRequestId: string | null = null;
    await page.route("**/api/v1/actions/station/presets/execute", async (route) => {
      const request = route.request().postDataJSON() as { presetId: string; requestId: string };
      executedPresetId = request.presetId;
      executedRequestId = request.requestId;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "dispatched", ...request })
      });
    });

    await page.goto("/overview");
    const widget = page.getByTestId("overview-station-mini-widget");
    await widget.getByRole("button", { name: /Музыка/ }).click();
    await expect(widget.locator(".station-mini-widget__glow--active")).toHaveCount(0);
    await page.getByRole("dialog", { name: "Что включить?" }).getByRole("button", { name: /Избранное/ }).click();
    await expect.poll(() => executedPresetId).toBe("a1b2c3d4e5f6");
    expect(executedRequestId).toBeTruthy();
    await expect(widget.locator(".station-mini-widget__glow--active")).toHaveCount(1);
    await expect(widget.locator(".station-mini-widget__glow")).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: "Что включить?" })).toHaveCount(0);
    await expect(widget.getByRole("status")).toContainText("Команда отправлена");
  });
});
