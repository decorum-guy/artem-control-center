import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

const visualShellEnabled = process.env.VITE_V2_VISUAL_SHELL === "true";
const overviewV2Enabled = process.env.VITE_OVERVIEW_V2_ENABLED === "true";

type Rect = { x: number; y: number; width: number; height: number; right: number; bottom: number };
type CoffeeTransitionFixture = "off" | "warming" | "ready" | null;

let coffeeTransitionFixture: CoffeeTransitionFixture = null;

async function waitForCoffee(page: Page, stage: string) {
  const coffee = page.getByTestId("widget-coffee-machine");
  await expect(coffee).toHaveAttribute("data-stage", stage);
  const image = coffee.locator(".coffee-asset__image");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => {
    const imageElement = element as HTMLImageElement;
    return imageElement.complete && imageElement.naturalWidth > 0;
  })).toBe(true);
  return coffee;
}

async function rect(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  expect(box, `Expected ${await locator.evaluate((element) => element.className)} to have a box`).not.toBeNull();
  return {
    x: box!.x,
    y: box!.y,
    width: box!.width,
    height: box!.height,
    right: box!.x + box!.width,
    bottom: box!.y + box!.height
  };
}

type ProgressPresentation = { opacity: number; height: number; marginBottom: number; visibility: string };

async function progressPresentation(locator: Locator): Promise<ProgressPresentation> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      opacity: Number.parseFloat(style.opacity),
      height: box.height,
      marginBottom: Number.parseFloat(style.marginBottom),
      visibility: style.visibility
    };
  });
}

async function sampleProgressTransition(page: Page, triggerSnapshot = false): Promise<ProgressPresentation[]> {
  return page.evaluate((shouldTriggerSnapshot) => new Promise<ProgressPresentation[]>((resolve) => {
    const element = document.querySelector<HTMLElement>('[data-testid="coffee-progress"]');
    if (!element) throw new Error("Expected Coffee progress shell");
    const samples: ProgressPresentation[] = [];
    const startedAt = performance.now();
    const sample = () => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      samples.push({
        opacity: Number.parseFloat(style.opacity),
        height: box.height,
        marginBottom: Number.parseFloat(style.marginBottom),
        visibility: style.visibility
      });
      if (performance.now() - startedAt < 600) requestAnimationFrame(sample);
      else resolve(samples);
    };
    sample();
    if (shouldTriggerSnapshot) {
      (window as unknown as { emitSnapshot: () => void }).emitSnapshot();
    }
  }), triggerSnapshot);
}

function expectContained(inner: Rect, outer: Rect, tolerance = 1) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - tolerance);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - tolerance);
  expect(inner.right).toBeLessThanOrEqual(outer.right + tolerance);
  expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + tolerance);
}

function expectVerticallyCentered(inner: Rect, outer: Rect, tolerance = 1) {
  const innerCenter = inner.y + inner.height / 2;
  const outerCenter = outer.y + outer.height / 2;
  expect(Math.abs(innerCenter - outerCenter)).toBeLessThanOrEqual(tolerance);
}

async function expectNoOverflow(page: Page) {
  const size = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(size.documentWidth).toBeLessThanOrEqual(size.viewportWidth + 1);
}

async function assertCoffeeComposition(coffee: Locator) {
  const panelBox = await rect(coffee);
  const asset = coffee.locator(".coffee-asset");
  const visual = coffee.locator(".coffee-asset__visual");
  const image = coffee.locator(".coffee-asset__image");
  const assetBox = await rect(asset);
  const visualBox = await rect(visual);
  const imageBox = await rect(image);
  expectContained(visualBox, assetBox);
  expectContained(imageBox, assetBox);
  await expect(coffee.locator(".coffee-panel__heading .section-kicker")).toHaveText("Дом");
  await expect(coffee.locator(".coffee-panel__heading h2")).toHaveText("Кофемашина");
  await expect(coffee.locator(".coffee-state-marker")).toHaveCount(0);

  const actionRow = coffee.locator(".coffee-action-row");
  if (await actionRow.count()) {
    const footerBox = await rect(actionRow);
    expectContained(footerBox, panelBox);
    for (const button of await actionRow.locator("button:visible").all()) {
      const buttonBox = await rect(button);
      expectContained(buttonBox, footerBox);
      expect(buttonBox.height).toBeGreaterThanOrEqual(48);
      expect(buttonBox.width).toBeGreaterThanOrEqual(48);
    }
  }
}

