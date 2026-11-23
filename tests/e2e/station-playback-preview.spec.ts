import { expect, test } from "@playwright/test";
import type { StationPlayback } from "@artem/contracts";

test.skip(process.env.VITE_OVERVIEW_V2_ENABLED !== "true" || process.env.VITE_V2_VISUAL_SHELL !== "true",
  "Station widget uses the V2 Overview with either visual skin");

const coverPath = `/api/v1/station-playback/cover/${"a".repeat(64)}`;
const observedAt = "2026-11-23T19:44:00Z";
const fixtureCover = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgqFggAAI4ATmRi3bkAAAAAElFTkSuQmCC",
  "base64"
);

for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  test(`Station artwork and playback preview ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    let playback: StationPlayback = { status: "idle", title: null, artist: null, coverPath: null, observedAt };
    let brokenCover = false;
    await page.route("**/api/v1/snapshot?*", async route => {
      const upstream = await route.fetch();
      await route.fulfill({ response: upstream, json: { ...await upstream.json(), stationPlayback: playback } });
    });
    await page.route("**/api/v1/station-playback/cover/*", route => route.fulfill(brokenCover
      ? { status: 404 }
      : { status: 200, contentType: "image/png", body: fixtureCover }));

    await page.goto("/overview");
    const card = page.getByTestId("overview-station-mini-widget");
    const artwork = page.getByTestId("station-artwork-slot");
    const speaker = artwork.locator(".station-mini-widget__speaker");
    const initial = await artwork.boundingBox();
    const centered = await speaker.boundingBox();
    expect(initial).toBeTruthy();
    expect(centered).toBeTruthy();
    await expect(card.getByRole("button", { name: /Музыка/ })).toBeVisible();

    playback = { status: "playing", title: "Тестовый трек с длинным названием для проверки обрезки",
      artist: "Тестовый исполнитель", coverPath, observedAt };
    await page.reload();
    await expect(page.getByTestId("station-current-track")).toBeVisible();
    expect(await speaker.evaluate(el => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThanOrEqual(0.001);
    expect((await speaker.boundingBox())!.x).toBeLessThan(centered!.x - 10);
    expect((await artwork.boundingBox())!.height).toBeCloseTo(initial!.height, 0);
    await expect(card.getByText("Тестовый исполнитель")).toBeVisible();
    await card.screenshot({ path: testInfo.outputPath("station-playing.png"), animations: "disabled" });

    playback = { ...playback, status: "paused", artist: null };
    brokenCover = true;
    await page.reload();
    await expect(card.getByText("Пауза", { exact: true })).toBeVisible();
    await expect(card.locator(".station-mini-widget__cover")).toHaveText("♪");
    await expect(card.getByText("Тестовый исполнитель")).toHaveCount(0);
    await card.screenshot({ path: testInfo.outputPath("station-paused.png"), animations: "disabled" });

    playback = { status: "stale", title: null, artist: null, coverPath: null, observedAt };
    await page.reload();
    await expect(card.getByText("Нет связи с колонкой")).toBeVisible();
    await expect(page.getByTestId("station-current-track")).toHaveCount(0);
    expect((await speaker.boundingBox())!.x).toBeCloseTo(centered!.x, 0);
  });
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
