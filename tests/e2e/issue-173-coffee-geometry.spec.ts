import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

const visualShellEnabled = process.env.VITE_V2_VISUAL_SHELL === "true";
const overviewV2Enabled = process.env.VITE_OVERVIEW_V2_ENABLED === "true";

type Rect = { x: number; y: number; width: number; height: number; right: number; bottom: number };

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

function expectContained(inner: Rect, outer: Rect, tolerance = 1) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - tolerance);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - tolerance);
  expect(inner.right).toBeLessThanOrEqual(outer.right + tolerance);
  expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + tolerance);
}

function expectNoIntersection(first: Rect, second: Rect, tolerance = 1) {
  expect(
    first.bottom <= second.y + tolerance || second.bottom <= first.y + tolerance,
    "Expected the image and activity rectangles to be separated"
  ).toBe(true);
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

test.describe("#173 Coffee composition stabilization", () => {
  test.skip(
    !visualShellEnabled || !overviewV2Enabled,
    "Run with VITE_V2_VISUAL_SHELL=true and VITE_OVERVIEW_V2_ENABLED=true."
  );

  test.beforeEach(async ({ page }) => {
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
      const snapshot = await response.json() as { services: Array<Record<string, any>> };
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
      await route.fulfill({
        response,
        body: JSON.stringify(snapshot),
        headers: { ...response.headers(), "content-type": "application/json" }
      });
    });
  });

  test("keeps the 1280px Coffee media and footer geometry stable across states", async ({ page }, testInfo: TestInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const states = [
      ["coffee-off", "off", "coffee-off.png"],
      ["coffee-warming", "warming", "coffee-warming.png"],
      ["coffee-ready", "ready", "coffee-ready.png"],
      ["ha-offline-policy-available", "unavailable", "coffee-unavailable.png"]
    ] as const;
    const imageLeftEdges: Record<string, number> = {};
    const onlineAnchors: Array<{ top: number; right: number }> = [];

    for (const [scenario, stage, screenshotName] of states) {
      await page.goto(`/overview?scenario=${scenario}&theme=night`);
      const coffee = await waitForCoffee(page, stage);
      await assertCoffeeComposition(coffee);
      const panelBox = await rect(coffee);
      expect(panelBox.height).toBeGreaterThanOrEqual(280);
      expect(panelBox.height).toBeLessThanOrEqual(330);
      const assetBox = await rect(coffee.locator(".coffee-asset"));
      const imageBox = await rect(coffee.locator(".coffee-asset__image"));
      imageLeftEdges[stage] = imageBox.x - assetBox.x;
      expect(imageBox.x + imageBox.width / 2).toBeLessThan(assetBox.x + assetBox.width / 2 - 12);
      if (stage !== "unavailable") {
        const online = coffee.locator(".coffee-panel__status .health-mark--healthy");
        const onlineBox = await rect(online);
        onlineAnchors.push({
          top: onlineBox.y - panelBox.y,
          right: panelBox.right - onlineBox.right
        });
        await expect(online).toHaveText("Онлайн");
      }
      await expect(coffee.locator(".coffee-asset")).not.toContainText("Готова");
      await expect(coffee.locator(".coffee-asset")).not.toContainText("Разогрев");
      await page.screenshot({ path: testInfo.outputPath(screenshotName) });
      await expectNoOverflow(page);
    }

    for (const stage of ["warming", "ready", "unavailable"]) {
      expect(Math.abs(imageLeftEdges[stage] - imageLeftEdges.off)).toBeLessThanOrEqual(1);
    }
    for (const anchor of onlineAnchors) {
      expect(Math.abs(anchor.top - onlineAnchors[0].top)).toBeLessThanOrEqual(1);
      expect(Math.abs(anchor.right - onlineAnchors[0].right)).toBeLessThanOrEqual(1);
    }
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
      await expect(coffee.getByTestId("coffee-progress")).toHaveCount(stage === "warming" ? 1 : 0);
      if (stage === "warming") {
        await expect(coffee.locator(".coffee-activity")).toBeHidden();
      }
      expectVerticallyCentered(imageBoxes[stage], assetBoxes[stage]);
      await page.screenshot({ path: testInfo.outputPath(screenshotName), animations: "disabled", scale: "css" });
      await expectNoOverflow(page);
    }

    expect(imageBoxes.warming.x).toBeGreaterThan(imageBoxes.off.x + 8);
    expect(imageBoxes.ready.x).toBeGreaterThan(imageBoxes.off.x + 8);
    expect(imageBoxes.warming.width).toBeGreaterThan(imageBoxes.off.width + 5);
    expect(imageBoxes.warming.height).toBeGreaterThan(imageBoxes.off.height + 5);
    expect(Math.abs(imageBoxes.warming.x - imageBoxes.ready.x)).toBeLessThanOrEqual(1);
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

  test("reserves a separate warming activity region", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?scenario=coffee-warming&theme=night");
    const coffee = await waitForCoffee(page, "warming");
    const imageBox = await rect(coffee.locator(".coffee-asset__image"));
    const activityBox = await rect(coffee.locator(".coffee-activity"));
    expectNoIntersection(imageBox, activityBox);
    await expect(coffee.locator(".coffee-panel__state")).toContainText("Разогревается");
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
