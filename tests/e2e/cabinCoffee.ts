import type { Page } from "@playwright/test";
import type { DashboardSnapshot, OverviewLayoutItem } from "@artem/contracts";

type Phase = "off" | "turning_on" | "warming" | "ready" | "turning_off";

/** Drive the normal snapshot refresh on fixtures, without submitting a device action. */
export async function observeCoffeeCycle(page: Page, base: string, custom: boolean) {
  const states = new Map<Phase, DashboardSnapshot>();
  for (const name of ["off", "warming", "ready"] as const) {
    const response = await page.request.get(base + "/api/v1/snapshot?scenario=coffee-" + name);
    const snapshot: DashboardSnapshot = await response.json();
    if (snapshot.mode !== "fixtures") throw new Error("Coffee motion review requires fixtures");
    states.set(name, snapshot);
  }
  for (const name of ["turning_on", "turning_off"] as const) {
    const snapshot = structuredClone(states.get("off")!);
    const machine = snapshot.services.find(service => service.id === "coffee-machine")!.data.machine as { state: string };
    machine.state = name;
    states.set(name, snapshot);
  }
  let phase: Phase = "off";
  await page.route("**/api/v1/snapshot?*", route => route.fulfill({ json: states.get(phase) }));
  for (const path of ["/api/v1/overview/layout", "/api/v1/overview/layout/portrait"]) {
    const response = await page.request.get(base + path);
    const body = await response.json();
    const layout = body.layout ?? body;
    const coffee = layout.items.find((item: OverviewLayoutItem) => item.widgetType === "home.coffee-machine");
    if (!coffee) throw new Error("Missing coffee fixture tile");
    coffee.config = { ...coffee.config, showImage: true, imageXStep: custom ? 1 : 0, imageYStep: custom ? -1 : 0,
      imageScalePct: custom ? 120 : 100, stateOffXOffsetPx: -18, stateWarmingXOffsetPx: 10, stateReadyXOffsetPx: -8 };
    await page.route("**" + path, route => route.fulfill({ json: body }));
  }
  await page.addInitScript(() => {
    // The UI receives the same invalidation that its normal SSE provider sends.
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        if (String(url).endsWith("/api/v1/events")) {
          window.addEventListener("cabin-test-refresh", () => this.dispatchEvent(new MessageEvent("snapshot", { data: "{}" })));
        }
      }
    };
  });
  await page.goto(base + "/overview?scenario=coffee-off&motion=full");
  const tile = page.locator(".coffee-panel--overview").first();
  await tile.locator(".cc-coffee-motion img").waitFor();
  await page.waitForFunction(scale => document.querySelector(".coffee-panel--overview")?.getAttribute("data-image-scale") === scale, custom ? "120" : "100");
  if (await tile.getAttribute("data-image-scale") !== (custom ? "120" : "100")) throw new Error("Saved zoom was not restored");
  const alpha = await tile.locator("img").first().evaluate(async img => {
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let left = c.width, right = 0, top = c.height, bottom = 0;
    let weight = 0, horizontalMoment = 0, verticalMoment = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const opacity = data[4 * (y * c.width + x) + 3];
      if (opacity <= 28) continue;
      weight += opacity;
      horizontalMoment += (x + .5) * opacity;
      verticalMoment += (y + .5) * opacity;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    return {
      x: ((left + right + 1) / 2 + horizontalMoment / weight) / (2 * c.width),
      y: ((top + bottom + 1) / 2 + verticalMoment / weight) / (2 * c.height),
      left: left / c.width, right: (right + 1) / c.width, foot: (bottom + 1) / c.height
    };
  });
  const readings = [];
  for (const next of ["turning_on", "warming", "ready", "turning_off", "off"] as const) {
    phase = next;
    const values = await tile.evaluate(async (element, { next, alpha }) => {
      const frame = element.querySelector(".coffee-asset")!;
      const motion = element.querySelector<HTMLElement>(".cc-coffee-motion")!;
      const picture = motion.querySelector("img")!;
      const dial = frame.querySelector(".cc-gauge")!;
      const frames: { x: number; y: number; scale: number; rimClearance: number; footOverlap: number }[] = [];
      window.dispatchEvent(new Event("cabin-test-refresh"));
      const start = performance.now();
      let arrived = 0;
      while (!arrived || performance.now() - arrived < 425) {
        await new Promise(requestAnimationFrame);
        if (performance.now() - start > 5000) throw new Error("Fixture phase did not arrive: " + next);
        if (!arrived && motion.getAttribute("data-phase") === next) arrived = performance.now();
        const f = frame.getBoundingClientRect(), p = picture.getBoundingClientRect();
        const ring = dial.getBoundingClientRect(), assembly = motion.getBoundingClientRect();
        const platform = getComputedStyle(motion, "::before");
        const renderScale = assembly.height / motion.offsetHeight;
        const platterCenter = assembly.top + parseFloat(platform.top) * renderScale;
        const platterRadius = parseFloat(platform.height) * renderScale / 2;
        const footOverlap = platterRadius - Math.abs(p.top + p.height * alpha.foot - platterCenter);
        frames.push({ x: p.left + p.width * alpha.x - f.left - f.width/2,
          y: p.top + p.height * alpha.y - f.top - f.height/2,
          scale: new DOMMatrix(getComputedStyle(motion).transform).a,
          rimClearance: Math.min(p.left + p.width * alpha.left - ring.left, ring.right - (p.left + p.width * alpha.right)),
          footOverlap });
      }
      return { phase: next, frames: frames.length,
        rimClearance: Math.min(...frames.map(v => v.rimClearance)),
        footOverlap: Math.min(...frames.map(v => v.footOverlap)), firstScale: frames[0].scale, lastScale: frames.at(-1)!.scale,
        minX: Math.min(...frames.map(v => v.x)), maxX: Math.max(...frames.map(v => v.x)),
        minY: Math.min(...frames.map(v => v.y)), maxY: Math.max(...frames.map(v => v.y)),
        scales: new Set(frames.map(v => v.scale.toFixed(4))).size };
    }, { next, alpha });
    readings.push(values);
  }
  return readings;
}
