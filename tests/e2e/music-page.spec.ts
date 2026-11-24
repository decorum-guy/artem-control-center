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

const playlist = (key: string, title = key) => ({ key, title, kind: "playlist", cover: null, count: null });

test("refreshing the catalogue retains renamed selections and rejects an old continuation", async ({ page }) => {
  let edition = 0;
  let continuing = false;
  let finishOld!: () => void;
  const old = new Promise<void>(resolve => { finishOld = resolve; });
  await page.route("**/api/v1/music/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.split("/music/")[1];
    if (path.endsWith("/status")) return route.fulfill({ json: status });
    if (path.startsWith("yandex/")) return route.fulfill({ json: samplePage([]) });
    if (path === "youtube/catalog") {
      if (url.searchParams.has("cursor")) {
        continuing = true;
        await old;
        return route.fulfill({ json: samplePage([playlist("late")]) }).catch(() => {});
      }
      if (!url.searchParams.has("refresh")) return route.fulfill({ json: samplePage([playlist("A")], "previous") });
      edition++;
      if (edition === 2) return route.fulfill({ status: 503, json: { detail: "source_unavailable" } });
      return route.fulfill({ json: samplePage(edition === 1 ? [playlist("A", "Новое имя"), playlist("B")] : [playlist("B")]) });
    }
    return route.fulfill({ json: samplePage([row(100)]) });
  });
  await page.goto("/music");
  const yt = page.getByRole("region", { name: "YouTube Music", exact: true });
  const list = yt.getByRole("region", { name: "Треки · YouTube Music" });
  await yt.getByRole("button", { name: "A", exact: true }).click();
  await expect(list.getByText("Трек 100")).toBeVisible();
  const refresh = yt.getByRole("button", { name: "Обновить плейлисты · YouTube Music" });
  await yt.getByRole("button", { name: "Ещё плейлисты" }).click();
  await expect.poll(() => continuing).toBe(true);
  await refresh.click();
  await expect(yt.getByRole("button", { name: "Новое имя", exact: true })).toHaveAttribute("aria-pressed", "true");
  finishOld();
  await expect(yt.getByRole("button", { name: "late", exact: true })).toHaveCount(0);
  await expect(yt.getByRole("button", { name: "B", exact: true })).toBeVisible();
  await refresh.click();
  await expect(yt.getByRole("status")).toContainText("Показан предыдущий каталог");
  await expect(yt.getByRole("button", { name: "Новое имя", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByText("Трек 100")).toBeVisible();
  await refresh.click();
  await expect(yt.getByRole("status")).toContainText("Плейлист больше недоступен");
  await expect(list.getByText("Трек 100")).toHaveCount(0);
});

test("a playlist recovers its filtered position and second page after data eviction", async ({ page }) => {
  let readsForA = 0;
  await page.route("**/api/v1/music/**", async route => {
    const { pathname, searchParams } = new URL(route.request().url());
    const path = pathname.split("/music/")[1];
    if (path.endsWith("/status")) return route.fulfill({ json: status });
    if (path.startsWith("yandex/")) return route.fulfill({ json: samplePage([]) });
    if (path === "youtube/catalog") return route.fulfill({ json: samplePage([..."ABCDEF"].map(key => playlist(key))) });
    if (path !== "youtube/tracks/A") return route.fulfill({ json: samplePage([row(9999)]) });
    readsForA++;
    const more = searchParams.has("cursor");
    return route.fulfill({
      json: samplePage(Array.from({ length: 100 }, (_, index) => row(index + (more ? 101 : 1))), more ? null : "second")
    });
  });

  await page.goto("/music");
  const yt = page.getByRole("region", { name: "YouTube Music", exact: true });
  const list = yt.getByRole("region", { name: "Треки · YouTube Music" });
  const search = yt.getByRole("searchbox");
  const select = (key: string) => yt.getByRole("button", { name: key, exact: true }).click();
  await select("A");
  await yt.getByRole("button", { name: "Загрузить ещё" }).click();
  await expect(yt.getByText("Загружено: 200")).toBeVisible();
  await search.fill("Исполнитель");
  await list.evaluate(node => { node.scrollTop = 6464; });
  await expect(list.getByText("Трек 102", { exact: true })).toBeVisible();
  for (const key of "BCD") {
    await select(key);
    await expect(list.getByText("Трек 9999")).toBeVisible();
  }
  await select("A");
  await expect(search).toHaveValue("Исполнитель");
  expect(readsForA).toBe(2);
  for (const key of "EF") {
    await select(key);
    await expect(list.getByText("Трек 9999")).toBeVisible();
  }
  await select("A");
  await expect(search).toHaveValue("Исполнитель");
  await expect(list.getByText("Трек 102", { exact: true })).toBeVisible();
  await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(6464);
  expect(await list.getByRole("listitem").count()).toBeLessThan(26);
  for (const key of "BCDE") {
    await select(key);
    await expect(list.getByText("Трек 9999")).toBeVisible();
  }
  await select("A");
  await expect(search).toHaveValue("Исполнитель");
  await expect(list.getByText("Трек 102", { exact: true })).toBeVisible();
  await expect.poll(() => readsForA).toBe(4);
});

test("YouTube session rotation keeps the filtered second page and a different channel clears it", async ({ page }) => {
  let sessionRevision = 1;
  let viewIdentity = "first-channel";
  let activeGeneration = generation;
  let resultStatus = "ready";
  const plays: Array<{ row: string }> = [];
  await page.route("**/api/v1/music/**", async route => {
    const { pathname, searchParams } = new URL(route.request().url());
    const path = pathname.split("/music/")[1];
    if (path === "youtube/status") {
      return route.fulfill({ json: { ...status, generation: activeGeneration, status: resultStatus, viewIdentity, sessionRevision } });
    }
    if (path === "youtube/catalog") {
      return route.fulfill({ json: { ...samplePage([playlist("A")]), generation: activeGeneration, sessionRevision } });
    }
    if (path === "youtube/play") {
      plays.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: "playing" } });
    }
    if (path === "youtube/tracks/A") {
      const more = searchParams.has("cursor");
      const records = Array.from({ length: 100 }, (_, index) => row(index + (more ? 101 : 1)))
        .map(record => ({ ...record, key: sessionRevision + ":" + record.key }));
      return route.fulfill({ json: { ...samplePage(records, more ? null : "next"), generation: activeGeneration, sessionRevision } });
    }
    return route.fulfill({ json: path.endsWith("/status") ? status : samplePage([]) });
  });

  await page.goto("/music");
  const yt = page.getByRole("region", { name: "YouTube Music", exact: true });
  const list = yt.getByRole("region", { name: "Треки · YouTube Music" });
  const search = yt.getByRole("searchbox");
  await yt.getByRole("button", { name: "A", exact: true }).click();
  await yt.getByRole("button", { name: "Загрузить ещё" }).click();
  await expect(yt.getByText("Загружено: 200")).toBeVisible();
  await search.fill("Исполнитель");
  await list.evaluate(node => { node.scrollTop = 6464; });
  await expect(list.getByText("Трек 102", { exact: true })).toBeVisible();

  const wake = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  resultStatus = "auth_required";
  await wake();
  await expect(yt.getByText("Трек 102", { exact: true })).toBeVisible();
  sessionRevision = 2;
  resultStatus = "connecting";
  const loaded = page.waitForResponse(r => r.url().includes("/tracks/A?cursor=next"));
  await wake();
  await loaded;
  await expect(search).toHaveValue("Исполнитель");
  await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(6464);
  await list.getByRole("listitem").filter({ hasText: /^Трек 102/ }).getByRole("button").click();
  await expect.poll(() => plays[0]?.row.startsWith("2:")).toBe(true);

  activeGeneration = "d".repeat(32);
  sessionRevision = 0;
  resultStatus = "connecting";
  const restarted = page.waitForResponse(r => r.url().includes("/tracks/A?cursor=next"));
  await wake();
  await restarted;
  await expect(search).toHaveValue("Исполнитель");
  await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(6464);

  activeGeneration = "e".repeat(32);
  viewIdentity = "other-channel";
  resultStatus = "ready";
  await wake();
  await expect(search).toBeDisabled();
  await yt.getByRole("button", { name: "A", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(0);
});

