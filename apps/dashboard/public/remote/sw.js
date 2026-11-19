const version = new URL(self.location.href).searchParams.get("v") || "dev";
const name = "control-center-tv-" + version;
const shell = "/remote/";

function isShell(request, origin) {
  const path = new URL(request.url);
  return request.method === "GET" && path.origin === origin &&
    (path.pathname.startsWith("/remote/") || path.pathname.startsWith("/assets/")) &&
    !path.pathname.startsWith("/remote/api/");
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(name);
    const response = await fetch(shell, { cache: "reload" });
    if (!response.ok) throw new Error("TV shell unavailable");
    const html = await response.clone().text();
    const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]))];
    await cache.addAll([...assets, "/remote/manifest.webmanifest", "/remote/icon-192.png", "/remote/icon-512.png"]);
    await cache.put(shell, response);
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const existing of await caches.keys())
      if (existing.startsWith("control-center-tv-") && existing !== name) await caches.delete(existing);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!isShell(request, self.location.origin)) return;
  event.respondWith(fetch(request).catch(async () => {
    const cache = await caches.open(name);
    return (await cache.match(request.mode === "navigate" ? shell : request)) || Response.error();
  }));
});