async function assertHomeCoffeeProportions(coffee: Locator, timerExpected: boolean) {
  const panelBox = await rect(coffee);
  expect(panelBox.width).toBeGreaterThanOrEqual(520);
  expect(panelBox.width).toBeLessThanOrEqual(570);

  const primary = coffee.locator(".primary-action");
  const primaryBox = await rect(primary);
  expect(primaryBox.width).toBeGreaterThanOrEqual(180);
  expect(primaryBox.width).toBeLessThanOrEqual(230);
  expect(primaryBox.height).toBe(56);

  const title = coffee.locator(".coffee-panel__heading h2");
  await expect(title).toHaveCSS("font-size", "26px");

  const online = coffee.locator(".coffee-panel__status .health-mark--healthy");
  const onlineBox = await rect(online);
  expect(onlineBox.y - panelBox.y).toBeGreaterThanOrEqual(10);
  expect(onlineBox.y - panelBox.y).toBeLessThanOrEqual(14);
  expect(panelBox.right - onlineBox.right).toBeGreaterThanOrEqual(10);
  expect(panelBox.right - onlineBox.right).toBeLessThanOrEqual(14);

  const timer = coffee.locator(".coffee-delayed-start-action");
  await expect(timer).toHaveCount(timerExpected ? 1 : 0);
  if (timerExpected) {
    const timerBox = await rect(timer);
    expect(timerBox.width).toBe(56);
    expect(timerBox.height).toBe(56);
    expect(timerBox.width).toBeGreaterThanOrEqual(48);
    expect(timerBox.height).toBeGreaterThanOrEqual(48);
  }
}

