import { expect, test, type Page } from "@playwright/test";

const v2Enabled = process.env.VITE_V2_VISUAL_SHELL === "true";
const overviewV2Enabled = process.env.VITE_OVERVIEW_V2_ENABLED === "true";

type VisibilityState = { revision: number; visible: boolean; failNextSave: boolean };

async function mockVisibility(page: Page, initialVisible = true): Promise<VisibilityState> {
  const state: VisibilityState = { revision: 0, visible: initialVisible, failNextSave: false };
  await page.route("**/api/v1/settings/device-visibility", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        schemaVersion: "device.visibility.v1",
        revision: state.revision,
        updatedAt: "2026-08-31T00:00:00Z",
        devices: [{ key: "kettle", label: "Чайник", defaultVisible: true, visible: state.visible }],
        available: true,
        warnings: [],
        writesEnabled: true
      }) });
      return;
    }
    const payload = route.request().postDataJSON() as { expectedRevision?: number; deviceKey?: string; visible?: boolean };
    if (payload.deviceKey !== "kettle") {
      await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: "validation_error" }) });
      return;
    }
    if (state.failNextSave) {
      state.failNextSave = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "stored_device_visibility_unavailable" }) });
      return;
    }
    if (payload.expectedRevision !== state.revision) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "revision_conflict" }) });
      return;
    }
    state.visible = payload.visible === true;
    state.revision += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      schemaVersion: "device.visibility.v1", revision: state.revision, updatedAt: "2026-08-31T00:00:00Z",
      devices: [{ key: "kettle", label: "Чайник", defaultVisible: true, visible: state.visible }], available: true, warnings: [], writesEnabled: true
    }) });
  });
  return state;
}

async function openVisibilitySheet(page: Page) {
  await page.goto("/settings");
  await expect(page.getByTestId("route-settings")).toBeVisible();
  await page.getByTestId("settings-summary-device-visibility").click();
  await expect(page.getByTestId("settings-device-visibility-sheet")).toBeVisible();
}

async function expectKettleAbsent(page: Page) {
  await expect(page.getByTestId("device-row-kettle")).toHaveCount(0);
  await expect(page.getByTestId("widget-kettle")).toHaveCount(0);
  if (overviewV2Enabled) await expect(page.getByTestId("overview-home-device-kettle")).toHaveCount(0);
}

test.describe("#172 bounded kettle visibility", () => {
  test.skip(!v2Enabled, "Run with VITE_V2_VISUAL_SHELL=true for the Settings V2 gate.");

  test("Settings persists hide/restore while Home and Overview remain presentation-only", async ({ page }) => {
    const state = await mockVisibility(page);
    await openVisibilitySheet(page);
    const checkbox = page.getByTestId("device-visibility-kettle");
    await expect(checkbox).toBeChecked();
    await expect(page.getByText("интеграции и их действия не меняются", { exact: false })).toBeVisible();

    await checkbox.click();
    await expect(page.getByRole("status")).toContainText("Сохранено: чайник скрыт");
    expect(state.visible).toBe(false);

    await page.goto("/home?scenario=home-coffee-kettle");
    await expect(page.getByTestId("route-home-v2")).toBeVisible();
    await expectKettleAbsent(page);
    await page.goto("/overview?scenario=home-coffee-kettle");
    await expect(page.getByTestId(overviewV2Enabled ? "route-overview-v2" : "route-overview")).toBeVisible();
    await expectKettleAbsent(page);

    await page.reload();
    await expectKettleAbsent(page);

    await openVisibilitySheet(page);
    await expect(checkbox).not.toBeChecked();
    await checkbox.click();
    await expect(page.getByRole("status")).toContainText("Сохранено: чайник снова показывается");
    await page.goto("/home?scenario=home-coffee-kettle");
    await expect(page.getByTestId("device-row-kettle")).toBeVisible();
    if (overviewV2Enabled) {
      await page.goto("/overview?scenario=home-coffee-kettle");
      await expect(page.getByTestId("overview-home-device-kettle")).toBeVisible();
    }
  });

  test("rejects arbitrary browser keys and leaves confirmed state after a failed save", async ({ page }) => {
    const state = await mockVisibility(page);
    await page.goto("/settings");
    const unknown = await page.evaluate(async () => {
      const response = await fetch(new URL("/api/v1/settings/device-visibility", window.location.origin), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 0, deviceKey: "switch.random", visible: false }) });
      return response.status;
    });
    expect(unknown).toBe(422);

    state.failNextSave = true;
    await openVisibilitySheet(page);
    const checkbox = page.getByTestId("device-visibility-kettle");
    await checkbox.click();
    await expect(page.getByRole("status")).toContainText("Не удалось сохранить");
    await expect(checkbox).toBeChecked();
    expect(state.visible).toBe(true);
  });

  test("keeps the bounded touch target and narrow layout safe", async ({ page }) => {
    await mockVisibility(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openVisibilitySheet(page);
    const checkbox = page.getByTestId("device-visibility-kettle");
    const box = await checkbox.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(48);
    expect(box?.height).toBeGreaterThanOrEqual(48);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
