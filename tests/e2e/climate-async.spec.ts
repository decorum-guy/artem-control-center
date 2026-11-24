import { expect, test } from "@playwright/test";

const cap = "home.climate.";
function availability() {
  return { schemaVersion: 1, actions: Object.fromEntries([
    "power_on", "power_off", "set_temperature", "set_mode", "set_fan_mode"
  ].map(name => [cap + name, { allowed: true, availability: "allowed", gateEnabled: true, integrationAvailable: true }])) };
}

for (const view of ["home", "overview"]) {
  test(`climate preserves newer draft and stops after uncertain result on ${view}`, async ({ page }) => {
    const posted: number[] = [];
    let initialDone!: () => void;
    const first = new Promise<void>(resolve => { initialDone = resolve; });
    await page.route("**/api/v1/actions/home-assistant/availability", route => route.fulfill({ json: availability() }));
    await page.route("**/api/v1/actions/home-assistant", async route => {
      const action = route.request().postDataJSON();
      posted.push(action.temperature);
      if (posted.length === 1) await first;
      else return route.fulfill({ status: 504, json: { detail: "ha_verification_timeout" } });
      await route.fulfill({ json: { ...action, status: "confirmed", observedAt: "2026-11-24T07:10:00Z",
        climate: { state: "cool", targetTemperature: action.temperature, fanMode: "one" } } });
    });
    await page.goto(`/${view}?scenario=home-climate-healthy&motion=reduced`);
    const minus = page.getByTestId(`climate-temperature-decrease-${view}`);
    const ok = page.getByTestId(`climate-temperature-confirm-${view}`);
    const value = page.getByTestId(`climate-temperature-value-${view}`);
    await expect(minus).toBeEnabled();
    const original = Number((await value.innerText()).match(/\d+/)?.[0]);
    expect(original).toBeGreaterThan(19);
    await minus.click();
    await ok.click();
    await expect.poll(() => posted.length).toBe(1);
    await minus.click();
    await ok.click();
    await minus.click(); // This third draft is intentionally left unconfirmed.
    expect(posted).toEqual([original - 1]);
    initialDone();
    await expect.poll(() => posted.length).toBe(2);
    await expect(page.getByText(/Home Assistant не подтвердил/)).toBeVisible();
    await expect(value).toContainText(String(original - 3));
    expect(posted).toEqual([original - 1, original - 2]);
  });
}
