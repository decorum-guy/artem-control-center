import { expect, test } from "@playwright/test";

test.skip(process.env.VITE_V2_VISUAL_SHELL !== "true" || process.env.VITE_OVERVIEW_V2_ENABLED !== "true",
  "The interactive climate cards are enabled by the accepted panel profile.");

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

test("locking aborts a held preflight and allows a new climate request after unlocking", async ({ page }) => {
  test.skip(process.env.VITE_TOUCH_INPUT_LOCK_ENABLED !== "true", "Enable the production interaction lock.");
  let holdNext = false;
  let held = false;
  const posted: number[] = [];
  let releaseOld!: () => void;
  const oldResponse = new Promise<void>(resolve => { releaseOld = resolve; });
  await page.route("**/api/v1/actions/home-assistant/availability", async route => {
    if (holdNext) {
      holdNext = false;
      held = true;
      await oldResponse;
      return route.fulfill({ json: { schemaVersion: 1, actions: {} } }).catch(() => {});
    }
    return route.fulfill({ json: availability() });
  });
  await page.route("**/api/v1/actions/home-assistant", async route => {
    const action = route.request().postDataJSON();
    posted.push(action.temperature);
    await route.fulfill({ json: { ...action, status: "confirmed", observedAt: "2026-11-24T07:10:00Z",
      climate: { state: "cool", targetTemperature: action.temperature, fanMode: "one" } } });
  });
  await page.goto("/home?scenario=home-climate-healthy&motion=reduced");
  const minus = page.getByTestId("climate-temperature-decrease-home");
  const confirm = page.getByTestId("climate-temperature-confirm-home");
  const lock = page.getByTestId("interaction-lock-control");
  await minus.click();
  holdNext = true;
  await confirm.click();
  await expect.poll(() => held).toBe(true);
  await lock.click({ delay: 1000 });
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  await lock.click({ delay: 1000 });
  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await minus.click();
  await confirm.click();
  try {
    await expect.poll(() => posted.length).toBe(1);
  } finally {
    releaseOld();
  }
  await expect(minus).toBeEnabled();
  expect(posted).toHaveLength(1);
});
