import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const v2Enabled = process.env.VITE_V2_VISUAL_SHELL === "true";
type Snapshot = { services: Array<Record<string, any>>; [key: string]: any };
type SnapshotMutator = (snapshot: Snapshot) => Snapshot;

function runtimeService(health = "healthy") {
  return {
    id: "panel-runtime",
    title: "Panel Agent runtime",
    enabled: true,
    dataContract: "system.runtime.v1",
    health,
    source: "live",
    summary: health === "healthy" ? "Runtime reachable" : "Runtime requires attention",
    actions: [],
    data: { platform: "linux" },
    presentation: {
      category: "system",
      group: "System",
      overview: "aggregate",
      priority: 75,
      environment: "local",
      freshnessLabel: "проверено только что",
      incidents: health === "healthy" ? 0 : 1
    }
  };
}

function rogService(status: "online" | "offline" | "waking" | "sleeping" | "hibernating" | "unavailable") {
  return {
    id: "rog_g703gi",
    title: "ASUS ROG G703GI",
    enabled: true,
    dataContract: "system.rog-g703.v1",
    health: status === "online" ? "healthy" : status === "unavailable" ? "offline" : "degraded",
    source: status === "unavailable" ? "unavailable" : "live",
    summary: status === "online" ? "В сети" : status === "offline" ? "Не в сети" : "Состояние перехода",
    actions: [
      { id: "system.rog_g703.wake", title: "Включить", enabled: status === "offline", risk: "low" },
      { id: "system.rog_g703.sleep", title: "Сон", enabled: status === "online", risk: "medium" },
      { id: "system.rog_g703.hibernate", title: "Гибернация", enabled: status === "online", risk: "medium" }
    ],
    presentation: {
      category: "system",
      group: "System",
      overview: "none",
      priority: 85,
      environment: "LAN",
      freshnessLabel: "проверено только что",
      incidents: status === "online" ? 0 : 1
    },
    data: {
      targetId: "rog_g703gi",
      status,
      observedAt: "2026-08-14T12:00:00Z",
      lastTransitionAt: "2026-08-14T11:59:00Z",
      lastError: null
    }
  };
}

async function installSnapshotMock(page: Page, mutate: SnapshotMutator) {
  await page.route("**/api/v1/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = mutate(await response.json() as Snapshot);
    await route.fulfill({
      response,
      body: JSON.stringify(snapshot),
      headers: { ...response.headers(), "content-type": "application/json" }
    });
  });
}

function allHealthy(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    services: snapshot.services.map((service) => ({ ...service, health: "healthy" }))
  };
}

function setCoffeeState(snapshot: Snapshot, state: "off" | "stale" | "unavailable"): Snapshot {
  const health = state === "off" ? "healthy" : state;
  const summary = state === "off"
    ? "Выключена"
    : state === "stale"
      ? "Последнее состояние кофемашины устарело"
      : "Состояние кофемашины не подтверждено";
  return {
    ...snapshot,
    services: snapshot.services.map((service) => {
      if (service.id !== "coffee-machine") return service;
      const data = service.data as Record<string, any>;
      const machine = data.machine as Record<string, any>;
      return {
        ...service,
        health,
        summary,
        actions: (service.actions as Array<Record<string, any>>).map((action) => ({
          ...action,
          enabled: state === "off" && action.id === "home.coffee.turn_on"
        })),
        data: {
          ...data,
          machine: {
            ...machine,
            state,
            available: state !== "unavailable",
            stale: state !== "off",
            turnedOnAt: null
          }
        }
      };
    })
  };
}

function setKettleHealth(snapshot: Snapshot, health: "healthy" | "stale" | "offline", freshnessLabel: string): Snapshot {
  return {
    ...snapshot,
    services: snapshot.services.map((service) => service.id === "kettle"
      ? {
          ...service,
          health,
          presentation: { ...service.presentation, freshnessLabel }
        }
      : service)
  };
}

type RogLayout = {
  card: { top: number; bottom: number; left: number; right: number; width: number; height: number };
  header: { top: number; bottom: number; left: number; right: number };
  title: { top: number; bottom: number; left: number; right: number };
  status: { top: number; bottom: number; left: number; right: number };
  detail: { top: number; bottom: number; left: number; right: number };
  footer: { top: number; bottom: number; left: number; right: number };
  titleInPrimaryState: boolean;
  noInternalOverflow: boolean;
};

