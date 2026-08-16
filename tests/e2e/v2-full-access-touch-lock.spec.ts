import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const lockEnabled = process.env.VITE_TOUCH_INPUT_LOCK_ENABLED === "true";
const actionIds = [
  "avalar.main.smoke",
  "avalar.stage.smoke",
  "avalar.main.restart",
  "avalar.stage.restart",
  "avalar.stage.deploy",
  "avalar.main.deploy"
] as const;

function accessStatus(profile: "standard" | "full") {
  return {
    schemaVersion: 1,
    revision: profile === "full" ? 2 : 1,
    baseProfile: profile,
    effectiveProfile: profile,
    temporaryFull: false,
    temporaryFullExpiresAt: null,
    confirmationPolicy: {
      actionConfirmationRequired: profile !== "full",
      mode: profile === "full" ? "manual_persistent_full" : "profile_default"
    },
    pinConfigured: true,
    lockoutUntil: null,
    capabilities: Object.fromEntries(actionIds.map((actionId) => [actionId, {
      capability: actionId,
      minimumProfile: actionId.endsWith(".smoke") ? "standard" : "full",
      effectiveProfile: profile,
      allowed: true,
      availability: "allowed"
    }]))
  };
}

function execution(actionId: typeof actionIds[number], status: "requested" | "success") {
  return {
    schemaVersion: 1,
    correlationId: "82aa4321-aaaa-bbbb-cccc-123456789012",
    actionId,
    environment: actionId.includes(".main.") ? "production" : "stage",
    status,
    requestedAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:01Z",
    finishedAt: status === "success" ? "2026-08-16T00:00:02Z" : null,
    result: status === "success" ? { ok: true } : null,
    error: null
  };
}

async function installFixtures(page: Page, profile: "standard" | "full") {
  let postCount = 0;
  let lastBody: Record<string, unknown> | null = null;
  let activeAction: typeof actionIds[number] = "avalar.stage.restart";
  let currentProfile = profile;
  let accessGetCount = 0;
  let accessFailuresRemaining = 0;

  await page.route("**/api/v1/access**", async (route) => {
    const request = route.request();
    if (request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/access") {
      accessGetCount += 1;
      if (accessFailuresRemaining > 0) {
        accessFailuresRemaining -= 1;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "fixture_access_unavailable" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(accessStatus(currentProfile)) });
      return;
    }
    await route.fallback();
  });
  await page.route(/\/api\/v1\/actions\/avalar(?:\/.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/availability")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          actions: Object.fromEntries(actionIds.map((actionId) => [actionId, {
            capability: actionId,
            minimumProfile: actionId.endsWith(".smoke") ? "standard" : "full",
            effectiveProfile: profile,
            allowed: true,
            availability: "allowed",
            cooldownUntil: null
          }]))
        })
      });
      return;
    }
    if (url.pathname === "/api/v1/actions/avalar" && request.method() === "POST") {
      postCount += 1;
      lastBody = request.postDataJSON() as Record<string, unknown>;
      activeAction = lastBody.actionId as typeof actionIds[number];
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(execution(activeAction, "requested")) });
      return;
    }
    if (url.pathname.includes("/api/v1/actions/avalar/82aa4321-")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(execution(activeAction, "success")) });
      return;
    }
    await route.fallback();
  });

  return {
    getPostCount: () => postCount,
    getLastBody: () => lastBody,
    getAccessGetCount: () => accessGetCount,
    setAccessProfile: (next: "standard" | "full") => { currentProfile = next; },
    failNextAccessRefresh: () => { accessFailuresRemaining += 1; }
  };
}

async function holdLock(page: Page) {
  const control = page.getByTestId("interaction-lock-control");
  await expect(control).toBeVisible();
  await control.hover();
  await page.mouse.down();
  await expect(control.getByRole("progressbar")).toBeVisible();
  await page.waitForTimeout(300);
  await captureScreenshot(page, "touch-lock-active-hold.png");
  await expect(control).toHaveAttribute("aria-pressed", "true", { timeout: 1_000 });
  await page.mouse.up();
}

async function captureScreenshot(page: Page, filename: string) {
  const directory = process.env.TOUCH_LOCK_ARTIFACT_DIR ?? "artifacts/touch-lock";
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, filename), animations: "disabled" });
}

async function openAvalarServiceDetails(page: Page, serviceId: "avalar-site-main" | "avalar-site-stage") {
  const group = page.getByTestId("healthy-group-avalar");
  const summary = group.locator(".collapsible-group__summary");
  if (await summary.getAttribute("aria-expanded") !== "true") await summary.click();
  await page.getByTestId(`health-row-${serviceId}`).getByRole("button", { name: /Подробнее/ }).click();
  await expect(page.getByTestId("service-details-sheet")).toBeVisible();
}

