import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const overviewV2Enabled = process.env.VITE_OVERVIEW_V2_ENABLED === "true";
const visualShellEnabled = process.env.VITE_V2_VISUAL_SHELL === "true";
const overviewEditorEnabled = process.env.VITE_OVERVIEW_EDITOR_ENABLED === "true";

async function waitForGrid(page: Page) {
  await expect(page.getByTestId("overview-grid")).toBeVisible();
  await expect(page.getByTestId("overview-grid")).toHaveAttribute("data-grid-profile", /.+/);
}

async function expectNoDocumentOverflow(page: Page) {
  const result = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(result.documentWidth).toBeLessThanOrEqual(result.viewportWidth + 1);
}

function gridItem(page: Page, instanceId: string) {
  return page.locator(`.overview-v2-grid-item[data-instance-id="${instanceId}"]`);
}

test.describe("Overview V2 safe grid foundation", () => {
  test("flag false preserves the legacy Overview content in either shell", async ({ page }) => {
    test.skip(overviewV2Enabled, "This assertion runs with the Overview V2 flag off.");
    await page.goto("/overview");
    await expect(page.getByTestId("route-overview")).toBeVisible();
    await expect(page.getByTestId("widget-coffee-machine")).toBeVisible();
    await expect(page.getByTestId("route-overview-v2")).toHaveCount(0);
    if (visualShellEnabled) {
      await expect(page.getByTestId("v2-shell")).toBeVisible();
    } else {
      await expect(page.locator(".product-shell")).toBeVisible();
    }
  });

  test("Overview V2 does not require the V2 visual shell", async ({ page }) => {
    test.skip(!overviewV2Enabled || visualShellEnabled, "Run with Overview V2 on and visual shell off.");
    await page.goto("/overview");
    await expect(page.getByTestId("route-overview-v2")).toBeVisible();
    await waitForGrid(page);
    await expect(page.locator(".product-shell")).toBeVisible();
    await expect(page.getByTestId("v2-shell")).toHaveCount(0);
  });

  test("build-disabled Overview editor gate is visible and truthful", async ({ page }) => {
    test.skip(!overviewV2Enabled || overviewEditorEnabled, "Run with Overview V2 on and the editor build gate off.");
    await page.goto("/overview");
    await expect(page.getByTestId("overview-configure")).toBeDisabled();
    await expect(page.getByTestId("overview-toolbar")).toHaveAttribute("data-configure-gate", "build-disabled");
    await expect(page.locator("#overview-configure-note")).toHaveText("Редактор выключен в этой сборке.");
    await expect(page.locator("#overview-configure-note")).toBeVisible();
  });

  test("renders the canonical 12-column fixture with exact grid units", async ({ page }) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview");
    await waitForGrid(page);
    await expect(page.getByTestId("overview-grid")).toHaveAttribute("data-grid-profile", "landscape-12");
    await expect(page.getByTestId("overview-grid")).toHaveAttribute("data-grid-columns", "12");

    const expected = [
      ["fixture.rog", 0, 0, 12, 1],
      ["fixture.coffee", 0, 1, 7, 4],
      ["fixture.planning", 7, 1, 5, 4],
      ["fixture.quick-actions", 0, 5, 7, 2],
      ["fixture.health", 7, 5, 5, 2]
    ] as const;
    for (const [instanceId, x, y, w, h] of expected) {
      await expect(gridItem(page, instanceId)).toHaveAttribute("data-grid-x", String(x));
      await expect(gridItem(page, instanceId)).toHaveAttribute("data-grid-y", String(y));
      await expect(gridItem(page, instanceId)).toHaveAttribute("data-grid-w", String(w));
      await expect(gridItem(page, instanceId)).toHaveAttribute("data-grid-h", String(h));
    }

    const gridColumns = await page.getByTestId("overview-grid").locator(".overview-v2-grid").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length
    );
    expect(gridColumns).toBe(12);
    await expectNoDocumentOverflow(page);
  });

  test("isolates a throwing widget without moving its neighbors", async ({ page }) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    await page.goto("/overview");
    await waitForGrid(page);
    const baseline = await gridItem(page, "fixture.coffee").boundingBox();
    expect(baseline).not.toBeNull();
    await page.goto("/overview?overviewFixture=error");
    await waitForGrid(page);
    await expect(gridItem(page, "fixture.throwing")).toContainText("Изолированная ошибка");
    await expect(page.getByTestId("route-overview-v2")).toBeVisible();
    const after = await gridItem(page, "fixture.coffee").boundingBox();
    expect(after).not.toBeNull();
    expect(after).toMatchObject({ x: baseline?.x, y: baseline?.y, width: baseline?.width, height: baseline?.height });
    await expectNoDocumentOverflow(page);
  });

  test("unknown fixture data is bounded and cannot inject UI or executable content", async ({ page }) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    await page.goto("/overview?overviewFixture=unknown");
    await waitForGrid(page);
    await expect(page.getByTestId("overview-widget-unavailable")).toContainText("Виджет недоступен");
    await expect(page.locator(".overview-v2-grid script, .overview-v2-grid iframe, .overview-v2-grid object, .overview-v2-grid embed")).toHaveCount(0);
    await expect(page.getByTestId("overview-grid-validation")).toContainText("ограничений безопасно");
    await expectNoDocumentOverflow(page);
  });

  test("invalid known fixture data uses a fallback without invoking a trusted renderer", async ({ page }) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    await page.goto("/overview?overviewFixture=invalid");
    await waitForGrid(page);

    const invalid = gridItem(page, "fixture.invalid");
    await expect(invalid).toHaveAttribute("data-grid-state", "fallback");
    await expect(invalid).toContainText("Виджет недоступен");
    await expect(invalid.locator(".overview-v2-widget[data-widget-type]")).toHaveCount(0);
    await expect(gridItem(page, "fixture.coffee")).toHaveAttribute("data-grid-state", "rendered");
    await expect(gridItem(page, "fixture.planning")).toHaveAttribute("data-grid-state", "rendered");

    const boxes = await page.locator(".overview-v2-grid-item").evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
    for (let index = 0; index < boxes.length; index += 1) {
      for (let next = index + 1; next < boxes.length; next += 1) {
        expect(boxes[index].right <= boxes[next].left || boxes[next].right <= boxes[index].left ||
          boxes[index].bottom <= boxes[next].top || boxes[next].bottom <= boxes[index].top).toBeTruthy();
      }
    }
    await expectNoDocumentOverflow(page);
  });

  test("projects the canonical layout to eight columns at the medium boundary", async ({ page }) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    await page.setViewportSize({ width: 1120, height: 720 });
    await page.goto("/overview");
    await waitForGrid(page);
    await expect(page.getByTestId("overview-grid")).toHaveAttribute("data-grid-profile", "medium-8");
    await expect(page.getByTestId("overview-grid")).toHaveAttribute("data-grid-columns", "8");
    const items = page.locator(".overview-v2-grid-item");
    const boxes = await items.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
    for (let index = 0; index < boxes.length; index += 1) {
      for (let next = index + 1; next < boxes.length; next += 1) {
        expect(boxes[index].right <= boxes[next].left || boxes[next].right <= boxes[index].left ||
          boxes[index].bottom <= boxes[next].top || boxes[next].bottom <= boxes[index].top).toBeTruthy();
      }
    }
    await expectNoDocumentOverflow(page);
  });

  test("projects to four columns at compact width and preserves reading order", async ({ page }) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    await page.setViewportSize({ width: 640, height: 360 });
    await page.goto("/overview");
    await waitForGrid(page);
    await expect(page.getByTestId("overview-grid")).toHaveAttribute("data-grid-profile", "compact-4");
    await expect(page.getByTestId("overview-grid")).toHaveAttribute("data-grid-columns", "4");
    expect(await page.locator(".overview-v2-grid-item").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-instance-id"))))
      .toEqual(["fixture.rog", "fixture.coffee", "fixture.planning", "fixture.quick-actions", "fixture.health"]);
    const columns = await page.locator(".overview-v2-grid-item").evaluateAll((elements) => elements.map((element) => Number(element.getAttribute("data-grid-x")) + Number(element.getAttribute("data-grid-w"))));
    expect(columns.every((end) => end <= 4)).toBe(true);
    const controls = await page.locator(".overview-v2-grid button, .overview-v2-grid a, .overview-v2-grid input, .overview-v2-grid select").evaluateAll((elements) => elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 48 && rect.height >= 48 ? [] : [{ width: rect.width, height: rect.height }];
    }));
    expect(controls).toEqual([]);
    await expectNoDocumentOverflow(page);
  });

  test("recomputes projections without changing canonical geometry", async ({ page }) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    await page.setViewportSize({ width: 1120, height: 720 });
    await page.goto("/overview");
    await waitForGrid(page);
    await expect(page.getByTestId("overview-grid")).toHaveAttribute("data-grid-profile", "medium-8");
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.getByTestId("overview-grid")).toHaveAttribute("data-grid-profile", "landscape-12");
    await expect(gridItem(page, "fixture.coffee")).toHaveAttribute("data-grid-x", "0");
    await expect(gridItem(page, "fixture.coffee")).toHaveAttribute("data-grid-y", "1");
    await expect(gridItem(page, "fixture.coffee")).toHaveAttribute("data-grid-w", "7");
    await expect(gridItem(page, "fixture.coffee")).toHaveAttribute("data-grid-h", "4");
    await expectNoDocumentOverflow(page);
  });

  test("captures the PR3 grid review pack", async ({ page }, testInfo) => {
    test.skip(!overviewV2Enabled, "Run with VITE_OVERVIEW_V2_ENABLED=true.");
    const artifactDir = process.env.V2_OVERVIEW_ARTIFACT_DIR ?? testInfo.outputPath("v2-overview-grid-artifacts");
    await mkdir(artifactDir, { recursive: true });
    const capture = async (name: string, fullPage = false) => {
      await expect(page.getByTestId("overview-grid")).toBeVisible();
      await page.screenshot({ path: path.join(artifactDir, name), animations: "disabled", fullPage });
    };

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?theme=night");
    await waitForGrid(page);
    await page.addStyleTag({ content: ".connectivity-recovery-surface { display: none !important; }" });
    await capture("overview-grid-12.png");

    await page.setViewportSize({ width: 1120, height: 720 });
    await expect(page.getByTestId("overview-grid")).toHaveAttribute("data-grid-profile", "medium-8");
    await page.addStyleTag({ content: ".connectivity-recovery-surface { display: none !important; }" });
    await capture("overview-grid-8.png");

    await page.setViewportSize({ width: 640, height: 360 });
    await expect(page.getByTestId("overview-grid")).toHaveAttribute("data-grid-profile", "compact-4");
    await page.addStyleTag({ content: ".connectivity-recovery-surface { display: none !important; }" });
    await capture("overview-grid-4.png");

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/overview?overviewFixture=error&theme=night");
    await waitForGrid(page);
    await page.addStyleTag({ content: ".connectivity-recovery-surface { display: none !important; }" });
    await gridItem(page, "fixture.throwing").scrollIntoViewIfNeeded();
    await capture("overview-grid-error-isolation.png");

    await page.goto("/overview?overviewFixture=invalid&theme=night");
    await waitForGrid(page);
    await page.addStyleTag({ content: ".connectivity-recovery-surface { display: none !important; }" });
    await gridItem(page, "fixture.invalid").scrollIntoViewIfNeeded();
    await capture("overview-grid-invalid-layout.png", true);
  });
});
