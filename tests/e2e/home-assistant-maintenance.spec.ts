import { expect, test, type Page } from "@playwright/test";
import type { DashboardSnapshot } from "@artem/contracts";
import { HA_UPDATE_CORE } from "../../apps/dashboard/src/homeAssistantMaintenanceApi";

test.skip(process.env.VITE_V2_VISUAL_SHELL !== "true", "Maintenance is available in the production shell");

async function prepare(page: Page, allowed = true) {
  const sample: DashboardSnapshot = await (await page.request.get("/api/v1/snapshot?scenario=ha-healthy")).json();
  sample.mode = "production";
  const service = sample.services.find(item => item.id === "home-assistant")!;
  service.health = "degraded";
  Object.assign(service.data, { maintenanceTarget: "homeAssistant" });
  await page.route("**/api/v1/snapshot?*", route => route.fulfill({ json: sample }));
  await page.route("**/api/v1/events", route => route.abort());
  await page.route("**/api/v1/access", route => route.fulfill({ json: {
    baseProfile: allowed ? "full" : "read_only", effectiveProfile: allowed ? "full" : "read_only", capabilities: {}
  } }));
  const trace = { checks: 0, writes: [] as { actionId: string; requestId: string }[], latest: "2026.11.2",
    checkFailure: "", activeRequest: "", polls: 0 };
  await page.route(/\/api\/v1\/actions\/home-assistant\/maintenance(?:\/.*)?$/, async route => {
    const req = route.request();
    const endpoint = new URL(req.url()).pathname.split("/").at(-1);
    if (endpoint === "update-check") {
      expect(req.method()).toBe("GET");
      trace.checks++;
      if (trace.checkFailure) return route.fulfill({ status: 503, json: { detail: trace.checkFailure } });
      return route.fulfill({ json: {
        installedVersion: "2026.9.3", latestVersion: trace.latest,
        state: trace.latest === "2026.9.3" ? "up_to_date" : "available", checkedAt: "2026-11-18T17:00:00Z"
      } });
    }
    if (req.method() === "POST") {
      trace.writes.push(req.postDataJSON());
      return route.fulfill({ status: 202, json: { ...trace.writes.at(-1), status: "requested", failureCode: null } });
    }
    if (endpoint !== "maintenance") {
      trace.polls++;
      trace.activeRequest = "";
      return route.fulfill({ json: { requestId: endpoint, actionId: HA_UPDATE_CORE, status: "success", result: "success", failureCode: null } });
    }
    return route.fulfill({ json: { configured: true, reachable: true, maintenanceGateEnabled: allowed, busy: Boolean(trace.activeRequest),
      activeOperation: trace.activeRequest ? { requestId: trace.activeRequest, actionId: HA_UPDATE_CORE, status: "dispatching", failureCode: null } : null,
      services: { homeAssistant: { running: true, healthy: true, installedVersion: "2026.9.3", configuredImage: "ghcr.io/home-assistant/home-assistant:stable" } },
      actions: { [HA_UPDATE_CORE]: { allowed, availability: allowed ? "allowed" : "gate_disabled" } }
    } });
  });
  return trace;
}

for (const [route, width, height] of [["services", 1280, 720], ["system", 720, 1280]] as const) {
  test(`HA checks separately, cancels and then confirms one install through ${route}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const trace = await prepare(page);
    await page.goto(`/${route}?motion=reduced`);
    if (route === "services") await page.getByTestId("health-row-home-assistant").getByRole("button", { name: /Подробнее/ }).click();
    const card = page.getByTestId("home-assistant-maintenance");
    const install = card.getByRole("button", { name: "Установить обновление" });
    await expect(install).toHaveCount(0);
    await card.getByRole("button", { name: "Проверить обновления" }).click();
    await expect(card.getByRole("status")).toContainText("Доступна версия 2026.11.2");
    expect(trace.checks).toBe(1);
    expect(trace.writes).toEqual([]);
    await install.click();
    const modal = page.getByTestId("action-confirmation");
    await expect(modal).toContainText("2026.9.3");
    await expect(modal).toContainText("2026.11.2");
    await expect(modal).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(modal.getByRole("button", { name: "Отмена" })).toBeFocused();
    if (process.env.VITE_V3_VISUAL_SKIN === "true") {
      const mismatches = await modal.evaluate(el => {
        const root = document.documentElement, originalTheme = root.dataset.theme!, originalAccent = root.dataset.accent!;
        const probe = document.createElement("i");
        probe.style.color = "var(--cc-accent)";
        el.append(probe);
        const failed: string[] = [];
        for (const theme of ["night", "day"]) for (const accent of ["ice", "iris", "lagoon", "rose"]) {
          root.dataset.theme = theme; root.dataset.accent = accent;
          if (getComputedStyle(el.querySelector(".action-confirmation__confirm")!).backgroundColor !== getComputedStyle(probe).color) failed.push(theme + "/" + accent);
        }
        probe.remove(); root.dataset.theme = originalTheme; root.dataset.accent = originalAccent;
        return failed;
      });
      expect(mismatches).toEqual([]);
    }
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(install).toBeFocused();
    expect(trace.writes).toEqual([]);
    await install.click();
    await modal.getByRole("button", { name: "Установить", exact: true }).click();
    await expect(card).toContainText("Обновление установлено");
    expect(trace.writes).toEqual([{ actionId: HA_UPDATE_CORE, requestId: expect.stringMatching(/^[\da-f-]{36}$/i) }]);
  });
}

test("HA release checks stay available with writes disabled and a failed recheck cannot enable installation", async ({ page }) => {
  const trace = await prepare(page, false);
  await page.goto("/system?motion=reduced");
  const card = page.getByTestId("home-assistant-maintenance");
  const check = card.getByRole("button", { name: "Проверить обновления" });
  const install = card.getByRole("button", { name: "Установить обновление" });
  await check.click();
  await expect(install).toBeDisabled();
  await expect(card).toContainText("Операция отключена");
  trace.checkFailure = "release_feed_unavailable";
  await check.click();
  await expect(card).toContainText("Не удалось получить версию из каталога");
  await expect(install).toHaveCount(0);
  trace.checkFailure = ""; trace.latest = "2026.9.3";
  await check.click();
  await expect(card).toContainText("Установлена актуальная версия 2026.9.3");
  await expect(install).toHaveCount(0);
  expect(trace.writes).toEqual([]);
});

test("opening the card during installation resumes observation without repeating the action", async ({ page }) => {
  const trace = await prepare(page);
  trace.activeRequest = "814e38b9-14cd-4ac4-9d9d-66db3d56ea68";
  await page.goto("/system");
  const card = page.getByTestId("home-assistant-maintenance");
  await expect(card).toContainText("Обновление установлено");
  expect(trace.polls).toBe(1);
  expect(trace.writes).toEqual([]);
});

test("a custom image keeps a separately confirmed update without promising a release version", async ({ page }) => {
  const trace = await prepare(page);
  trace.checkFailure = "unsupported_release_channel";
  await page.goto("/system");
  const card = page.getByTestId("home-assistant-maintenance");
  await card.getByRole("button", { name: "Проверить обновления" }).click();
  await expect(card).toContainText("Для этого образа нельзя сравнить версии");
  await card.getByRole("button", { name: "Обновить настроенный образ" }).click();
  const modal = page.getByTestId("action-confirmation");
  await expect(modal).toContainText("Docker Compose");
  await modal.getByRole("button", { name: "Отмена" }).click();
  expect(trace.writes).toEqual([]);
});