for (const dimensions of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  test(`YouTube restores a playlist beyond the first catalogue page at ${dimensions.width}px`, async ({ page }) => {
    await page.setViewportSize(dimensions);
    const catalogue = Array.from({ length: 41 }, (_, index) => playlist("P" + (index + 1)));
    let activeGeneration = generation;
    let mode: "ready" | "offline" | "deleted" = "ready";
    let playRequests = 0;
    const fullReads: string[] = [];
    await page.route("**/api/v1/music/**", async route => {
      const { pathname, searchParams } = new URL(route.request().url());
      const path = pathname.split("/music/")[1];
      const payload = (items: unknown[], next: string | null = null) => ({
        ...samplePage(items, next), generation: activeGeneration
      });
      if (path === "youtube/status") {
        return route.fulfill({ json: { ...status, generation: activeGeneration, viewIdentity: "same-channel" } });
      }
      if (path === "youtube/catalog") {
        if (searchParams.has("refresh")) {
          fullReads.push(activeGeneration);
          if (mode === "offline") return route.fulfill({ status: 503, json: { detail: "source_unavailable" } });
          return route.fulfill({ json: payload(mode === "deleted" ? catalogue.filter(row => row.key !== "P40") : catalogue) });
        }
        if (searchParams.has("cursor")) return route.fulfill({ json: payload(catalogue.slice(25)) });
        return route.fulfill({ json: payload(catalogue.slice(0, 25), "catalogue-next") });
      }
      if (path === "youtube/tracks/P40") {
        const more = searchParams.has("cursor");
        return route.fulfill({ json: payload(
          Array.from({ length: 100 }, (_, index) => row(index + (more ? 101 : 1))),
          more ? null : "tracks-next"
        ) });
      }
      if (path === "youtube/play") playRequests++;
      return route.fulfill({ json: path.endsWith("/status") ? status : samplePage([]) });
    });

    await page.goto("/music");
    const yt = page.getByRole("region", { name: "YouTube Music", exact: true });
    const tracks = yt.getByRole("region", { name: "Треки · YouTube Music" });
    const filter = yt.getByRole("searchbox");
    await yt.getByRole("button", { name: "Ещё плейлисты" }).click();
    await yt.getByRole("button", { name: "P40", exact: true }).click();
    await yt.getByRole("button", { name: "Загрузить ещё" }).click();
    await expect(yt.getByText("Загружено: 200")).toBeVisible();
    await filter.fill("Исполнитель");
    await tracks.evaluate(node => { node.scrollTop = 6400; });
    const scroll = () => tracks.evaluate(node => node.scrollTop);
    await expect.poll(scroll).toBe(6400);

    const wake = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    mode = "offline";
    activeGeneration = "d".repeat(32);
    const failed = page.waitForResponse(response => response.url().includes("youtube/catalog?refresh=true") && response.status() === 503);
    await wake();
    await failed;
    await expect(yt.locator(".music-library__notice")).toHaveText("Источник временно недоступен.");
    await expect(filter).toBeDisabled();
    expect(fullReads).toEqual([activeGeneration]);

    mode = "ready";
    await wake();
    await expect(yt.getByRole("button", { name: "P40", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(filter).toHaveValue("Исполнитель");
    await expect(yt.getByText("Загружено: 200")).toBeVisible();
    await expect.poll(scroll).toBe(6400);

    mode = "deleted";
    activeGeneration = "e".repeat(32);
    await wake();
    await expect(yt.getByText(/Плейлист больше недоступен/)).toBeVisible();
    await expect(filter).toBeDisabled();
    expect(playRequests).toBe(0);
  });
}

test("a confirmed YouTube recording stays highlighted across playlists and routes until Station changes", async ({ page }) => {
  await page.addInitScript(() => {
    class FixtureEvents extends EventTarget {
      private readonly forward = (event: Event) => {
        this.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ revision: (event as CustomEvent).detail }) }));
      };
      constructor() {
        super();
        document.addEventListener("music-snapshot", this.forward);
        queueMicrotask(() => this.dispatchEvent(new Event("connected")));
      }
      close() { document.removeEventListener("music-snapshot", this.forward); }
    }
    Object.defineProperty(window, "EventSource", { value: FixtureEvents });
  });
  const yandexGeneration = "a".repeat(32);
  let yandexAccount = yandexGeneration;
  let revision = 2;
  let stationTrack = "45";
  await page.route("**/api/v1/snapshot?*", async route => {
    const upstream = await route.fetch();
    await route.fulfill({ response: upstream, json: { ...await upstream.json(), revision,
      stationPlayback: { status: "playing", title: "Одна запись", artist: "Исполнитель",
        trackId: stationTrack, observedAt: now, coverPath: null } } });
  });
  await page.route("**/api/v1/music/**", async route => {
    const path = new URL(route.request().url()).pathname.split("/music/")[1];
    if (path.endsWith("/status")) return route.fulfill({ json: { ...status, yandexGeneration: yandexAccount } });
    if (path.startsWith("yandex/")) return route.fulfill({ json: samplePage([]) });
    if (path === "youtube/catalog") return route.fulfill({ json: samplePage([playlist("A"), playlist("B")]) });
    if (path === "youtube/play") return route.fulfill({ json: {
      status: "playing", stationTrackId: "45", yandexGeneration
    } });
    return route.fulfill({ json: samplePage([
      { ...row(path.endsWith("/A") ? 100 : 300), trackId: "AAAAAAAAAAA", title: "Та же запись" },
      { ...row(200), trackId: "BBBBBBBBBBB", title: "Та же запись" }
    ]) });
  });

  async function state(trackId: string) {
    stationTrack = trackId;
    const response = page.waitForResponse(r => r.url().includes("/api/v1/snapshot?"));
    await page.evaluate(value => document.dispatchEvent(new CustomEvent("music-snapshot", { detail: value })), ++revision);
    await response;
  }

  await page.goto("/music");
  const yt = page.getByRole("region", { name: "YouTube Music", exact: true });
  const playing = yt.locator(".music-track[data-playing=true]");
  await yt.getByRole("button", { name: "A", exact: true }).click();
  await yt.getByRole("button", { name: "Включить на Станции · Та же запись" }).first().click();
  await expect(playing).toHaveCount(1);
  await yt.getByRole("button", { name: "B", exact: true }).click();
  await expect(playing).toHaveCount(1);
  await page.locator('a[href="/overview"]').first().evaluate((link: HTMLAnchorElement) => link.click());
  await expect(page.getByTestId("route-music")).toHaveCount(0);
  await page.goBack();
  await expect(playing).toHaveCount(1);
  await state("46");
  await expect(playing).toHaveCount(0);
  await state("45");
  await expect(playing).toHaveCount(1);
  yandexAccount = "b".repeat(32);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(playing).toHaveCount(0);
});

