import { expect, test, type Page } from "@playwright/test";

const actionIds = [
  "avalar.main.smoke",
  "avalar.stage.smoke",
  "avalar.main.restart",
  "avalar.stage.restart",
  "avalar.stage.deploy",
  "avalar.main.deploy"
] as const;

type AvalarActionId = typeof actionIds[number];

function availabilityPayload() {
  return {
    schemaVersion: 1,
    actions: Object.fromEntries(actionIds.map((actionId) => [
      actionId,
      {
        capability: actionId,
        minimumProfile: actionId.endsWith(".smoke") ? "standard" : "full",
        effectiveProfile: "full",
        allowed: true,
        availability: "allowed",
        cooldownUntil: null
      }
    ]))
  };
}

function execution(actionId: AvalarActionId, status: "requested" | "success") {
  return {
    schemaVersion: 1,
    correlationId: "87654321-aaaa-bbbb-cccc-123456789012",
    actionId,
    environment: actionId.includes(".main.") ? "production" : "stage",
    status,
    requestedAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:01Z",
    finishedAt: status === "success" ? "2026-08-11T00:00:02Z" : null,
    result: status === "success" ? { ok: true } : null,
    error: null
  };
}

async function mockAvalar(page: Page) {
  let postCount = 0;
  let lastBody: Record<string, unknown> | null = null;
  let activeAction: AvalarActionId = "avalar.stage.restart";

  await page.route("**/api/v1/actions/avalar**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname.endsWith("/availability")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(availabilityPayload())
      });
      return;
    }

    if (url.pathname === "/api/v1/actions/avalar" && request.method() === "POST") {
      postCount += 1;
      lastBody = request.postDataJSON() as Record<string, unknown>;
      activeAction = lastBody.actionId as AvalarActionId;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify(execution(activeAction, "requested"))
      });
      return;
    }

    if (url.pathname.includes("/api/v1/actions/avalar/87654321-")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(execution(activeAction, "success"))
      });
      return;
    }

    await route.continue();
  });

  return {
    getPostCount: () => postCount,
    getLastBody: () => lastBody
  };
}

test("Stage restart uses touch confirmation and cancel never calls the action API", async ({ page }) => {
  const api = await mockAvalar(page);
  await page.goto("/services");

  const stage = page.getByTestId("widget-avalar-site-stage");
  const restart = stage.getByRole("button", { name: "Перезапустить Stage" });
  await restart.click();

  const modal = page.getByTestId("action-confirmation");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("AVALAR Stage");
  await expect(modal).toContainText("stage");

  await page.keyboard.press("Shift+Tab");
  await expect(modal.getByRole("button", { name: "Перезапустить Stage" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(modal.getByRole("button", { name: "Отмена" })).toBeFocused();

  await modal.getByRole("button", { name: "Отмена" }).click();
  await expect(modal).toBeHidden();
  expect(api.getPostCount()).toBe(0);

  await restart.click();
  await page.getByTestId("action-confirmation")
    .getByRole("button", { name: "Перезапустить Stage" })
    .click();
  await expect.poll(api.getPostCount).toBe(1);
});

test("Main deploy requires the exact production phrase and forwards it to backend", async ({ page }) => {
  const api = await mockAvalar(page);
  await page.addInitScript(() => {
    const mark = () => {
      (window as typeof window & { __nativeConfirmationCalls?: number }).__nativeConfirmationCalls =
        ((window as typeof window & { __nativeConfirmationCalls?: number }).__nativeConfirmationCalls ?? 0) + 1;
      return false;
    };
    window.confirm = mark;
    window.prompt = () => {
      mark();
      return null;
    };
    window.alert = () => {
      mark();
    };
  });

  await page.goto("/services");
  const main = page.getByTestId("widget-avalar-site-main");
  await main.getByRole("button", { name: "Обновить Main" }).click();

  const modal = page.getByTestId("action-confirmation");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("AVALAR Main");
  await expect(modal).toContainText("production");
  await expect(modal).toContainText("DEPLOY MAIN");

  const input = modal.getByLabel(/Введите фразу подтверждения/);
  const deploy = modal.getByRole("button", { name: "Задеплоить Main" });
  await expect(deploy).toBeDisabled();
  await input.fill("deploy main");
  await expect(deploy).toBeDisabled();
  await input.fill("DEPLOY MAIN ");
  await expect(deploy).toBeDisabled();
  await input.fill("DEPLOY MAIN");
  await expect(deploy).toBeEnabled();
  await deploy.click();

  await expect.poll(api.getPostCount).toBe(1);
  expect(api.getLastBody()?.confirmation).toBe("DEPLOY MAIN");
  const nativeCalls = await page.evaluate(() =>
    (window as typeof window & { __nativeConfirmationCalls?: number }).__nativeConfirmationCalls ?? 0
  );
  expect(nativeCalls).toBe(0);
});

test("coffee turn-on shares the same modal and Escape cancels without a write", async ({ page }) => {
  let coffeePosts = 0;
  await page.route("**/api/v1/actions/home/coffee", async (route) => {
    if (route.request().method() === "POST") coffeePosts += 1;
    await route.continue();
  });

  await page.goto("/home?scenario=coffee-off");
  await page.getByRole("button", { name: "Включить" }).click();

  const modal = page.getByTestId("action-confirmation");
  await expect(modal).toContainText("Кофемашина");
  await expect(modal).toContainText("Home Assistant");
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  expect(coffeePosts).toBe(0);
});
