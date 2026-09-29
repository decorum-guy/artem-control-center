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

async function readStationGeometry(page: Page) {
  return page.evaluate(() => {
    const widget = document.querySelector<HTMLElement>(".station-mini-widget")!;
    const art = widget.querySelector<HTMLElement>(".station-mini-widget__art")!;
    const image = widget.querySelector<HTMLElement>(".station-mini-widget__image")!;
    const controls = widget.querySelector<HTMLElement>(".station-mini-widget__controls")!;
    const music = widget.querySelector<HTMLElement>(".station-mini-widget__music")!;
    const message = widget.querySelector<HTMLElement>(".station-mini-widget__message")!;
    const glow = widget.querySelector<HTMLElement>(".station-mini-widget__glow")!;
    const rect = (element: HTMLElement) => {
      const { top, bottom, width, height } = element.getBoundingClientRect();
      return { top, bottom, width, height };
    };
    const widgetStyle = getComputedStyle(widget);
    const imageStyle = getComputedStyle(image);
    const messageStyle = getComputedStyle(message);
    return {
      widget: rect(widget),
      art: rect(art),
      image: rect(image),
      controls: rect(controls),
      music: rect(music),
      message: rect(message),
      gridTemplateRows: widgetStyle.gridTemplateRows,
      imageStyle: {
        width: imageStyle.width,
        height: imageStyle.height,
        transform: imageStyle.transform,
        transition: imageStyle.transition,
        objectFit: imageStyle.objectFit,
        objectPosition: imageStyle.objectPosition
      },
      messageStyle: {
        lineHeight: messageStyle.lineHeight,
        minHeight: messageStyle.minHeight
      },
      pending: widget.querySelector<HTMLButtonElement>('[aria-label="Play"]')?.getAttribute("aria-busy"),
      disabledButtons: widget.querySelectorAll(".station-mini-widget__button:disabled").length,
      messageText: message.textContent,
      glow: {
        active: glow.classList.contains("station-mini-widget__glow--active"),
        animationName: getComputedStyle(glow).animationName,
        count: widget.querySelectorAll(".station-mini-widget__glow").length
      }
    };
  });
}

type StationRect = { top: number; bottom: number; width: number; height: number };
type StationGeometry = Awaited<ReturnType<typeof readStationGeometry>>;

function expectStationGeometryStable(
  baseline: StationGeometry,
  actual: StationGeometry,
  phase: string
): void {
  for (const key of ["widget", "art", "image", "controls", "music", "message"] as const) {
    const baselineRect = baseline[key] as StationRect;
    const actualRect = actual[key] as StationRect;
    for (const coordinate of ["top", "bottom", "width", "height"] as const) {
      expect(Math.abs(actualRect[coordinate] - baselineRect[coordinate]), `${phase} ${key}.${coordinate}`).toBeLessThanOrEqual(0.5);
    }
  }
  expect(actual.gridTemplateRows, `${phase} grid tracks`).toBe(baseline.gridTemplateRows);
  expect(actual.imageStyle.transform, `${phase} artwork transform`).toBe("none");
  expect(actual.imageStyle.objectFit, `${phase} artwork containment`).toBe("contain");
  expect(actual.imageStyle.objectPosition, `${phase} artwork centering`).toBe("50% 50%");
  expect(actual.messageStyle.lineHeight, `${phase} message line height`).toBe("15px");
  expect(actual.messageStyle.minHeight, `${phase} reserved message height`).toBe("15px");
  expect(actual.glow.count, `${phase} glow count`).toBe(1);
}

