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
    await page.getByRole("dialog", { name: "Что включить?" }).getByRole("button", { name: /Избранное/ }).click();
    await expect.poll(() => executedPresetId).toBe("a1b2c3d4e5f6");
    expect(executedRequestId).toBeTruthy();
    await expect(page.getByRole("dialog", { name: "Что включить?" })).toHaveCount(0);
    await expect(widget.getByRole("status")).toContainText("Команда отправлена");
  });
});