async function assertOverviewCoffeeProportions(coffee: Locator, timerExpected: boolean) {
  const panelBox = await rect(coffee);
  expect(panelBox.width).toBeGreaterThanOrEqual(580);
  expect(panelBox.width).toBeLessThanOrEqual(640);

  const primary = coffee.locator(".primary-action");
  const primaryBox = await rect(primary);
  expect(primaryBox.width).toBe(208);
  expect(primaryBox.height).toBe(56);

  const title = coffee.locator(".coffee-panel__heading h2");
  await expect(title).toHaveCSS("font-size", "26px");
  await expect(coffee.locator(".coffee-panel__heading .section-kicker")).toHaveText("Дом");
  await expect(coffee.locator(".coffee-activity")).toHaveCount(0);
  await expect(coffee.locator(".coffee-asset")).toHaveCSS("border-left-width", "0px");
  await expect(coffee.locator(".coffee-asset")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  const timer = coffee.locator(".coffee-delayed-start-action");
  await expect(timer).toHaveCount(timerExpected ? 1 : 0);
  if (timerExpected) {
    const timerBox = await rect(timer);
    expect(timerBox.width).toBe(56);
    expect(timerBox.height).toBe(56);
    expect(timerBox.width).toBeGreaterThanOrEqual(48);
    expect(timerBox.height).toBeGreaterThanOrEqual(48);
  }
}

test.describe("#173 Coffee composition stabilization", () => {
  test.skip(
    !visualShellEnabled || !overviewV2Enabled,
    "Run with VITE_V2_VISUAL_SHELL=true and VITE_OVERVIEW_V2_ENABLED=true."
  );

  test.beforeEach(async ({ page }) => {
    coffeeTransitionFixture = null;
    await page.route("**/api/v1/access", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          baseProfile: "full",
          effectiveProfile: "full",
          temporaryFull: false,
          temporaryFullExpiresAt: null,
          confirmationPolicy: { actionConfirmationRequired: false, mode: "manual_persistent_full" },
          pinConfigured: true,
          lockoutUntil: null,
          capabilities: {}
        })
      });
    });
    await page.route("**/api/v1/snapshot**", async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json() as { generatedAt?: string; services: Array<Record<string, any>> };
      for (const service of snapshot.services) {
        if (service.id !== "coffee-machine") continue;
        const machine = service.data?.machine as Record<string, any> | undefined;
        if (!machine) continue;
        for (const action of service.actions as Array<Record<string, any>>) {
          action.enabled = action.id === "home.coffee.turn_on"
            ? machine.state === "off"
            : machine.state === "on";
        }
      }
      if (coffeeTransitionFixture) {
        const coffee = snapshot.services.find((service) => service.id === "coffee-machine");
        const coffeeData = coffee?.data as { machine?: Record<string, any>; timingPolicy?: Record<string, any> } | undefined;
        if (coffee && coffeeData?.machine && coffeeData.timingPolicy) {
          coffeeData.machine.available = true;
          coffeeData.machine.stale = false;
          if (coffeeTransitionFixture === "off") {
            coffeeData.machine.state = "off";
            coffeeData.machine.turnedOnAt = null;
          } else {
            coffeeData.machine.state = "on";
            const warmupSeconds = Number(coffeeData.timingPolicy.warmupDurationSeconds ?? 780);
            const longRunningSeconds = Number(coffeeData.timingPolicy.longRunningThresholdSeconds ?? Number.POSITIVE_INFINITY);
            const elapsed = coffeeTransitionFixture === "warming"
              ? Math.min(warmupSeconds * 0.45, longRunningSeconds * 0.45)
              : warmupSeconds + 1;
            const snapshotTime = Date.parse(snapshot.generatedAt ?? "");
            const baseTime = Number.isFinite(snapshotTime) ? snapshotTime : Date.now();
            coffeeData.machine.turnedOnAt = new Date(baseTime - elapsed * 1000).toISOString();
          }
        }
      }
      await route.fulfill({
        response,
        body: JSON.stringify(snapshot),
        headers: { ...response.headers(), "content-type": "application/json" }
      });
    });
  });

  test("renders the accepted Overview Coffee composition at 1280px and captures canonical screenshots", async ({ page }, testInfo: TestInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const states = [
      ["coffee-off", "off", "overview-coffee-off-1280x720.png"],
      ["coffee-warming", "warming", "overview-coffee-warming-1280x720.png"],
      ["coffee-ready", "ready", "overview-coffee-ready-1280x720.png"]
    ] as const;
    const imageBoxes: Record<string, Rect> = {};
    const panelBoxes: Record<string, Rect> = {};
    const onlineAnchors: Array<{ top: number; right: number }> = [];

    for (const [scenario, stage, screenshotName] of states) {
      await page.goto(`/overview?scenario=${scenario}&theme=night`);
      const coffee = await waitForCoffee(page, stage);
      await assertCoffeeComposition(coffee);
      await assertOverviewCoffeeProportions(coffee, stage === "off");
      const panelBox = await rect(coffee);
      expect(panelBox.height).toBeGreaterThanOrEqual(260);
      expect(panelBox.height).toBeLessThanOrEqual(330);
      panelBoxes[stage] = panelBox;
      const assetBox = await rect(coffee.locator(".coffee-asset"));
      const imageBox = await rect(coffee.locator(".coffee-asset__image"));
      expectContained(imageBox, assetBox);
      imageBoxes[stage] = imageBox;
      const online = coffee.locator(".coffee-panel__status .health-mark--healthy");
      const onlineBox = await rect(online);
      onlineAnchors.push({
        top: onlineBox.y - panelBox.y,
        right: panelBox.right - onlineBox.right
      });
      await expect(online).toHaveText("Онлайн");
      const accent = await coffee.evaluate((element) => {
        const pseudo = getComputedStyle(element, "::before");
        return { width: pseudo.width, opacity: Number.parseFloat(pseudo.opacity) };
      });
      expect(accent.width).toBe("2px");
      expect(accent.opacity).toBeGreaterThan(0);
      await page.screenshot({ path: testInfo.outputPath(screenshotName) });
      await expectNoOverflow(page);
    }

    expect(imageBoxes.warming.x).toBeGreaterThan(imageBoxes.off.x + 8);
    expect(imageBoxes.warming.width).toBeGreaterThan(imageBoxes.off.width + 5);
    expect(imageBoxes.ready.x).toBeLessThan(imageBoxes.warming.x - 8);
    expect(Math.abs(imageBoxes.ready.width - imageBoxes.warming.width)).toBeLessThanOrEqual(1);
    for (const stage of ["warming", "ready"] as const) {
      expect(panelBoxes[stage].x).toBe(panelBoxes.off.x);
      expect(panelBoxes[stage].y).toBe(panelBoxes.off.y);
      expect(panelBoxes[stage].width).toBe(panelBoxes.off.width);
      expect(panelBoxes[stage].height).toBe(panelBoxes.off.height);
    }
    for (const anchor of onlineAnchors) {
      expect(Math.abs(anchor.top - onlineAnchors[0].top)).toBeLessThanOrEqual(1);
      expect(Math.abs(anchor.right - onlineAnchors[0].right)).toBeLessThanOrEqual(1);
    }
  });

  test("animates the actual Overview Coffee transition and collapses warming progress on ready", async ({ page }) => {
    await page.addInitScript(() => {
      type Handler = (event: Event) => void;
      const sources: Array<{ handlers: Map<string, Handler[]> }> = [];
      class FakeEventSource {
        handlers = new Map<string, Handler[]>();
        constructor() { sources.push(this); }
        addEventListener(type: string, handler: Handler) {
          this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
        }
        close() {}
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
      (window as unknown as { emitSnapshot: () => void }).emitSnapshot = () => {
        for (const source of sources) {
          for (const handler of source.handlers.get("snapshot") ?? []) {
            handler(new MessageEvent("snapshot", { data: "{}" }));
          }
        }
      };
    });

    await page.setViewportSize({ width: 1280, height: 720 });
    coffeeTransitionFixture = "off";
    await page.goto("/overview?scenario=coffee-off&theme=night");
    const coffee = await waitForCoffee(page, "off");
    const image = coffee.locator(".coffee-asset__image");
    const progress = coffee.getByTestId("coffee-progress");
    const offImage = await rect(image);
    await expect(progress).toHaveCount(0);
    await expect(coffee).toHaveAttribute("data-transition", "idle");

    coffeeTransitionFixture = "warming";
    await page.evaluate(() => (window as unknown as { emitSnapshot: () => void }).emitSnapshot());
    await expect(coffee).toHaveAttribute("data-stage", "warming");
    await expect(coffee).toHaveAttribute("data-transition", "moving");
    await expect(progress).toHaveCount(1);
    await expect(progress).toHaveAttribute("data-progress-visible", "false");
    const fadeInSamplesPromise = sampleProgressTransition(page);
    await page.waitForTimeout(140);
    const warmingMidImage = await rect(image);
    await expect(coffee).toHaveAttribute("data-transition", "revealing");
    await expect(progress).toHaveAttribute("data-progress-visible", "true");
    const warmingImage = await rect(image);
    const warmingProgress = await progressPresentation(progress);
    const fadeInSamples = await fadeInSamplesPromise;
    const fadeInMid = fadeInSamples.find((sample) => sample.opacity > 0.05 && sample.opacity < 0.95);
    expect(warmingMidImage.x).toBeGreaterThan(offImage.x + 1);
    expect(warmingMidImage.x).toBeLessThan(warmingImage.x - 0.05);
    expect(warmingMidImage.width).toBeGreaterThan(offImage.width + 1);
    expect(warmingMidImage.width).toBeLessThan(warmingImage.width - 0.05);
    expect(warmingImage.width).toBeGreaterThan(offImage.width + 5);
    expect(fadeInMid, "Expected an intermediate Overview progress fade-in sample").toBeDefined();
    expect(fadeInMid!.height).toBeGreaterThan(1);
    expect(fadeInMid!.height).toBeLessThan(warmingProgress.height - 1);

    coffeeTransitionFixture = "ready";
    const fadeOutSamplesPromise = sampleProgressTransition(page, true);
    await expect(coffee).toHaveAttribute("data-stage", "ready");
    await expect(progress).toHaveAttribute("data-progress-visible", "false");
    await page.waitForTimeout(80);
    const readyMidImage = await rect(image);
    await page.waitForTimeout(340);
    const readyImage = await rect(image);
    const fadeOutSamples = await fadeOutSamplesPromise;
    const fadeOutMid = fadeOutSamples.find((sample) =>
      sample.opacity > 0.05 && sample.opacity < 0.95 && sample.height > 1 && sample.height < warmingProgress.height - 1
    );
    expect(readyMidImage.x).toBeLessThan(warmingImage.x - 1);
    expect(readyMidImage.x).toBeGreaterThan(readyImage.x + 1);
    expect(Math.abs(readyImage.width - warmingImage.width)).toBeLessThanOrEqual(1);
    expect(fadeOutMid, "Expected an intermediate Overview progress fade-out sample").toBeDefined();
    expect(fadeOutMid!.marginBottom).toBeGreaterThan(0);
    expect(await coffee.locator(".coffee-asset__motion").evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0.36s");
    await expect(progress).toBeHidden();
    const readyProgress = await progressPresentation(progress);
    expect(readyProgress.opacity).toBeLessThanOrEqual(0.01);
    expect(readyProgress.height).toBeLessThanOrEqual(1);
    expect(readyProgress.marginBottom).toBe(0);
    await expect(coffee.locator(".coffee-activity")).toHaveCount(0);
    await expectNoOverflow(page);
  });

  test("lands the Overview Coffee composition directly with reduced motion and keeps narrow targets safe", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/overview?scenario=coffee-warming&theme=night");
    const warmingCoffee = await waitForCoffee(page, "warming");
    const warmingProgress = warmingCoffee.getByTestId("coffee-progress");
    await expect(warmingCoffee).toHaveAttribute("data-transition", "idle");
    await expect(warmingProgress).toBeVisible();
    await expect(warmingProgress).toHaveAttribute("aria-hidden", "false");
    expect(await warmingCoffee.locator(".coffee-asset__motion").evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(0.01);

    await page.goto("/overview?scenario=coffee-ready&theme=night");
    const readyCoffee = page.getByTestId("widget-coffee-machine");
    const readyProgress = readyCoffee.getByTestId("coffee-progress");
    await expect(readyProgress).toHaveCount(1);
    await expect(readyProgress).toBeHidden();
    const ready = await progressPresentation(readyProgress);
    expect(ready.opacity).toBe(0);
    expect(ready.height).toBeLessThanOrEqual(1);
    expect(ready.marginBottom).toBe(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/overview?scenario=coffee-off&theme=night");
    const narrowCoffee = page.getByTestId("widget-coffee-machine");
    await expect(narrowCoffee).toHaveAttribute("data-stage", "off");
    const [narrowPrimary, narrowTimer] = await Promise.all([
      rect(narrowCoffee.locator(".primary-action")),
      rect(narrowCoffee.locator(".coffee-delayed-start-action"))
    ]);
    expect(narrowPrimary.width).toBeGreaterThanOrEqual(48);
    expect(narrowPrimary.height).toBeGreaterThanOrEqual(48);
    expect(narrowTimer.width).toBeGreaterThanOrEqual(48);
    expect(narrowTimer.height).toBeGreaterThanOrEqual(48);
    await expect(page.getByTestId("overview-grid")).toHaveAttribute("data-grid-profile", "compact-4");
    await expectNoOverflow(page);
  });

  test("keeps Home V2 Coffee proportions compact across the canonical states", async ({ page }, testInfo: TestInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const states = [
      ["coffee-off", "off", "home-coffee-off-1280x720.png"],
      ["coffee-warming", "warming", "home-coffee-warming-1280x720.png"],
      ["coffee-ready", "ready", "home-coffee-ready-1280x720.png"]
    ] as const;

    for (const [scenario, stage, screenshotName] of states) {
      await page.goto(`/home?scenario=${scenario}&theme=night`);
      const coffee = await waitForCoffee(page, stage);
      await assertCoffeeComposition(coffee);
      await assertHomeCoffeeProportions(coffee, stage === "off");
      await page.screenshot({ path: testInfo.outputPath(screenshotName), animations: "disabled", scale: "css" });
      await expectNoOverflow(page);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/home?scenario=coffee-off&theme=night");
    const narrowCoffee = await waitForCoffee(page, "off");
    await assertCoffeeComposition(narrowCoffee);
    const narrowPrimary = await rect(narrowCoffee.locator(".primary-action"));
    const narrowTimer = await rect(narrowCoffee.locator(".coffee-delayed-start-action"));
    expect(narrowPrimary.width).toBeGreaterThanOrEqual(48);
    expect(narrowPrimary.height).toBeGreaterThanOrEqual(48);
    expect(narrowTimer.width).toBeGreaterThanOrEqual(48);
    expect(narrowTimer.height).toBeGreaterThanOrEqual(48);
    await page.screenshot({ path: testInfo.outputPath("home-coffee-off-390x844.png"), animations: "disabled", scale: "css" });
    await expectNoOverflow(page);
  });

  test("keeps Home V2 Coffee states coherent with a disabled warming activity", async ({ page }, testInfo: TestInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const states = [
      ["coffee-off", "off", "home-coffee-motion-off-1280x720.png"],
      ["coffee-warming", "warming", "home-coffee-motion-warming-1280x720.png"],
      ["coffee-ready", "ready", "home-coffee-motion-ready-1280x720.png"]
    ] as const;
    const assetBoxes: Record<string, Rect> = {};
    const imageBoxes: Record<string, Rect> = {};

    for (const [scenario, stage, screenshotName] of states) {
      await page.goto(`/home?scenario=${scenario}&theme=night`);
      const coffee = await waitForCoffee(page, stage);
      await assertCoffeeComposition(coffee);
      await assertHomeCoffeeProportions(coffee, stage === "off");
      assetBoxes[stage] = await rect(coffee.locator(".coffee-asset"));
      imageBoxes[stage] = await rect(coffee.locator(".coffee-asset__image"));
      await expect(coffee.locator(".coffee-asset")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      const accent = await coffee.evaluate((element, cssVariable) => {
        const pseudo = getComputedStyle(element, "::before");
        const probe = document.createElement("span");
        probe.style.color = getComputedStyle(element).getPropertyValue(cssVariable).trim();
        document.body.appendChild(probe);
        const resolvedColor = getComputedStyle(probe).color;
        probe.remove();
        return {
          width: pseudo.width,
          color: pseudo.backgroundColor,
          expectedColor: resolvedColor,
          borderTopLeftRadius: pseudo.borderTopLeftRadius,
          borderBottomLeftRadius: pseudo.borderBottomLeftRadius,
          borderTopRightRadius: pseudo.borderTopRightRadius,
          borderBottomRightRadius: pseudo.borderBottomRightRadius
        };
      }, stage === "ready" ? "--success" : "--cc-accent");
      expect(accent.width).toBe("2px");
      expect(accent.color).toBe(accent.expectedColor);
      expect(accent.borderTopLeftRadius).toBe("0px");
      expect(accent.borderBottomLeftRadius).toBe("0px");
      expect(accent.borderTopRightRadius).toBe("2px");
      expect(accent.borderBottomRightRadius).toBe("2px");
      await expect(coffee.locator(".coffee-activity")).toHaveCount(stage === "warming" ? 1 : 0);
      await expect(coffee.getByTestId("coffee-progress")).toHaveCount(1);
      await expect(coffee.locator(".coffee-asset__image")).toHaveCSS("transition-duration", "0.36s");
      await expect(coffee.locator(".coffee-asset__visual")).toHaveCSS("transition-duration", "0.36s");
      if (stage === "warming") {
        await expect(coffee.locator(".coffee-activity")).toBeHidden();
        await expect(coffee.getByTestId("coffee-progress")).toBeVisible();
      } else {
        await expect(coffee.getByTestId("coffee-progress")).toBeHidden();
      }
      expectVerticallyCentered(imageBoxes[stage], assetBoxes[stage]);
      await page.screenshot({ path: testInfo.outputPath(screenshotName), animations: "disabled", scale: "css" });
      await expectNoOverflow(page);
    }

    expect(imageBoxes.warming.x).toBeGreaterThan(imageBoxes.off.x + 8);
    expect(imageBoxes.ready.x).toBeLessThan(imageBoxes.warming.x - 8);
    expect(imageBoxes.warming.width).toBeGreaterThan(imageBoxes.off.width + 5);
    expect(imageBoxes.warming.height).toBeGreaterThan(imageBoxes.off.height + 5);
    expect(imageBoxes.warming.x - imageBoxes.ready.x).toBeGreaterThan(8);
    expect(Math.abs(imageBoxes.warming.y - imageBoxes.ready.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(imageBoxes.warming.width - imageBoxes.ready.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(imageBoxes.warming.height - imageBoxes.ready.height)).toBeLessThanOrEqual(1);
  });

  test("supports the Home V2 moving-to-revealing class path and reduced-motion landing", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/home?scenario=coffee-off&theme=night");
    const coffee = await waitForCoffee(page, "off");
    const image = coffee.locator(".coffee-asset__image");
    const visual = coffee.locator(".coffee-asset__visual");
    const resting = await rect(image);
    await expect(coffee).toHaveAttribute("data-transition", "idle");
    await expect(image).toHaveCSS("transition-duration", "0.36s");
    await expect(visual).toHaveCSS("transition-duration", "0.36s");

    await coffee.evaluate((element) => element.classList.add("coffee-panel--transition-moving"));
    await page.waitForTimeout(420);
    const moving = await rect(image);
    expect(moving.x).toBeGreaterThan(resting.x + 8);
    expect(moving.width).toBeGreaterThan(resting.width + 5);
    await coffee.evaluate((element) => element.classList.replace("coffee-panel--transition-moving", "coffee-panel--transition-revealing"));
    await expect(coffee).toHaveAttribute("data-transition", "idle");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await coffee.evaluate((element) => element.classList.add("coffee-panel--transition-moving"));
    await expect(image).toHaveCSS("transition-duration", "0.001s");
    await expect(visual).toHaveCSS("transition-duration", "0.001s");
    const reducedMotion = await rect(image);
    expect(reducedMotion.x).toBeGreaterThan(resting.x + 8);
    await expectNoOverflow(page);
  });

  test("animates the Home V2 image from OFF to warming and back left on ready", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/home?scenario=coffee-off&theme=night");
    const coffee = await waitForCoffee(page, "off");
    const image = coffee.locator(".coffee-asset__image");
    const resting = await rect(image);

    await coffee.evaluate((element) => element.classList.add("coffee-panel--warming"));
    await page.waitForTimeout(140);
    const warmingMid = await rect(image);
    await page.waitForTimeout(280);
    const warming = await rect(image);
    expect(warmingMid.x).toBeGreaterThan(resting.x + 1);
    expect(warmingMid.x).toBeLessThan(warming.x - 1);
    expect(warmingMid.width).toBeGreaterThan(resting.width + 1);

    await coffee.evaluate((element) => element.classList.replace("coffee-panel--warming", "coffee-panel--ready"));
    await page.waitForTimeout(140);
    const readyMid = await rect(image);
    await page.waitForTimeout(280);
    const ready = await rect(image);
    expect(readyMid.x).toBeLessThan(warming.x - 1);
    expect(readyMid.x).toBeGreaterThan(ready.x + 1);
    expect(ready.width).toBeGreaterThan(resting.width + 5);
    expect(Math.abs(ready.width - warming.width)).toBeLessThanOrEqual(1);
    await expectNoOverflow(page);
  });

  test("fades and collapses Home V2 warmup progress across a real state transition", async ({ page }) => {
    await page.addInitScript(() => {
      type Handler = (event: Event) => void;
      const sources: Array<{ handlers: Map<string, Handler[]> }> = [];
      class FakeEventSource {
        handlers = new Map<string, Handler[]>();
        constructor() {
          sources.push(this);
        }
        addEventListener(type: string, handler: Handler) {
          this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
        }
        close() {}
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
      (window as unknown as { emitSnapshot: () => void }).emitSnapshot = () => {
        for (const source of sources) {
          for (const handler of source.handlers.get("snapshot") ?? []) {
            handler(new MessageEvent("snapshot", { data: "{}" }));
          }
        }
      };
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    coffeeTransitionFixture = "off";
    await page.goto("/home?scenario=coffee-off&theme=night");
    const coffee = await waitForCoffee(page, "off");
    const progress = coffee.getByTestId("coffee-progress");
    await expect(progress).toHaveCount(1);
    await expect(progress).toBeHidden();
    const off = await progressPresentation(progress);
    expect(off.opacity).toBe(0);
    expect(off.height).toBeLessThanOrEqual(1);
    expect(off.marginBottom).toBe(0);
    await expect(coffee).toHaveAttribute("data-progress-visible", "false");

    coffeeTransitionFixture = "warming";
    await page.evaluate(() => (window as unknown as { emitSnapshot: () => void }).emitSnapshot());
    await expect(coffee).toHaveAttribute("data-stage", "warming");
    await expect(coffee).toHaveAttribute("data-transition", "moving");
    await expect(progress).toHaveAttribute("data-progress-visible", "false");
    const moving = await progressPresentation(progress);
    expect(moving.height).toBeLessThanOrEqual(1);

    const fadeInSamplesPromise = sampleProgressTransition(page);
    await expect(coffee).toHaveAttribute("data-transition", "revealing");
    await expect(progress).toHaveAttribute("data-progress-visible", "true");
    const transitionMs = await progress.evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration.split(",")[0]) * 1000);
    const fadeInSamples = await fadeInSamplesPromise;
    const warmingFull = await progressPresentation(progress);
    expect(warmingFull.opacity).toBeGreaterThan(0.99);
    const fadeInMid = fadeInSamples.find((sample) => sample.opacity > 0.05 && sample.opacity < 0.95);
    expect(fadeInMid, "Expected an intermediate fade-in opacity sample").toBeDefined();
    expect(fadeInMid!.height).toBeGreaterThan(off.height + 1);
    expect(fadeInMid!.height).toBeLessThan(warmingFull.height - 1);
    await expect(progress.locator("output")).toHaveText(/\d+%/);

    coffeeTransitionFixture = "ready";
    const fadeOutSamplesPromise = sampleProgressTransition(page, true);
    await expect(coffee).toHaveAttribute("data-stage", "ready");
    await expect(progress).toHaveAttribute("data-progress-visible", "false");
    await expect(progress).toHaveAttribute("aria-hidden", "true");
    const fadeOutSamples = await fadeOutSamplesPromise;
    const fadeOutMid = fadeOutSamples.find((sample) =>
      sample.opacity > 0.05 && sample.opacity < 0.95 && sample.height > 1 && sample.height < warmingFull.height - 1
    );
    expect(fadeOutMid, "Expected an intermediate fade-out opacity and geometry sample").toBeDefined();
    expect(fadeOutMid!.marginBottom).toBeGreaterThan(0);

    expect(transitionMs).toBeGreaterThanOrEqual(180);
    expect(transitionMs).toBeLessThanOrEqual(240);
    await expect(progress).toBeHidden();
    const ready = await progressPresentation(progress);
    expect(ready.opacity).toBeLessThanOrEqual(0.01);
    expect(ready.height).toBeLessThanOrEqual(1);
    expect(ready.marginBottom).toBe(0);
    await expectNoOverflow(page);
  });

  test("lands Home V2 warmup progress directly with reduced motion", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/home?scenario=coffee-warming&theme=night");
    const coffee = await waitForCoffee(page, "warming");
    const progress = coffee.getByTestId("coffee-progress");
    await expect(progress).toHaveCount(1);
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute("aria-hidden", "false");
    const warming = await progressPresentation(progress);
    expect(warming.opacity).toBe(1);
    expect(warming.height).toBeGreaterThan(1);

    await page.goto("/home?scenario=coffee-ready&theme=night");
    const readyProgress = page.getByTestId("widget-coffee-machine").getByTestId("coffee-progress");
    await expect(readyProgress).toHaveCount(1);
    await expect(readyProgress).toBeHidden();
    const ready = await progressPresentation(readyProgress);
    expect(ready.opacity).toBe(0);
    expect(ready.height).toBeLessThanOrEqual(1);
    expect(ready.marginBottom).toBe(0);
    await expectNoOverflow(page);
  });

  test("keeps Overview warming activity bars hidden", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?scenario=coffee-warming&theme=night");
    const coffee = await waitForCoffee(page, "warming");
    await expect(coffee.locator(".coffee-activity")).toHaveCount(0);
    await expect(coffee.locator(".coffee-panel__state")).toContainText("Разогревается");
    await expectNoOverflow(page);
  });

  test("keeps Coffee contained under narrow and 200% zoom-equivalent pressure", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/home?scenario=coffee-off&theme=night");
    const narrowCoffee = await waitForCoffee(page, "off");
    await assertCoffeeComposition(narrowCoffee);
    const narrowTargets = await Promise.all([
      narrowCoffee.getByRole("button", { name: "Включить" }).boundingBox(),
      narrowCoffee.getByTestId("coffee-delayed-start-action").boundingBox()
    ]);
    expect(narrowTargets.every((target) => target && target.width >= 48 && target.height >= 48)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("coffee-off-narrow.png") });
    await expectNoOverflow(page);

    await page.setViewportSize({ width: 640, height: 900 });
    await page.goto("/home?scenario=coffee-warming&theme=night");
    const coffee = await waitForCoffee(page, "warming");
    await assertCoffeeComposition(coffee);
    await expectNoOverflow(page);
  });
});
