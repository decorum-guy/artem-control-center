import { expect, test } from "@playwright/test";

test.skip(process.env.VITE_V2_VISUAL_SHELL !== "true" || process.env.VITE_V3_VISUAL_SKIN !== "true",
  "These layouts belong to the Cabin profile.");

for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  test(`climate labels and availability fit the Overview tile at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/v1/actions/home-assistant/availability", route => route.fulfill({ status: 503, json: {} }));
    await page.goto("/overview?scenario=coffee-ready&motion=reduced");
    const climate = page.locator(".climate-control").first();
    const note = climate.locator(".climate-control__api-note");
    await expect(note).toBeVisible();
    const selectors = climate.locator(".cc-select");
    await expect(selectors).toHaveCount(2);
    await expect(selectors.first()).toHaveAccessibleName(/Режим кондиционера/);
    await expect.poll(() => climate.evaluate(tile => {
      const fields = Array.from(tile.querySelectorAll(".cc-select"));
      const noteTop = tile.querySelector(".climate-control__api-note")!.getBoundingClientRect().top;
      return noteTop - Math.max(...fields.map(field => field.getBoundingClientRect().bottom));
    })).toBeGreaterThanOrEqual(4);
  });
}

test("disabled assistant stays absent and the panel loads size-appropriate artwork", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("artem-control-center.jarvis-visible", "true"));
  await page.goto("/home?motion=reduced");
  const launcher = page.getByTestId("jarvis-launcher");
  await expect(launcher).toHaveCount(0);
  await expect(page.locator(".coffee-asset__image").first()).toHaveAttribute("src", /coffee-machine-(panel|overview).*\.webp/);
  await page.goto("/home?scenario=coffee-warming&motion=full");
  await expect(page.locator(".coffee-panel").first()).toHaveAttribute("data-stage", "warming");
  const repeating = await page.evaluate(() => document.getAnimations().filter(animation =>
    animation.playState === "running" && animation.effect?.getComputedTiming().iterations === Infinity
  ).length);
  expect(repeating).toBeLessThanOrEqual(2);
  await page.goto("/dev/widget-gallery?motion=reduced");
  const faces = page.locator(".cc-orb-gallery [data-orb-state]");
  await expect(faces).toHaveCount(0);
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  test(`service icons have their own space at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/services?motion=reduced");
    const group = page.getByTestId("healthy-group-avalar");
    await group.getByRole("button").first().click();
    const rows = group.locator(".health-row");
    await expect(rows.first()).toBeVisible();
    for (const row of await rows.all()) {
      const gap = await row.evaluate(el => el.querySelector("h3")!.getBoundingClientRect().left
        - el.querySelector(".health-row__icon")!.getBoundingClientRect().right);
      expect(gap).toBeGreaterThanOrEqual(12);
    }
  });
}


