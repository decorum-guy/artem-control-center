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