test.describe("#82 trusted Full Access and touch lock", () => {
  test.skip(!lockEnabled, "Run with VITE_TOUCH_INPUT_LOCK_ENABLED=true for the #82 browser gate.");

  test("Standard keeps simple confirmation", async ({ page }) => {
    const api = await installFixtures(page, "standard");
    await page.goto("/services");
    await openAvalarServiceDetails(page, "avalar-site-stage");
    await page.getByTestId("service-details-sheet").getByRole("button", { name: "Перезапустить Stage" }).click();
    await expect(page.getByTestId("action-confirmation")).toBeVisible();
    expect(api.getPostCount()).toBe(0);
    await captureScreenshot(page, "touch-lock-standard-confirmation.png");
  });

  test("manual persistent Full runs a simple action immediately", async ({ page }) => {
    const api = await installFixtures(page, "full");
    await page.goto("/services");
    await openAvalarServiceDetails(page, "avalar-site-stage");
    await page.getByTestId("service-details-sheet").getByRole("button", { name: "Перезапустить Stage" }).click();
    await expect(page.getByTestId("action-confirmation")).toHaveCount(0);
    await expect.poll(api.getPostCount).toBe(1);
    await expect(page.getByTestId("avalar-action-notice")).toContainText(/Отправляем|Успешно проверено/);
    await captureScreenshot(page, "touch-lock-full-immediate.png");
  });

  test("manual persistent Full strong action has no phrase or fabricated confirmation", async ({ page }) => {
    const api = await installFixtures(page, "full");
    await page.goto("/services");
    await openAvalarServiceDetails(page, "avalar-site-main");
    await page.getByTestId("service-details-sheet").getByRole("button", { name: "Обновить Main" }).click();
    await expect(page.getByTestId("action-confirmation")).toHaveCount(0);
    await expect.poll(api.getPostCount).toBe(1);
    expect(api.getLastBody()).not.toHaveProperty("confirmation");
  });

  test("fresh policy prevents stale Full from waiving Standard confirmation", async ({ page }) => {
    const api = await installFixtures(page, "full");
    await page.goto("/services");
    await expect.poll(api.getAccessGetCount).toBeGreaterThan(0);
    api.setAccessProfile("standard");
    await openAvalarServiceDetails(page, "avalar-site-stage");
    await page.getByTestId("service-details-sheet").getByRole("button", { name: "Перезапустить Stage" }).click();
    await expect.poll(api.getAccessGetCount).toBeGreaterThan(1);
    await expect(page.getByTestId("action-confirmation")).toBeVisible();
    expect(api.getPostCount()).toBe(0);
    await page.getByTestId("action-confirmation").getByRole("button", { name: "Перезапустить Stage" }).click();
    await expect.poll(api.getPostCount).toBe(1);
  });

  test("fresh policy lets current manual Full bypass cached Standard", async ({ page }) => {
    const api = await installFixtures(page, "standard");
    await page.goto("/services");
    await expect.poll(api.getAccessGetCount).toBeGreaterThan(0);
    api.setAccessProfile("full");
    await openAvalarServiceDetails(page, "avalar-site-stage");
    await page.getByTestId("service-details-sheet").getByRole("button", { name: "Перезапустить Stage" }).click();
    await expect.poll(api.getAccessGetCount).toBeGreaterThan(1);
    await expect(page.getByTestId("action-confirmation")).toHaveCount(0);
    await expect.poll(api.getPostCount).toBe(1);
  });

  test("access refresh failure fails closed to the existing confirmation ceremony", async ({ page }) => {
    const api = await installFixtures(page, "full");
    await page.goto("/services");
    await expect.poll(api.getAccessGetCount).toBeGreaterThan(0);
    api.failNextAccessRefresh();
    await openAvalarServiceDetails(page, "avalar-site-stage");
    await page.getByTestId("service-details-sheet").getByRole("button", { name: "Перезапустить Stage" }).click();
    await expect(page.getByTestId("action-confirmation")).toBeVisible();
    expect(api.getPostCount()).toBe(0);
    await page.getByTestId("action-confirmation").getByRole("button", { name: "Перезапустить Stage" }).click();
    await expect.poll(api.getPostCount).toBe(1);
  });

  test("hold feedback, locked Full state, zero new mutation, and keyboard unlock", async ({ page }) => {
    const api = await installFixtures(page, "full");
    await page.goto("/services");
    await expect(page.getByTestId("interaction-lock-control")).toHaveAttribute("aria-pressed", "false");
    await captureScreenshot(page, "touch-lock-unlocked.png");
    await holdLock(page);
    await expect(page.getByTestId("interaction-lock-status")).toHaveText("Панель заблокирована");
    await expect(page.getByTestId("interaction-lock-control")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("v2-header-access")).toContainText("Полный доступ");
    await captureScreenshot(page, "touch-lock-locked-full-access.png");
    await openAvalarServiceDetails(page, "avalar-site-stage");
    await page.getByTestId("service-details-sheet").getByRole("button", { name: "Перезапустить Stage" }).click();
    expect(api.getPostCount()).toBe(0);
    await page.getByTestId("service-details-sheet").getByRole("button", { name: "Закрыть" }).click();
    await page.locator(".v2-nav-link[data-nav-route='/weather']").click();
    await expect(page.getByTestId("route-weather")).toBeVisible();
    await page.getByTestId("interaction-lock-control").focus();
    await page.keyboard.down("Space");
    await page.waitForTimeout(1_050);
    await page.keyboard.up("Space");
    await expect(page.getByTestId("interaction-lock-status")).toHaveCount(0);
    await expect(page.getByTestId("interaction-lock-control")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("v2-header-access")).toContainText("Полный доступ");
    await captureScreenshot(page, "touch-lock-unlocked-restored.png");
  });

  test("short tap cancels and reduced motion keeps a static active hold cue", async ({ page }) => {
    await installFixtures(page, "full");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/overview");
    const control = page.getByTestId("interaction-lock-control");
    await control.hover();
    await page.mouse.down();
    await page.waitForTimeout(650);
    await expect(control.getByRole("progressbar")).toBeVisible();
    await expect(page.getByText("Почти готово…")).toBeVisible();
    await expect(control).toHaveAttribute("data-reduced-motion", "true");
    await expect(control.getByTestId("interaction-lock-progress-fill")).toBeHidden();
    await captureScreenshot(page, "touch-lock-reduced-motion-hold.png");
    await page.mouse.up();
    await expect(control).toHaveAttribute("aria-pressed", "false");

    await control.hover();
    await page.mouse.down();
    await page.waitForTimeout(1_050);
    await page.mouse.up();
    await expect(control).toHaveAttribute("aria-pressed", "true");
  });
});