async function measureRogLayout(page: Page): Promise<RogLayout> {
  return page.getByTestId("system-rog-g703").evaluate((root) => {
    const rect = (element: Element | null) => {
      if (!element) throw new Error("ROG layout element is missing");
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
    };
    const title = root.querySelector<HTMLElement>("#system-rog-g703-title");
    const status = root.querySelector<HTMLElement>(".system-rog-detail__header .v2-status-text");
    const detail = root.querySelector<HTMLElement>(".system-rog-detail__state span");
    const identity = title?.closest(".system-rog-detail__identity");
    if (!title || !status || !detail || !identity) throw new Error("ROG title/state geometry is incomplete");
    return {
      card: rect(root),
      header: rect(root.querySelector(".system-rog-detail__header")),
      title: rect(title),
      status: rect(status),
      detail: rect(detail),
      footer: rect(root.querySelector(".system-rog-detail__footer")),
      titleInPrimaryState: Boolean(title.closest(".system-rog-detail__header")),
      noInternalOverflow: root.scrollHeight <= root.clientHeight && root.scrollWidth <= root.clientWidth
    };
  });
}

function assertRogLayout(layout: RogLayout): void {
  expect(layout.titleInPrimaryState).toBe(true);
  expect(layout.title.left).toBeGreaterThan(layout.header.left);
  expect(layout.title.top - layout.header.top).toBeGreaterThanOrEqual(0);
  expect(layout.title.top - layout.header.top).toBeLessThanOrEqual(8);
  expect(layout.detail.top - layout.status.bottom).toBeGreaterThanOrEqual(0);
  expect(layout.footer.top - layout.detail.bottom).toBeGreaterThanOrEqual(8);
  expect(layout.title.top).toBeGreaterThanOrEqual(layout.header.top);
  expect(layout.status.top).toBeGreaterThanOrEqual(layout.header.top);
  expect(layout.detail.top).toBeGreaterThanOrEqual(layout.status.bottom);
  expect(layout.footer.top).toBeGreaterThanOrEqual(layout.detail.bottom);
  expect(layout.noInternalOverflow).toBe(true);
}

function longRussianServices(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    services: snapshot.services.map((service) => service.id === "fixture-multi-action"
      ? {
          ...service,
          health: "degraded",
          title: "Сервис с очень длинным русским названием для проверки переноса",
          summary: "Подробное русское описание состояния сервиса должно переноситься в рабочей зоне без горизонтального переполнения"
        }
      : service)
  };
}

function addRog(snapshot: Snapshot, status: Parameters<typeof rogService>[0]): Snapshot {
  return { ...snapshot, services: [...snapshot.services.filter((service) => service.id !== "rog_g703gi"), rogService(status)] };
}

async function waitForRoute(page: Page, testId: string) {
  await expect(page.getByTestId(testId)).toBeVisible();
}

async function expectNoOverflow(page: Page) {
  const size = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(size.documentWidth).toBeLessThanOrEqual(size.viewportWidth + 1);
}

