import { expect, test, type Locator } from "@playwright/test";
import type { StationPlayback } from "@artem/contracts";

test.skip(process.env.VITE_OVERVIEW_V2_ENABLED !== "true" || process.env.VITE_V2_VISUAL_SHELL !== "true",
  "Station widget uses the V2 Overview with either visual skin");

const coverPath = `/api/v1/station-playback/cover/${"a".repeat(64)}`;
const observedAt = "2026-11-23T19:44:00Z";
const fixtureCover = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgqFggAAI4ATmRi3bkAAAAAElFTkSuQmCC",
  "base64"
);

function gridBounds(item: Locator) {
  return item.evaluate(el => {
    const grid = el.closest(".overview-v2-grid")!.getBoundingClientRect();
    const { x, y, width, height } = el.getBoundingClientRect();
    return [x - grid.x, y - grid.y, width, height].map(value => Math.round(value * 10) / 10);
  });
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`Station playback without reload ${viewport.width}×${viewport.height} ${reducedMotion}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion });
      await page.addInitScript(() => {
        // Deliver deterministic frames to the same open page through the
        // app's normal EventSource listeners and snapshot GET path.
        class FixtureEventSource extends EventTarget {
          private readonly forward = (event: Event) => {
            const revision = (event as CustomEvent<number>).detail;
            this.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ revision }) }));
          };
          constructor() {
            super();
            document.addEventListener("fixture-snapshot", this.forward);
            queueMicrotask(() => this.dispatchEvent(new Event("connected")));
          }
          close() {
            document.removeEventListener("fixture-snapshot", this.forward);
          }
        }
        Object.defineProperty(window, "EventSource", { value: FixtureEventSource });
      });
      let playback: StationPlayback = { status: "idle", title: null, artist: null, coverPath: null, observedAt };
      let revision = 1;
      const brokenPath = `/api/v1/station-playback/cover/${"b".repeat(64)}`;
      await page.route("**/api/v1/snapshot?*", async route => {
        const upstream = await route.fetch();
        await route.fulfill({ response: upstream, json: { ...await upstream.json(), revision, stationPlayback: playback } });
      });
      await page.route("**/api/v1/station-playback/cover/*", route => route.fulfill(route.request().url().endsWith(brokenPath)
        ? { status: 404 }
        : { status: 200, contentType: "image/png", body: fixtureCover }));

      async function publish(next: StationPlayback) {
        playback = next;
        revision += 1;
        const response = page.waitForResponse(r => r.url().includes("/api/v1/snapshot?"));
        await page.evaluate(value => document.dispatchEvent(new CustomEvent("fixture-snapshot", { detail: value })), revision);
        await response;
      }

      await page.goto("/overview");
      const card = page.getByTestId("overview-station-mini-widget");
      const artwork = card.getByTestId("station-artwork-slot");
      const speaker = artwork.locator(".station-mini-widget__speaker");
      const neighbor = page.locator('[data-widget-type="system.health-summary"]').first();
      await expect(card.getByRole("button", { name: /Музыка/ })).toBeVisible();
      await expect(neighbor).toBeVisible();
      const bounds = await gridBounds(card);
      const neighborBounds = await gridBounds(neighbor);
      const centered = await speaker.boundingBox();
      expect(bounds && neighborBounds && centered).toBeTruthy();
      await speaker.evaluate(element => {
        const html = element as HTMLElement;
        html.dataset.transitions = "0";
        html.addEventListener("transitionrun", event => {
          if (event.target === html) html.dataset.transitions = String(Number(html.dataset.transitions) + 1);
        });
      });

      const track: StationPlayback = { status: "playing", title: "Тестовый трек с длинным названием",
        artist: "Тестовый исполнитель", coverPath, observedAt };
      await publish(track);
      await expect(card.getByTestId("station-current-track")).toBeVisible();
      await expect(card.getByText("Тестовый исполнитель")).toBeVisible();
      const transitions = reducedMotion === "reduce" ? "0" : "1";
      await expect(speaker).toHaveAttribute("data-transitions", transitions);
      await expect.poll(async () => (await speaker.boundingBox())!.x).toBeLessThan(centered!.x - 10);
      await card.screenshot({ path: testInfo.outputPath("station-playing.png"), animations: "disabled" });

      await publish({ ...track, observedAt: "2026-11-23T19:44:02Z" });
      await expect(card.getByText(track.title!)).toBeVisible();
      await expect(speaker).toHaveAttribute("data-transitions", transitions);
      const nextTrack = { ...track, title: "Следующая композиция", coverPath: brokenPath };
      await publish(nextTrack);
      await expect(card.getByText(nextTrack.title)).toBeVisible();
      await expect(speaker).toHaveAttribute("data-transitions", transitions);

      await publish({ ...nextTrack, status: "paused", artist: null });
      await expect(card.getByText("Пауза", { exact: true })).toBeVisible();
      await expect(card.locator(".station-mini-widget__cover")).toHaveText("♪");
      await expect(card.getByText("Тестовый исполнитель")).toHaveCount(0);
      expect(await gridBounds(card)).toEqual(bounds);
      expect(await gridBounds(neighbor)).toEqual(neighborBounds);

      await publish({ status: "idle", title: null, artist: null, coverPath: null, observedAt });
      await expect(card.getByTestId("station-current-track")).toHaveCount(0);
      await expect.poll(async () => Math.abs((await speaker.boundingBox())!.x - centered!.x)).toBeLessThan(.5);

      await publish(track);
      await expect(card.getByText(track.title!)).toBeVisible();
      await publish({ status: "stale", title: null, artist: null, coverPath: null, observedAt });
      await expect(card.getByText("Нет связи с колонкой")).toBeVisible();
      await expect(card.getByTestId("station-current-track")).toHaveCount(0);
      await expect.poll(async () => Math.abs((await speaker.boundingBox())!.x - centered!.x)).toBeLessThan(.5);
      expect(await gridBounds(card)).toEqual(bounds);
      expect(await gridBounds(neighbor)).toEqual(neighborBounds);
    });
  }
}

test("settings summarizes only observed track evictions", async ({ page }) => {
  await page.route("**/api/v1/snapshot?*", async route => {
    const upstream = await route.fetch();
    await route.fulfill({ response: upstream, json: { ...await upstream.json(), stationRetention: {
      activeSince: observedAt,
      samples: [
        { startedAt: observedAt, endedAt: observedAt, seconds: 60, outcome: "cleared" },
        { startedAt: observedAt, endedAt: observedAt, seconds: 120, outcome: "cleared" },
        { startedAt: observedAt, endedAt: observedAt, seconds: 9000, outcome: "signal_lost" }
      ]
    } } });
  });
  await page.goto("/settings");
  const stats = page.getByTestId("station-retention-settings");
  await stats.locator("summary").click();
  await expect(stats.getByText(/Текущий замер начат/)).toBeVisible();
  await expect(stats.getByText("Замеров: 2. Минимум 1 мин 0 с, медиана 1 мин 30 с, максимум 2 мин 0 с.")).toBeVisible();
  await expect(stats.getByText(/Потеряна связь/)).toBeVisible();
});
