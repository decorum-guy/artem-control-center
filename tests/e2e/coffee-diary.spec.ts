import { expect, test, type Page } from "@playwright/test";

type BeanRecord = {
  id: string;
  version: number;
  name: string;
  favoriteExtractionId: string | null;
  photoIds: string[];
  deletedAt: string | null;
};

type ExtractionRecord = {
  id: string;
  version: number;
  beanId: string;
  doseGrams: number;
  extractionSeconds: number;
  yieldGrams: number;
  deletedAt: string | null;
};

type BeanDetail = { bean: BeanRecord; extractions: ExtractionRecord[] };

async function clearDiary(page: Page): Promise<void> {
  const collection = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { beans: BeanRecord[] };
  for (const bean of collection.beans) {
    let detail = await page.request.get(`/api/v1/coffee-diary/beans/${bean.id}`).then((response) => response.json()) as BeanDetail;
    for (const extraction of detail.extractions) {
      const deleted = await page.request.delete(`/api/v1/coffee-diary/extractions/${extraction.id}`, { headers: { "If-Match": `"${extraction.version}"` } });
      expect(deleted.status()).toBe(200);
    }
    detail = await page.request.get(`/api/v1/coffee-diary/beans/${bean.id}`).then((response) => response.json()) as BeanDetail;
    const deletedBean = await page.request.delete(`/api/v1/coffee-diary/beans/${bean.id}`, { headers: { "If-Match": `"${detail.bean.version}"` } });
    expect(deletedBean.status()).toBe(200);
  }
}

async function seedBean(page: Page, name: string, idempotencyKey: string): Promise<BeanRecord> {
  const uniqueKey = `${idempotencyKey}-${Date.now()}`;
  const response = await page.request.post("/api/v1/coffee-diary/beans", {
    headers: { "Idempotency-Key": uniqueKey },
    data: { name, grindDescription: "Средний помол", preferredDrink: "universal", notes: null }
  });
  expect(response.status()).toBe(201);
  return await response.json() as BeanRecord;
}

async function enterNumeric(page: Page, triggerId: string, keypadId: string, value: string): Promise<void> {
  await page.getByTestId(triggerId).click();
  const keypad = page.getByTestId(keypadId);
  if (await keypad.getByRole("button", { name: "Очистить" }).count()) await keypad.getByRole("button", { name: "Очистить" }).click();
  for (const character of value) {
    await keypad.getByRole("button", { name: character === "." ? "Десятичный разделитель" : `Цифра ${character}` }).click();
  }
  await keypad.getByRole("button", { name: "Готово" }).click();
}

async function fillShot(page: Page, dose: string, seconds: string, yieldAmount: string, notes: string, favorite = false): Promise<void> {
  await enterNumeric(page, "coffee-diary-dose-trigger", "coffee-diary-dose-keypad", dose);
  await enterNumeric(page, "coffee-diary-seconds-trigger", "coffee-diary-seconds-keypad", seconds);
  await enterNumeric(page, "coffee-diary-yield-trigger", "coffee-diary-yield-keypad", yieldAmount);
  await page.getByTestId("coffee-diary-input-extraction-notes").fill(notes);
  if (favorite) await page.getByTestId("coffee-diary-make-favorite").check();
}

