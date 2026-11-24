import { expect, test } from "@playwright/test";

const generation = "c".repeat(32);
const now = "2026-11-24T07:25:00+03:00";
const cover = "/api/v1/music/artwork/" + "a".repeat(64);
const status = { generation, status: "ready", canPlay: true };
const row = (index: number) => ({
  key: String(index).padStart(32, "0"), trackId: String(index), title: "Трек " + index,
  artist: "Исполнитель", album: "Издание", duration: 181, cover: null, playable: true
});
const samplePage = (items: unknown[], next: string | null = null) => ({ generation, items, next, observedAt: now });

for (const size of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  test(`Music loads selected playlists and keeps an independent virtual view at ${size.width}px`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reads: string[] = [];
    const plays: Array<unknown> = [];
    await page.route("**/api/v1/music/**", async route => {
      const url = new URL(route.request().url());
      const [, provider, path, selection] = url.pathname.split("/music/")[1].match(/^([^/]+)\/([^/]+)(?:\/(.*))?$/) ?? [];
      if (provider === "artwork") return route.fulfill({ status: 404 });
      if (path === "status") return route.fulfill({ json: status });
      if (path === "catalog") return route.fulfill({ json: samplePage(provider === "yandex"
        ? [{ key: "likes", title: "Мне нравится", kind: "liked", cover: null, count: null }]
        : [{ key: "LM", title: "Понравившаяся музыка", kind: "liked", cover, count: null },
          { key: "PLtest", title: "Другой плейлист", kind: "playlist", cover: null, count: 2 }]) });
      if (path === "tracks") {
        reads.push(provider + "/" + selection + (url.searchParams.has("cursor") ? "/next" : ""));
        if (provider === "yandex") return route.fulfill({ json: samplePage([row(1)]) });
        if (selection === "PLtest") return route.fulfill({ json: samplePage([row(1001), row(1002)]) });
        if (url.searchParams.has("cursor")) return route.fulfill({ json: samplePage(Array.from({ length: 1000 }, (_, i) => row(i + 101))) });
        return route.fulfill({ json: samplePage(Array.from({ length: 100 }, (_, i) => row(i + 1)), "next-test") });
      }
      plays.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: "playing", stationTrackId: "101" } });
    });

    await page.goto("/music");
    await expect(page.getByTestId("route-music")).toBeVisible();
    const yt = page.getByRole("region", { name: "YouTube Music", exact: true });
    await expect(yt.getByRole("button", { name: "Понравившаяся музыка", exact: true })).toBeVisible();
    expect(reads.every(path => path.startsWith("yandex/"))).toBe(true);
    await yt.getByRole("button", { name: "Другой плейлист" }).click();
    await expect(yt.getByRole("button", { name: "Включить на Станции · Трек 1001" })).toBeVisible();
    await yt.getByRole("button", { name: "Понравившаяся музыка" }).click();
    await yt.getByRole("button", { name: "Загрузить ещё" }).click();
    await expect(yt.getByText("Загружено: 1100")).toBeVisible();
    expect(await yt.getByRole("listitem").count()).toBeLessThan(26);
    const list = yt.getByRole("region", { name: "Треки · YouTube Music", exact: true });
    await list.evaluate(node => { node.scrollTop = 6400; });
    const scroll = await list.evaluate(node => node.scrollTop);
    expect(scroll).toBeGreaterThan(5500);
    await expect(yt.getByRole("button", { name: "Включить на Станции · Трек 101", exact: true })).toBeVisible();
    expect(plays).toHaveLength(0);
    await yt.getByRole("button", { name: "Включить на Станции · Трек 101", exact: true }).click();
    await expect(yt.getByRole("status")).toContainText("Станция подтвердила воспроизведение");
    expect(plays).toEqual([{ generation, source: "LM", row: row(101).key }]);
    await page.evaluate(() => {
      const overview = document.querySelector<HTMLAnchorElement>('a[href="/overview"]');
      overview?.click();
    });
    await expect(page.getByTestId("route-music")).toHaveCount(0);
    await page.goBack();
    await expect(yt.getByRole("button", { name: "Понравившаяся музыка" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(scroll);
    expect(await page.locator("body").evaluate(node => node.scrollWidth)).toBeLessThanOrEqual(size.width);
  });
}

test("Music keeps the selected view on a late response and recovers a failed continuation", async ({ page }) => {
  const nextGeneration = "d".repeat(32);
  let currentGeneration = generation;
  let continued = 0;
  let earlierStarted = false;
  let releaseEarlier!: () => void;
  const earlier = new Promise<void>(resolve => { releaseEarlier = resolve; });
  await page.route("**/api/v1/music/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.split("/music/")[1];
    const pageData = (items: unknown[], next: string | null = null) => ({
      ...samplePage(items, next), generation: currentGeneration
    });
    if (path.endsWith("/status")) return route.fulfill({ json: { ...status, generation: currentGeneration } });
    if (path === "yandex/catalog") return route.fulfill({ json: pageData([]) });
    if (path === "youtube/catalog") return route.fulfill({ json: pageData(currentGeneration === generation ? [
      { key: "LM", title: "Понравившаяся музыка", kind: "liked", cover: null, count: null },
      { key: "PLtest", title: "Другой плейлист", kind: "playlist", cover: null, count: null }
    ] : [{ key: "LM", title: "Понравившаяся музыка", kind: "liked", cover: null, count: null }]) });
    if (path === "youtube/tracks/PLtest") {
      earlierStarted = true;
      await earlier;
      return route.fulfill({ json: pageData([row(333)]) }).catch(() => {});
    }
    if (url.searchParams.has("cursor")) {
      if (++continued === 1) return route.fulfill({ status: 503, json: { detail: "source_unavailable" } });
      return route.fulfill({ json: pageData([row(444)]) });
    }
    return route.fulfill({ json: pageData([row(currentGeneration === generation ? 100 : 555)], "next-test") });
  });

  await page.goto("/music");
  const yt = page.getByRole("region", { name: "YouTube Music", exact: true });
  const pane = yt.getByRole("region", { name: "Треки · YouTube Music" });
  await yt.getByRole("button", { name: "Другой плейлист" }).click();
  await expect.poll(() => earlierStarted).toBe(true);
  await yt.getByRole("button", { name: "Понравившаяся музыка" }).click();
  await expect(pane.getByText("Трек 100", { exact: true })).toBeVisible();
  releaseEarlier();
  await expect(pane.getByText("Трек 333", { exact: true })).toHaveCount(0);
  const geometry = () => pane.evaluate(node => {
    const box = node.getBoundingClientRect();
    const panel = node.closest(".music-library")!.getBoundingClientRect();
    return { y: box.top - panel.top, width: box.width, height: box.height };
  });
  const before = await geometry();
  const more = yt.getByRole("button", { name: "Загрузить ещё" });
  await more.click();
  await expect(yt.getByRole("status")).not.toHaveText("Список загружен частично");
  await expect(more).toBeEnabled();
  expect(await geometry()).toEqual(before);
  await expect(pane.getByText("Трек 100", { exact: true })).toBeVisible();
  await more.click();
  await expect(pane.getByText("Трек 444", { exact: true })).toBeVisible();
  expect(await geometry()).toEqual(before);

  currentGeneration = nextGeneration;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(yt.getByRole("button", { name: "Понравившаяся музыка" })).toHaveAttribute("aria-pressed", "false");
  await expect(pane.getByText("Трек 100", { exact: true })).toHaveCount(0);
  await yt.getByRole("button", { name: "Понравившаяся музыка" }).click();
  await expect(pane.getByText("Трек 555", { exact: true })).toBeVisible();
});