for (const width of [1280, 720]) {
  test(`kettle reading is centered in the right half on both pages at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 1280 });
    const route = "/api/v1/overview/layout";
    for (const suffix of ["", "/portrait"]) {
      const data = await (await request.get(route + suffix)).json();
      const layout = data.layout ?? data;
      const coffee = layout.items.find((item: { widgetType: string }) => item.widgetType === "home.coffee-machine");
      layout.items = [{ ...coffee, instanceId: "fixture.kettle", widgetType: "home.kettle", sizeVariant: "standard",
        placement: { x: 0, y: 0, w: 5, h: 4 }, config: {} }];
      await page.route("**" + route + suffix, response => response.fulfill({ json: data }));
    }
    for (const path of ["home", "overview"]) {
      await page.goto(`/${path}?scenario=home-climate-healthy&motion=reduced`);
      const card = page.getByTestId("kettle-control");
      await expect(card).toBeVisible();
      const geometry = await card.evaluate(el => {
        const rect = el.getBoundingClientRect();
        const dial = el.querySelector(".cc-gauge")!.getBoundingClientRect();
        const buttons = Array.from(el.querySelectorAll(".kettle-control__actions button"), b => b.getBoundingClientRect());
        return { size: dial.width, value: parseFloat(getComputedStyle(el.querySelector(".cc-gauge-center")!).fontSize),
          center: (dial.left + dial.width / 2 - rect.left) / rect.width,
          controlsFit: buttons.every(b => b.height >= 48 && b.width >= 48 && b.left >= rect.left && b.right <= rect.right && b.bottom <= rect.bottom + 1),
          clipped: el.scrollHeight > el.clientHeight + 1 || dial.top < rect.top || dial.bottom > rect.bottom };
      });
      expect(geometry.size).toBeCloseTo(128, 1);
      expect(geometry.value).toBe(40);
      expect(geometry.center).toBeGreaterThan(.70);
      expect(geometry.center).toBeLessThan(.78);
      expect(geometry.controlsFit).toBe(true);
      expect(geometry.clipped).toBe(false);
    }
  });

  test(`home kettle fits its contents when off or heating at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 1280 });
    const snapshot = await (await request.get("/api/v1/snapshot?scenario=ha-healthy")).json();
    const kettle = snapshot.services.find((s: { data: Record<string, unknown> }) => "availableTeaModes" in s.data);
    await page.route("**/api/v1/snapshot?*", route => route.fulfill({ json: snapshot }));
    for (const stage of ["off", "on"]) {
      kettle.data.stage = stage;
      await page.goto("/home?motion=reduced");
      const card = page.getByTestId("kettle-control");
      await expect(card).toHaveAttribute("data-instrument-active", String(stage === "on"));
      const bounds = await card.evaluate(el => {
        const actions = el.querySelector(".kettle-control__actions")!;
        const rect = el.getBoundingClientRect();
        return { unused: rect.bottom - actions.getBoundingClientRect().bottom,
          height: rect.height, gauge: el.querySelector(".cc-gauge")!.getBoundingClientRect().height };
      });
      expect(bounds.unused).toBeLessThanOrEqual(20);
      expect(bounds.height).toBeLessThan(245);
      expect(bounds.gauge).toBeGreaterThan(40);
    }
  });
}