test.describe("Issue 298 Station Mini 2 owner artwork", () => {
  test("keeps Station layout fixed through initial and repeated action lifecycles", async ({ page }) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    await page.setViewportSize({ width: 1280, height: 720 });
    await installStationAvailability(page);
    let releaseRequest: (() => Promise<void>) | undefined;
    let requestCount = 0;
    const requests: Array<{ actionId: string; requestId: string }> = [];
    await page.route("**/api/v1/actions/station", async (route) => {
      requestCount += 1;
      const request = route.request().postDataJSON() as { actionId: string; requestId: string };
      requests.push(request);
      if (requestCount <= 2) {
        await new Promise<void>((resolve) => {
          releaseRequest = async () => {
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
    const image = widget.locator(".station-mini-widget__image");
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    const play = widget.getByRole("button", { name: "Play" });
    await expect(play).toBeEnabled();
    await play.scrollIntoViewIfNeeded();

    const snapshots: Record<string, StationGeometry> = {};
    const glow = widget.locator(".station-mini-widget__glow");
    const beforeFirst = await readStationGeometry(page);
    snapshots.beforeFirst = beforeFirst;

    await play.click();
    await expect.poll(() => requestCount).toBe(1);
    await expect(play).toHaveAttribute("aria-busy", "true");
    snapshots.firstPending = await readStationGeometry(page);
    await page.waitForTimeout(150);
    snapshots.firstEarly = await readStationGeometry(page);
    await releaseRequest?.();
    await expect(play).toHaveAttribute("aria-busy", "false");
    await expect(widget.getByRole("status")).toHaveText("Команда отправлена");
    snapshots.firstResolved = await readStationGeometry(page);
    await page.waitForTimeout(450);
    snapshots.firstMidGlow = await readStationGeometry(page);
    await expect.poll(() => glow.evaluate((element) => element.classList.contains("station-mini-widget__glow--active"))).toBe(false);
    snapshots.firstGlowFinished = await readStationGeometry(page);

    const pause = widget.getByRole("button", { name: "Pause" });
    await pause.click();
    await expect.poll(() => requestCount).toBe(2);
    await expect(pause).toHaveAttribute("aria-busy", "true");
    snapshots.repeatPending = await readStationGeometry(page);
    await page.waitForTimeout(150);
    snapshots.repeatEarly = await readStationGeometry(page);
    await releaseRequest?.();
    await expect(pause).toHaveAttribute("aria-busy", "false");
    await expect(widget.getByRole("status")).toHaveText("Команда отправлена");
    snapshots.repeatResolved = await readStationGeometry(page);
    await page.waitForTimeout(450);
    snapshots.repeatMidGlow = await readStationGeometry(page);
    await expect.poll(() => glow.evaluate((element) => element.classList.contains("station-mini-widget__glow--active"))).toBe(false);
    snapshots.repeatGlowFinished = await readStationGeometry(page);

    expect(requestCount).toBe(2);
    expect(requests.map(({ actionId }) => actionId)).toEqual(["media.alice.play", "media.alice.pause"]);
    for (const request of requests) expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(snapshots.firstPending.pending).toBe("true");
    expect(snapshots.repeatPending.pending).toBe("true");
    expect(snapshots.firstPending.disabledButtons).toBe(7);
    expect(snapshots.repeatPending.disabledButtons).toBe(7);
    expect(snapshots.firstPending.glow.active).toBe(true);
    expect(snapshots.firstResolved.messageText).toBe("Команда отправлена");
    expect(snapshots.repeatPending.messageText).toBe("");
    expect(snapshots.repeatResolved.messageText).toBe("Команда отправлена");
    expect(snapshots.firstGlowFinished.glow.active).toBe(false);
    expect(snapshots.repeatGlowFinished.glow.active).toBe(false);
    expect(snapshots.firstPending.message.height).toBe(15);
    expect(snapshots.firstResolved.message.height).toBe(15);
    for (const [phase, snapshot] of Object.entries(snapshots)) {
      expectStationGeometryStable(beforeFirst, snapshot, phase);
    }
    await expectNoHorizontalOverflow(page);
  });

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
    const play = widget.getByRole("button", { name: "Play" });
    await play.scrollIntoViewIfNeeded();
    const before = await readStationGeometry(page);

    await play.click();
    await expect(play).toHaveAttribute("aria-busy", "true");
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
    const pending = await readStationGeometry(page);
    expectStationGeometryStable(before, pending, "reduced-motion pending");
    await releaseFirstFailure?.();
    await expect(widget.getByRole("status")).toHaveText("Результат отправки неизвестен");
    const resolved = await readStationGeometry(page);
    expectStationGeometryStable(before, resolved, "reduced-motion resolved");

    await widget.getByRole("button", { name: "Pause" }).click();
    await expect(widget.getByRole("button", { name: "Pause" })).toHaveAttribute("aria-busy", "false");
    await expect(widget.getByRole("status")).toHaveText("Не удалось отправить команду");
    const repeated = await readStationGeometry(page);
    expectStationGeometryStable(before, repeated, "reduced-motion repeated action");
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
    let releaseExecute: (() => Promise<void>) | undefined;
    await page.route("**/api/v1/actions/station/presets/execute", async (route) => {
      const request = route.request().postDataJSON() as { presetId: string; requestId: string };
      executedPresetId = request.presetId;
      executedRequestId = request.requestId;
      await new Promise<void>((resolve) => {
        releaseExecute = async () => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ status: "dispatched", ...request })
          });
          resolve();
        };
      });
    });

    await page.goto("/overview");
    const widget = page.getByTestId("overview-station-mini-widget");
    const music = widget.getByRole("button", { name: /Музыка/ });
    await music.scrollIntoViewIfNeeded();
    const before = await readStationGeometry(page);
    await music.click();
    await expect(widget.locator(".station-mini-widget__glow--active")).toHaveCount(0);
    expect(executedPresetId).toBeNull();
    const musicOpen = await readStationGeometry(page);
    expectStationGeometryStable(before, musicOpen, "Music opened");
    const preset = page.getByRole("dialog", { name: "Что включить?" }).getByRole("button", { name: /Избранное/ });
    await preset.click();
    await expect.poll(() => executedPresetId).toBe("a1b2c3d4e5f6");
    expect(executedRequestId).toBeTruthy();
    expect(executedRequestId).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(widget.locator(".station-mini-widget__glow--active")).toHaveCount(1);
    await expect(widget.locator(".station-mini-widget__glow")).toHaveCount(1);
    await expect(widget.getByRole("button", { name: "Play" })).toHaveAttribute("aria-busy", "true");
    const pending = await readStationGeometry(page);
    const early = await page.waitForTimeout(150).then(() => readStationGeometry(page));
    expectStationGeometryStable(before, pending, "preset pending");
    expectStationGeometryStable(before, early, "preset early feedback");
    await releaseExecute?.();
    await expect(page.getByRole("dialog", { name: "Что включить?" })).toHaveCount(0);
    await expect(widget.getByRole("status")).toContainText("Команда отправлена");
    const resolved = await readStationGeometry(page);
    expectStationGeometryStable(before, resolved, "preset resolved");
    const midGlow = await page.waitForTimeout(450).then(() => readStationGeometry(page));
    expectStationGeometryStable(before, midGlow, "preset glow mid-point");
    await expect.poll(() => widget.locator(".station-mini-widget__glow").evaluate((element) => element.classList.contains("station-mini-widget__glow--active"))).toBe(false);
    const finished = await readStationGeometry(page);
    expectStationGeometryStable(before, finished, "preset glow finished");
    await expectNoHorizontalOverflow(page);
  });
});
