import { expect, test } from "@playwright/test";

test.skip(process.env.VITE_V2_VISUAL_SHELL !== "true" || process.env.VITE_V3_VISUAL_SKIN !== "true",
  "Read the native settings and the Cabin controls in their respective profiles.");

test("settings commits a keyboard value and restores focus from a nested choices sheet", async ({ page }) => {
  const control = { available: true, writable: true, reason: null, writeAvailability: "allowed", value: 42 };
  const system = { schemaVersion: 1, platform: "windows", controls: { volume: { ...control }, brightness: { ...control } } };
  const values: number[] = [];
  await page.route("**/api/v1/settings/system-controls", route => route.fulfill({ json: system }));
  await page.route("**/api/v1/settings/system-controls/volume", route => {
    const value = route.request().postDataJSON().value;
    values.push(value);
    system.controls.volume.value = value;
    return route.fulfill({ json: system });
  });
  await page.route("**/api/v1/settings/ai", route => route.fulfill({ json: {
    schemaVersion: "ai.provider-settings.v1", revision: 1, enabled: true, available: true, writesEnabled: true,
    selectedProvider: "local", warnings: [], providers: ["local", "deepseek"].map(id => ({
      id, model: "fixture", models: ["fixture"], configured: true, state: "configured", credentialPresent: false
    }))
  } }));
  await page.goto("/settings?motion=reduced");
  const volume = page.getByRole("slider", { name: "Громкость" });
  await expect(volume).toHaveAttribute("aria-valuenow", "42");
  await volume.press("ArrowRight");
  await expect.poll(() => values).toEqual([43]);
  await expect(volume).toHaveAttribute("aria-valuenow", "43");
  const summary = page.getByTestId("settings-summary-ai");
  await summary.click();
  const outer = page.getByTestId("settings-ai-sheet");
  const trigger = outer.getByRole("button", { name: /Провайдер текстового AI/ });
  await trigger.click();
  const choices = page.getByRole("listbox", { name: "Провайдер текстового AI" });
  await expect(choices.getByRole("option", { selected: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(choices.getByRole("option", { name: /DeepSeek/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(choices).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(outer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(summary).toBeFocused();
});