test.describe("Control Center V2 PR7 route density", () => {
  test.skip(!v2Enabled, "Run with VITE_V2_VISUAL_SHELL=true for the PR7 browser gate.");

  test("Home uses bounded sparse layouts, HA authority, and no future placeholder", async ({ page }) => {
    await page.goto("/home?scenario=home-coffee-kettle");
    await waitForRoute(page, "route-home-v2").catch(async () => waitForRoute(page, "route-home"));
    await expect(page.getByTestId("home-authority-line")).toContainText("Home Assistant");
    await expect(page.getByTestId("home-authority-line")).not.toContainText("WebSocket");
    await expect(page.getByTestId("home-authority-line")).not.toContainText("Источник дома");
    await expect(page.getByTestId("widget-coffee-machine")).toBeVisible();
    await expect(page.getByTestId("device-row-kettle")).toBeVisible();
    await expect(page.locator(".future-device")).toHaveCount(0);

    const coffeeGeometry = await page.locator(".coffee-panel--home-v2").evaluate((panel) => {
      const asset = panel.querySelector<HTMLElement>(".coffee-asset");
      const image = panel.querySelector<HTMLImageElement>(".coffee-asset__image");
      if (!asset || !image) return null;
      const rect = (element: Element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      };
      const assetRect = rect(asset);
      const imageRect = rect(image);
      const style = getComputedStyle(image);
      return {
        asset: assetRect,
        image: imageRect,
        objectFit: style.objectFit,
        naturalRatio: image.naturalWidth / image.naturalHeight
      };
    });
    expect(coffeeGeometry).not.toBeNull();
    expect(coffeeGeometry!.image.left).toBeGreaterThanOrEqual(coffeeGeometry!.asset.left - 1);
    expect(coffeeGeometry!.image.right).toBeLessThanOrEqual(coffeeGeometry!.asset.right + 1);
    expect(coffeeGeometry!.image.top).toBeGreaterThanOrEqual(coffeeGeometry!.asset.top - 1);
    expect(coffeeGeometry!.image.bottom).toBeLessThanOrEqual(coffeeGeometry!.asset.bottom + 1);
    expect(coffeeGeometry!.objectFit).toBe("contain");
    expect(coffeeGeometry!.naturalRatio).toBeCloseTo(1024 / 1536, 2);

    const coffee = await page.getByTestId("widget-coffee-machine").boundingBox();
    const kettle = await page.getByTestId("device-row-kettle").boundingBox();
    expect(coffee?.height).toBeGreaterThanOrEqual(180);
    expect(kettle?.height).toBeGreaterThanOrEqual(110);

    await page.goto("/home?scenario=home-coffee-only");
    await expect(page.getByTestId("widget-coffee-machine")).toBeVisible();
    await expect(page.getByTestId("device-row-kettle")).toHaveCount(0);
    await page.goto("/home?scenario=home-no-coffee");
    await expect(page.getByTestId("widget-coffee-machine")).toHaveCount(0);
    await expect(page.getByTestId("device-row-kettle")).toBeVisible();
    await page.goto("/home?scenario=home-no-devices");
    await expect(page.getByTestId("home-no-devices")).toBeVisible();
    await expect(page.locator(".future-device")).toHaveCount(0);
  });

  test("Home hides healthy device transport copy but keeps degraded device warnings", async ({ page }) => {
    await installSnapshotMock(page, (snapshot) => setKettleHealth(snapshot, "healthy", "WebSocket подключен"));
    await page.goto("/home?scenario=home-coffee-kettle");
    const kettle = page.getByTestId("device-row-kettle");
    await expect(kettle).toContainText("Выключен");
    await expect(kettle).toContainText("В норме");
    await expect(kettle).not.toContainText("WebSocket");
    await expect(page.getByTestId("home-authority-line")).toContainText("Home Assistant");

    await page.unroute("**/api/v1/snapshot**");
    await installSnapshotMock(page, (snapshot) => setKettleHealth(snapshot, "stale", "Данные устарели"));
    await page.goto("/home?scenario=home-coffee-kettle");
    await expect(page.getByTestId("device-row-kettle")).toContainText("Данные устарели");

    await page.unroute("**/api/v1/snapshot**");
    await installSnapshotMock(page, (snapshot) => setKettleHealth(snapshot, "offline", "Последнее состояние недоступно"));
    await page.goto("/home?scenario=home-coffee-kettle");
    await expect(page.getByTestId("device-row-kettle")).toContainText("Недоступен");
    await expect(page.getByTestId("device-row-kettle")).toContainText("Последнее состояние недоступно");
  });

  test("Home HA stale/offline states remain truthful and Coffee keeps its existing action path", async ({ page }) => {
    await page.goto("/home?scenario=home-ha-stale");
    const authorityLine = page.getByTestId("home-authority-line");
    await expect(authorityLine).toContainText("Данные устарели");
    await expect(authorityLine).toContainText("40 мин назад");
    await expect(authorityLine).not.toContainText("только что");
    await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", "stale");
    await expect(page.getByTestId("widget-coffee-machine").getByRole("button")).toBeDisabled();

    await page.goto("/home?scenario=home-ha-offline");
    await expect(authorityLine).toContainText("Недоступен");
    await expect(authorityLine).toContainText("последнее подтверждение недоступно");
    await expect(authorityLine).not.toContainText("только что");
    await expect(page.getByTestId("widget-coffee-machine")).toHaveAttribute("data-stage", "unavailable");
    await expect(page.getByTestId("widget-coffee-machine").getByRole("button")).toBeDisabled();

    await page.goto("/home?scenario=coffee-off");
    const coffeeAction = page.getByTestId("widget-coffee-machine").getByRole("button", { name: "Включить" });
    await expect(coffeeAction).toBeEnabled();
    await coffeeAction.click();
    await expect(page.getByTestId("action-confirmation")).toBeVisible();
    await page.getByTestId("action-confirmation").getByRole("button", { name: "Включить кофемашину" }).click();
    await expect(page.getByTestId("global-notice")).toContainText("Кофемашина включена.");
  });

  test("Services puts attention first, keeps healthy groups collapsed, and uses a safe details Sheet", async ({ page }) => {
    await installSnapshotMock(page, allHealthy);
    await page.goto("/services");
    await waitForRoute(page, "route-services-v2");
    await expect(page.getByTestId("services-attention-summary")).toContainText("Всё в норме");
    await expect(page.getByTestId("services-all-healthy")).toBeVisible();
    const healthyGroup = page.getByTestId("healthy-group-home-infrastructure");
    const groupSummary = healthyGroup.locator(".collapsible-group__summary");
    await expect(groupSummary).toHaveAttribute("aria-expanded", "false");
    await groupSummary.click();
    await expect(groupSummary).toHaveAttribute("aria-expanded", "true");

    await page.unroute("**/api/v1/snapshot**");
    await installSnapshotMock(page, (snapshot) => ({
      ...snapshot,
      services: snapshot.services.map((service) => service.id === "fixture-multi-action"
        ? { ...service, health: "offline", summary: "Сервис не отвечает" }
        : service)
    }));
    await page.goto("/services");
    await expect(page.getByTestId("services-attention-summary")).toContainText("Требуют внимания · 1");
    await expect(page.locator(".health-row").first()).toContainText("Недоступен");
    await page.getByTestId("health-row-fixture-multi-action").getByRole("button", { name: /Подробнее/ }).click();
    await expect(page.getByTestId("service-details-sheet")).toBeVisible();
    await expect(page.getByTestId("service-details-sheet")).toContainText("Сервис не отвечает");
    await expect(page.getByTestId("service-details-sheet").getByRole("button", { name: "Restart simulation" })).toHaveCount(0);
  });

  test("Services keep unknown services in a trusted fallback group", async ({ page }) => {
    await installSnapshotMock(page, (snapshot) => ({
      ...allHealthy(snapshot),
      services: [...allHealthy(snapshot).services, {
        id: "unknown-service",
        title: "Неизвестный сервис",
        enabled: true,
        dataContract: "future.service.v1",
        health: "healthy",
        source: "fixture",
        summary: "Новый контракт без presentation metadata",
        actions: [],
        data: {}
      }]
    }));
    await page.goto("/services");
    const systemGroup = page.getByTestId("healthy-group-system");
    await systemGroup.getByRole("button").click();
    await expect(systemGroup).toContainText("Неизвестный сервис");
  });

  test("System stays diagnostics-first and preserves ROG contextual states", async ({ page }) => {
    await installSnapshotMock(page, (snapshot) => addRog(snapshot, "online"));
    await page.goto("/system");
    await waitForRoute(page, "route-system");
    await expect(page.getByTestId("system-aggregate-strip")).toContainText("Требуют внимания");
    await expect(page.getByTestId("system-diagnostic-fixture-multi-action")).toContainText("Multi-action Service");
    await expect(page.getByTestId("system-diagnostic-fixture-multi-action")).toContainText("Требует внимания");
    await expect(page.getByTestId("system-rog-g703")).toContainText("В сети");
    await expect(page.getByTestId("system-rog-g703")).toContainText("ASUS отвечает");
    await expect(page.getByTestId("system-rog-sleep")).toHaveText("Сон");
    await expect(page.getByTestId("system-rog-hibernate")).toHaveText("Гибернация");
    assertRogLayout(await measureRogLayout(page));
    await expect(page.getByTestId("system-runtime-zone")).toBeVisible();
    await expect(page.getByTestId("system-fact-update")).toContainText("Обновления");
    await expect(page.getByTestId("system-fact-update")).not.toContainText("Обновления и runtime");
    await expect(page.getByTestId("system-fact-backup")).toContainText("Источник не подключён");

    await page.unroute("**/api/v1/snapshot**");
    await installSnapshotMock(page, (snapshot) => addRog(snapshot, "offline"));
    await page.goto("/system");
    await expect(page.getByTestId("system-rog-g703")).toContainText("Не в сети");
    await expect(page.getByTestId("system-rog-g703")).toContainText("Устройство не отвечает");
    await expect(page.getByTestId("system-rog-wake")).toHaveText("Включить");
    await expect(page.getByTestId("system-rog-sleep")).toHaveCount(0);
    await expect(page.getByTestId("system-rog-hibernate")).toHaveCount(0);
    assertRogLayout(await measureRogLayout(page));

    await page.unroute("**/api/v1/snapshot**");
    await installSnapshotMock(page, (snapshot) => addRog(snapshot, "waking"));
    await page.goto("/system");
    await expect(page.getByTestId("system-rog-g703")).toContainText("Пробуждение");
    await expect(page.getByTestId("system-rog-g703")).toContainText("Ждём, когда ASUS появится в сети");
    await expect(page.getByTestId("system-rog-wake")).toBeDisabled();
    assertRogLayout(await measureRogLayout(page));

    await page.unroute("**/api/v1/snapshot**");
    await installSnapshotMock(page, (snapshot) => addRog(snapshot, "hibernating"));
    await page.goto("/system");
    await expect(page.getByTestId("system-rog-g703")).toContainText("Гибернация");
    await expect(page.getByTestId("system-rog-sleep")).toBeDisabled();
    await expect(page.getByTestId("system-rog-hibernate")).toBeDisabled();
    assertRogLayout(await measureRogLayout(page));

    await page.unroute("**/api/v1/snapshot**");
    await installSnapshotMock(page, (snapshot) => addRog(snapshot, "sleeping"));
    await page.goto("/system");
    await expect(page.getByTestId("system-rog-g703")).toContainText("Сон");
    await expect(page.getByTestId("system-rog-sleep")).toBeDisabled();
    await expect(page.getByTestId("system-rog-hibernate")).toBeDisabled();
    assertRogLayout(await measureRogLayout(page));

    await page.unroute("**/api/v1/snapshot**");
    await installSnapshotMock(page, (snapshot) => addRog(snapshot, "unavailable"));
    await page.goto("/system");
    await expect(page.getByTestId("system-rog-g703")).toContainText("Недоступен");
    await expect(page.getByTestId("system-rog-action-unavailable")).toBeVisible();
  });

  test("System surfaces runtime snapshot truth without inventing metrics", async ({ page }) => {
    await installSnapshotMock(page, (snapshot) => ({
      ...addRog(snapshot, "online"),
      services: [...addRog(snapshot, "online").services, runtimeService("healthy")]
    }));
    await page.goto("/system");
    await expect(page.getByTestId("system-runtime-snapshot")).toContainText("Панель");
    await expect(page.getByTestId("system-runtime-snapshot")).toContainText("В норме");
    await expect(page.getByTestId("system-runtime-snapshot")).toContainText("Панель работает нормально");
    await expect(page.getByTestId("system-runtime-snapshot")).toContainText("проверено только что");

    await page.unroute("**/api/v1/snapshot**");
    await installSnapshotMock(page, (snapshot) => ({
      ...addRog(snapshot, "online"),
      services: [...addRog(snapshot, "online").services, runtimeService("degraded")]
    }));
    await page.goto("/system");
    await expect(page.getByTestId("system-aggregate-strip")).toContainText("Требуют внимания · 2");
    await expect(page.getByTestId("system-runtime-snapshot")).toContainText("Панель");
    await expect(page.getByTestId("system-runtime-snapshot")).toContainText("Требует внимания");
    await expect(page.getByTestId("system-runtime-snapshot")).toContainText("Панель требует внимания");
    await expect(page.getByTestId("system-runtime-snapshot")).toContainText("проверено только что");
    await expect(page.getByTestId("system-runtime-zone")).not.toContainText("CPU");
    await expect(page.getByTestId("system-runtime-zone")).not.toContainText("RAM");
  });

  test("captures the exact PR7 route-density review artifact set", async ({ page }, testInfo) => {
    const artifactDir = path.resolve(process.env.V2_ROUTE_DENSITY_ARTIFACT_DIR ?? testInfo.outputPath("v2-route-density-review"));
    await mkdir(artifactDir, { recursive: true });
    const capture = async (name: string, url: string, mutate?: SnapshotMutator, fullPage = false) => {
      await page.unroute("**/api/v1/snapshot**").catch(() => undefined);
      if (mutate) await installSnapshotMock(page, mutate);
      await page.goto(url);
      await page.waitForTimeout(120);
      await page.screenshot({ path: path.join(artifactDir, name), animations: "disabled", fullPage });
    };

    await capture("home-default.png", "/home?scenario=home-normal", (snapshot) => setCoffeeState(snapshot, "off"));
    await capture("home-v2-coffee.png", "/home?scenario=home-normal", (snapshot) => setCoffeeState(snapshot, "off"));
    await capture("home-coffee-kettle.png", "/home?scenario=home-coffee-kettle", (snapshot) => setCoffeeState(snapshot, "off"));
    await capture("home-coffee-only.png", "/home?scenario=home-coffee-only", (snapshot) => setCoffeeState(snapshot, "off"));
    await capture("home-ha-stale.png", "/home?scenario=home-ha-stale", (snapshot) => setCoffeeState(snapshot, "stale"));
    await capture("home-ha-offline.png", "/home?scenario=home-ha-offline", (snapshot) => setCoffeeState(snapshot, "unavailable"));
    await page.setViewportSize({ width: 640, height: 360 });
    await capture("home-200-percent.png", "/home?scenario=home-long-russian", (snapshot) => setCoffeeState(snapshot, "off"));
    await expectNoOverflow(page);
    await page.setViewportSize({ width: 1280, height: 720 });

    await capture("services-all-healthy.png", "/services", allHealthy);
    await capture("services-attention.png", "/services", (snapshot) => ({
      ...snapshot,
      services: snapshot.services.map((service) => service.id === "fixture-multi-action" ? { ...service, health: "degraded" } : service)
    }));
    await capture("services-offline.png", "/services", (snapshot) => ({
      ...snapshot,
      services: snapshot.services.map((service) => service.id === "fixture-multi-action" ? { ...service, health: "offline" } : service)
    }));
    await capture("services-healthy-expanded.png", "/services", allHealthy);
    await page.getByTestId("healthy-group-home-infrastructure").getByRole("button").click();
    await page.screenshot({ path: path.join(artifactDir, "services-healthy-expanded.png"), animations: "disabled" });
    await page.getByTestId("health-row-home-assistant").getByRole("button", { name: /Подробнее/ }).click();
    await page.screenshot({ path: path.join(artifactDir, "services-details-sheet.png"), animations: "disabled" });
    await page.setViewportSize({ width: 640, height: 360 });
    await capture("services-200-percent.png", "/services", allHealthy);
    await expectNoOverflow(page);
    await page.setViewportSize({ width: 1280, height: 720 });

    await capture("system-default.png", "/system", (snapshot) => addRog(snapshot, "online"));
    await capture("system-rog-online.png", "/system", (snapshot) => addRog(snapshot, "online"));
    await capture("system-rog-offline.png", "/system", (snapshot) => addRog(snapshot, "offline"));
    await page.getByTestId("system-rog-g703").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifactDir, "system-rog-offline-focus.png"), animations: "disabled" });
    await capture("system-rog-transition.png", "/system", (snapshot) => addRog(snapshot, "waking"));
    await page.getByTestId("system-rog-g703").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifactDir, "system-rog-transition-focus.png"), animations: "disabled" });
    await capture("system-runtime-attention.png", "/system", (snapshot) => ({
      ...addRog(snapshot, "online"),
      services: [...addRog(snapshot, "online").services, runtimeService("degraded")]
    }));
    await page.setViewportSize({ width: 640, height: 360 });
    await capture("system-200-percent.png", "/system?scenario=home-long-russian", (snapshot) => addRog(snapshot, "online"));
    await expectNoOverflow(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await capture("routes-long-russian.png", "/services?scenario=home-long-russian", longRussianServices, true);
  });
});