for (const size of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  test(`Yandex Music switches playlists and plays the exact selected row at ${size.width}px`, async ({ page }) => {
    await page.setViewportSize(size);
    const reads: string[] = [];
    const played: unknown[] = [];
    const own = playlist("ya_12_4", "Мой плейлист");
    const liked = { ...playlist("ya_34_4", "Плейлист другого автора"), cover };
    await page.route("**/api/v1/music/**", async route => {
      const path = new URL(route.request().url()).pathname.split("/music/")[1];
      if (path.startsWith("artwork/")) return route.fulfill({ status: 404 });
      if (path.endsWith("/status")) return route.fulfill({ json: status });
      if (path === "youtube/catalog") return route.fulfill({ json: samplePage([]) });
      if (path === "yandex/catalog") {
        return route.fulfill({ json: samplePage([
          { ...playlist("likes", "Мне нравится"), kind: "liked" }, own, liked
        ]) });
      }
      if (path.includes("/tracks/")) {
        const source = path.split("/").at(-1)!;
        reads.push(source);
        return route.fulfill({ json: samplePage([row(source === "likes" ? 5 : source === own.key ? 12 : 34)]) });
      }
      played.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: "playing", stationTrackId: "34" } });
    });

    await page.goto("/music");
    const yandex = page.getByRole("region", { name: "Яндекс Музыка", exact: true });
    const tracks = yandex.getByRole("region", { name: "Треки · Яндекс Музыка" });
    await expect(tracks.getByText("Трек 5", { exact: true })).toBeVisible();
    expect(reads).toEqual(["likes"]);
    await yandex.getByRole("button", { name: own.title, exact: true }).click();
    await expect(tracks.getByText("Трек 12", { exact: true })).toBeVisible();
    await yandex.getByRole("button", { name: liked.title, exact: true }).click();
    await expect(tracks.getByText("Трек 34", { exact: true })).toBeVisible();
    await page.locator('a[href="/overview"]').first().evaluate(link => (link as HTMLElement).click());
    await expect(page.getByTestId("route-music")).toHaveCount(0);
    await page.goBack();
    await expect(yandex.getByRole("button", { name: liked.title, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(tracks.getByText("Трек 34", { exact: true })).toBeVisible();
    expect(played).toHaveLength(0);
    await tracks.getByRole("button", { name: "Включить на Станции · Трек 34", exact: true }).click();
    await expect(yandex.getByRole("status")).toContainText("Станция подтвердила воспроизведение");
    expect(played).toEqual([{ generation, source: liked.key, row: row(34).key }]);
  });
}