test.describe("Coffee Diary Slice 1", () => {
  test.beforeEach(async ({ page }) => {
    await clearDiary(page);
  });
  test.afterEach(async ({ page }) => {
    await clearDiary(page);
  });

  test("implements the #124 bean, shot, favourite, history, and export journey", async ({ page }) => {
    await page.goto("/coffee-diary");
    await expect(page.getByTestId("route-coffee-diary")).toBeVisible();
    await expect(page.getByTestId("coffee-diary-empty")).toBeVisible();

    await page.getByTestId("coffee-diary-add-bean").click();
    await page.getByTestId("coffee-diary-input-name").fill("Эфиопия");
    await page.getByTestId("coffee-diary-input-grind").fill("Чуть мельче среднего");
    await page.getByTestId("coffee-diary-input-preferred-drink").selectOption("espresso");
    await page.getByTestId("coffee-diary-input-notes").fill("Шоколад и ягоды");
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Чуть мельче среднего");
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Эспрессо");
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Шоколад и ягоды");

    await page.getByTestId("coffee-diary-add-bean").click();
    await page.getByTestId("coffee-diary-input-name").fill("Эфиопия");
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    const collection = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { beans: BeanRecord[]; photos: unknown[] };
    expect(collection.beans).toHaveLength(2);
    expect(collection.beans[0].id).not.toBe(collection.beans[1].id);
    expect(collection.photos).toEqual([]);
    const beanA = collection.beans[0];
    const beanB = collection.beans[1];
    expect(beanA.name).toBe("Эфиопия");
    expect(beanA.id).not.toBe(beanB.id);

    await page.locator(".coffee-diary-bean-card").first().click();
    await page.getByTestId("coffee-diary-detail").getByRole("button", { name: "Добавить" }).click();
    await fillShot(page, "17.5", "27", "36.0", "Сладко, хороший баланс", true);
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-best-recipe")).toContainText("17.5 г · 27 с · 36.0 г");
    await expect(page.getByTestId("coffee-diary-favorite-marker")).toHaveText("Лучший");

    await page.getByTestId("coffee-diary-detail").getByRole("button", { name: "Добавить" }).click();
    await fillShot(page, "18.0", "30", "38.0", "Стабильно, плотнее");
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-history").getByTestId("coffee-diary-extraction")).toHaveCount(2);
    await expect(page.getByTestId("coffee-diary-history")).toContainText("17.5 г · 27 с · 36.0 г");
    await expect(page.getByTestId("coffee-diary-history")).toContainText("18.0 г · 30 с · 38.0 г");

    const second = page.getByTestId("coffee-diary-extraction").filter({ hasText: "18.0 г · 30 с · 38.0 г" });
    await second.getByRole("button", { name: "Сделать лучшим" }).click();
    await expect(page.getByTestId("coffee-diary-best-recipe")).toContainText("18.0 г · 30 с · 38.0 г");
    await expect(page.getByTestId("coffee-diary-history")).toContainText("17.5 г · 27 с · 36.0 г");

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("coffee-diary-export").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("coffee-diary.json");
    const stream = await download.createReadStream();
    let exported = "";
    for await (const chunk of stream ?? []) exported += chunk.toString();
    const data = JSON.parse(exported) as { schemaVersion: string; beans: BeanRecord[]; extractions: ExtractionRecord[]; photos: unknown[] };
    expect(data.schemaVersion).toBe("coffee.diary.export.v1");
    const activeBeans = data.beans.filter((bean) => bean.deletedAt === null);
    const activeExtractions = data.extractions.filter((extraction) => extraction.deletedAt === null);
    expect(activeBeans).toHaveLength(2);
    expect(activeExtractions).toHaveLength(2);
    expect(data.photos).toEqual([]);
    expect(activeExtractions.every((extraction) => extraction.beanId === beanA.id)).toBe(true);
    const exportedBeanA = activeBeans.find((bean) => bean.id === beanA.id);
    expect(exportedBeanA?.favoriteExtractionId).toBe(activeExtractions[1].id);
    expect(exportedBeanA?.photoIds).toEqual([]);
  });

  test("rejects an unsupported hundredth gram through the authoritative API", async ({ page }) => {
    const bean = await seedBean(page, "Точность", "e2e-grams-bean-0001");
    const response = await page.request.post(`/api/v1/coffee-diary/beans/${bean.id}/extractions`, {
      headers: { "Idempotency-Key": "e2e-grams-extraction-0001" },
      data: { brewedAt: "2026-08-28T10:00:00Z", doseGrams: 17.15, extractionSeconds: 27, yieldGrams: 36.0, notes: null, rating: null, makeFavorite: false }
    });
    expect(response.status()).toBe(422);
    expect(await response.json()).toEqual({ detail: "coffee_diary_grams_precision_invalid" });
  });

  test("blocks a rapid bean double-submit with one POST", async ({ page }) => {
    await page.goto("/coffee-diary");
    await page.getByTestId("coffee-diary-add-bean").click();
    await page.getByTestId("coffee-diary-input-name").fill("Двойное касание зерна");

    const keys: string[] = [];
    let resolvePostStarted!: () => void;
    const postStarted = new Promise<void>((resolve) => { resolvePostStarted = resolve; });
    await page.route("**/api/v1/coffee-diary/beans", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      resolvePostStarted();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });

    await page.locator("#coffee-diary-bean-form").evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
      (form as HTMLFormElement).requestSubmit();
    });
    await postStarted;
    await expect(page.getByRole("button", { name: "Сохраняем…" })).toBeDisabled();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Двойное касание зерна");
    expect(keys).toHaveLength(1);
    await page.unroute("**/api/v1/coffee-diary/beans");
  });

  test("reuses a bean key after a committed response is lost", async ({ page }) => {
    await page.goto("/coffee-diary");
    await page.getByTestId("coffee-diary-add-bean").click();
    await page.getByTestId("coffee-diary-input-name").fill("Потерянный ответ зерна");

    const keys: string[] = [];
    await page.route("**/api/v1/coffee-diary/beans", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      if (keys.length === 1) {
        const response = await route.fetch();
        await response.body();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByRole("alert")).toContainText("Ответ сервера не получен. Можно повторить сохранение — дубликат создан не будет.");
    await expect(page.getByTestId("coffee-diary-bean-sheet")).toBeVisible();
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Потерянный ответ зерна");
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const collection = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { beans: BeanRecord[] };
    expect(collection.beans).toHaveLength(1);
    await page.unroute("**/api/v1/coffee-diary/beans");
  });

  test("blocks rapid extraction submit and retains an extraction key after response loss", async ({ page }) => {
    const bean = await seedBean(page, "Приготовление", "e2e-extraction-bean-0001");
    await page.goto("/coffee-diary");
    await page.getByTestId("coffee-diary-detail").getByRole("button", { name: "Добавить" }).click();
    await fillShot(page, "17.5", "27", "36.0", "Тестовый шот");

    const doubleTapKeys: string[] = [];
    let resolvePostStarted!: () => void;
    const postStarted = new Promise<void>((resolve) => { resolvePostStarted = resolve; });
    await page.route("**/api/v1/coffee-diary/beans/*/extractions", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      doubleTapKeys.push(route.request().headers()["idempotency-key"] ?? "");
      resolvePostStarted();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    await page.locator("#coffee-diary-extraction-form").evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
      (form as HTMLFormElement).requestSubmit();
    });
    await postStarted;
    await expect(page.getByRole("button", { name: "Сохраняем…" })).toBeDisabled();
    await expect(page.getByTestId("coffee-diary-extraction-sheet")).toHaveCount(0);
    expect(doubleTapKeys).toHaveLength(1);

    await page.unroute("**/api/v1/coffee-diary/beans/*/extractions");
    await page.goto("/coffee-diary");
    await page.getByTestId("coffee-diary-detail").getByRole("button", { name: "Добавить" }).click();
    await fillShot(page, "18.0", "30", "38.0", "Потерянный ответ");
    const lossKeys: string[] = [];
    await page.route("**/api/v1/coffee-diary/beans/*/extractions", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      lossKeys.push(route.request().headers()["idempotency-key"] ?? "");
      if (lossKeys.length === 1) {
        const response = await route.fetch();
        await response.body();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByRole("alert")).toContainText("Ответ сервера не получен. Можно повторить сохранение — дубликат создан не будет.");
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-extraction-sheet")).toHaveCount(0);
    expect(lossKeys).toHaveLength(2);
    expect(lossKeys[1]).toBe(lossKeys[0]);
    const detail = await page.request.get(`/api/v1/coffee-diary/beans/${bean.id}`).then((response) => response.json()) as BeanDetail;
    expect(detail.extractions).toHaveLength(2);
    expect(detail.extractions.every((extraction) => extraction.beanId === bean.id)).toBe(true);
    await page.unroute("**/api/v1/coffee-diary/beans/*/extractions");
  });

  test("interaction lock prevents diary mutation requests", async ({ page }) => {
    test.skip(process.env.VITE_TOUCH_INPUT_LOCK_ENABLED !== "true", "Focused lock gate enables the shared Interaction Lock.");
    await page.goto("/coffee-diary");
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/coffee-diary") && request.method() !== "GET") requests.push(request.method());
    });
    await page.getByTestId("interaction-lock-control").hover();
    await page.mouse.down();
    await page.waitForTimeout(1_100);
    await page.mouse.up();
    await expect(page.getByTestId("interaction-lock-status")).toBeVisible();
    await page.getByRole("button", { name: "Добавить кофе" }).first().click();
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    expect(requests).toEqual([]);
  });

  test("keeps diary controls usable at a 200 percent effective zoom", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await page.goto("/coffee-diary");
    await expect(page.getByTestId("route-coffee-diary")).toBeVisible();
    const overflow = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      bodyWidth: document.body.scrollWidth
    }));
    expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
    expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);

    await page.getByTestId("coffee-diary-add-bean").click();
    await expect(page.getByTestId("coffee-diary-bean-sheet")).toBeVisible();
    const shortTargets = await page.locator(".coffee-diary-page button, .coffee-diary-sheet button").evaluateAll((elements) => elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.height >= 48 ? [] : [{ text: element.textContent?.trim(), height: rect.height }];
    }));
    expect(shortTargets, JSON.stringify(shortTargets)).toEqual([]);
    await page.getByRole("button", { name: "Отмена" }).last().click();
  });

  test("reconciles stale bean edits and deletes without retrying mutations", async ({ page }) => {
    await page.goto("/coffee-diary");
    await page.getByTestId("coffee-diary-add-bean").click();
    await page.getByTestId("coffee-diary-input-name").fill("Конфликтное зерно");
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    const collection = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { beans: BeanRecord[] };
    const bean = collection.beans[0];
    expect(bean.version).toBe(1);
    await page.getByRole("button", { name: "Изменить" }).click();

    const patchRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/api/v1/coffee-diary/beans/${bean.id}`) && request.method() === "PATCH") patchRequests.push(request.headers()["if-match"] ?? "");
    });
    const externalEdit = await page.request.patch(`/api/v1/coffee-diary/beans/${bean.id}`, { headers: { "If-Match": '"1"' }, data: { name: "Каноническая версия" } });
    expect(externalEdit.status()).toBe(200);
    await page.getByTestId("coffee-diary-input-name").fill("Старая версия");
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-bean-sheet")).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText("Данные изменились. Показана актуальная версия.");
    expect(patchRequests).toEqual(['"1"']);
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Каноническая версия");

    await page.getByRole("button", { name: "Изменить" }).click();
    await expect(page.getByTestId("coffee-diary-input-name")).toHaveValue("Каноническая версия");
    await page.getByTestId("coffee-diary-input-name").fill("Каноническая версия · подтверждено");
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Каноническая версия · подтверждено");
    expect(patchRequests).toEqual(['"1"', '"2"']);

    const externalDeleteRace = await page.request.patch(`/api/v1/coffee-diary/beans/${bean.id}`, { headers: { "If-Match": '"3"' }, data: { name: "Удалённое позже" } });
    expect(externalDeleteRace.status()).toBe(200);
    const deleteRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/api/v1/coffee-diary/beans/${bean.id}`) && request.method() === "DELETE") deleteRequests.push(request.method());
    });
    await page.getByRole("button", { name: "Удалить" }).last().click();
    await page.getByTestId("action-confirmation").getByRole("button", { name: "Убрать из коллекции" }).click();
    await expect(page.getByRole("alert")).toContainText("Данные изменились. Показана актуальная версия.");
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Удалённое позже");
    expect(deleteRequests).toEqual(["DELETE"]);
  });
});