for (const width of [1280, 720]) {
  test(`climate controls have equal visible gaps on both pages at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 1280 });
    for (const variant of ["home", "overview"]) {
      await page.goto(`/${variant}?scenario=home-climate-healthy&motion=reduced`);
      const card = page.locator(`.climate-control--${variant}`).first();
      const geometry = await card.evaluate(element => {
        const power = element.querySelector(".climate-control__power")!.getBoundingClientRect();
        const [minus, plus] = Array.from(element.querySelectorAll(".climate-control__stepper"), el => el.getBoundingClientRect());
        const confirm = element.querySelector(".climate-control__confirm")!.getBoundingClientRect();
        const svg = element.querySelector<SVGSVGElement>(".climate-control__target-value svg")!;
        const face = svg.querySelector("circle")!;
        const rect = svg.getBoundingClientRect();
        const diameter = (2 * face.r.baseVal.value + Number(face.getAttribute("stroke-width"))) * rect.width / svg.viewBox.baseVal.width;
        const left = rect.left + (rect.width - diameter) / 2;
        const buttons = [power, minus, plus, confirm];
        return {
          gaps: [minus.left - power.right, left - minus.right, plus.left - left - diameter, confirm.left - plus.right],
          centers: buttons.map(button => button.top + button.height / 2 - (rect.top + rect.height / 2)),
          smallestTarget: Math.min(...buttons.flatMap(button => [button.width, button.height]))
        };
      });
      for (const gap of geometry.gaps) expect(gap).toBeCloseTo(8, 0);
      for (const dy of geometry.centers) expect(Math.abs(dy)).toBeLessThan(1);
      expect(geometry.smallestTarget).toBeGreaterThanOrEqual(48);
      if (variant === "home") {
        const filters = await card.locator(".climate-control__select-label button").evaluateAll(buttons =>
          buttons.map(button => {
            const field = button.getBoundingClientRect();
            const row = button.closest(".climate-control__controls")!.getBoundingClientRect();
            return { width: field.width, rowWidth: row.width, height: field.height };
          }));
        expect(filters).toHaveLength(2);
        for (const filter of filters) {
          expect(filter.width).toBeLessThan(filter.rowWidth * .9);
          expect(filter.height).toBeGreaterThanOrEqual(48);
        }
      }
    }
  });
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  test(`settings cards have equal gaps and panel actions are centered at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/settings?motion=reduced");
    const gaps = await page.getByTestId("route-settings").evaluate(root => {
      const box = (selector: string) => root.querySelector(selector)!.getBoundingClientRect();
      const appearance = box(".settings-v2-appearance");
      const sound = box(".settings-system-controls");
      return [sound.top - appearance.bottom, box(".settings-v2-summary-grid").top - sound.bottom];
    });
    expect(gaps[0]).toBeGreaterThanOrEqual(12);
    expect(gaps[1]).toBeCloseTo(gaps[0], 0);

    await page.goto("/system?motion=reduced");
    const offsets = await page.getByTestId("system-runtime-zone").evaluate(zone => {
      const frame = zone.getBoundingClientRect();
      const heading = document.createRange();
      heading.selectNodeContents(zone.querySelector("h2")!);
      const title = heading.getBoundingClientRect();
      const buttons = Array.from(zone.querySelectorAll("button"), button => button.getBoundingClientRect());
      const left = Math.min(...buttons.map(box => box.left)), right = Math.max(...buttons.map(box => box.right));
      const bottom = Math.max(...buttons.map(box => box.bottom));
      return {
        title: title.left + title.width / 2 - (frame.left + frame.width / 2),
        actions: (left + right - frame.left - frame.right) / 2,
        vertical: (title.top + bottom - frame.top - frame.bottom) / 2,
        buttonsFit: buttons.every(box => box.width >= 48 && box.height >= 48 && box.bottom <= frame.bottom)
      };
    });
    expect(Math.abs(offsets.title)).toBeLessThan(2);
    expect(Math.abs(offsets.actions)).toBeLessThan(2);
    expect(Math.abs(offsets.vertical)).toBeLessThan(4);
    expect(offsets.buttonsFit).toBe(true);
  });

  test(`only the tea wheel scrolls at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const action = "home.kettle.set_tea_mode";
    await page.route("**/api/v1/actions/home-assistant/availability", route => route.fulfill({
      json: { schemaVersion: 1, actions: { [action]: { allowed: true, availability: "allowed" } } }
    }));
    const writes: string[] = [];
    page.on("request", request => {
      if (request.method() === "POST" && request.url().endsWith("/actions/home-assistant")) writes.push(request.url());
    });
    await page.goto("/home?scenario=home-climate-healthy&motion=full");
    const opener = page.getByRole("button", { name: "Выбрать чай" });
    const scrollContainer = await opener.evaluateHandle(el => {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (parent.scrollHeight > parent.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
      }
      return document.scrollingElement!;
    });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Выбрать чай" });
    await expect(dialog).toBeVisible();
    await expect(page.locator(".app")).toHaveAttribute("inert", "");
    const fixed = () => dialog.evaluate(el => ["h2", ".kettle-picker__actions"]
      .map(selector => Math.round(el.querySelector(selector)!.getBoundingClientRect().top)));
    const before = await fixed();
    const backgroundTop = await scrollContainer.evaluate(el => el.scrollTop);
    const wheel = dialog.getByRole("group", { name: "Виды чая" });
    await wheel.hover();
    await page.mouse.wheel(0, 210);
    await expect.poll(() => wheel.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
    await expect(wheel.locator("button[aria-pressed=true]")).toHaveCount(1);
    await page.keyboard.press("PageDown");
    expect(await fixed()).toEqual(before);
    expect(await scrollContainer.evaluate(el => el.scrollTop)).toBe(backgroundTop);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(writes).toEqual([]);
  });
}
