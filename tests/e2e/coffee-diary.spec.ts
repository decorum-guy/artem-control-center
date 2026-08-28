import { expect, test, type Page } from "@playwright/test";

type BeanRecord = { id: string; version: number };
type ExtractionRecord = { id: string; version: number; beanId: string };

async function seedBean(page: Page, name: string, idempotencyKey: string): Promise<BeanRecord> {
  const response = await page.request.post("/api/v1/coffee-diary/beans", {
    headers: { "Idempotency-Key": idempotencyKey },
    data: { name, defaultRecipe: { method: "Эспрессо", fields: [{ key: "dose", label: "Кофе", kind: "number", value: 18, unit: "г" }] } }
  });
  expect(response.status()).toBe(201);
  return await response.json() as BeanRecord;
}

async function removeBean(page: Page, bean: BeanRecord): Promise<void> {
  const response = await page.request.delete(`/api/v1/coffee-diary/beans/${bean.id}`, { headers: { "If-Match": `"${bean.version}"` } });
  expect(response.status()).toBe(200);
}

async function removeExtraction(page: Page, extraction: ExtractionRecord): Promise<void> {
  const response = await page.request.delete(`/api/v1/coffee-diary/extractions/${extraction.id}`, { headers: { "If-Match": `"${extraction.version}"` } });
  expect(response.status()).toBe(200);
}

test.describe("Coffee Diary Slice 1", () => {
  test("creates, edits, snapshots, deletes, and exports a diary record", async ({ page }) => {
    await page.goto("/coffee-diary");
    await expect(page.getByTestId("route-coffee-diary")).toBeVisible();
    await expect(page.getByTestId("coffee-diary-empty")).toBeVisible();
    await expect(page.getByRole("button", { name: "Добавить кофе" }).first()).toBeVisible();

    await page.getByTestId("coffee-diary-add-bean").click();
    await page.getByTestId("coffee-diary-input-name").fill("Эфиопия · длинное имя для touch-панели");
    await page.getByTestId("coffee-diary-input-roaster").fill("Локальная обжарка");
    await page.getByTestId("coffee-diary-bean-numeric-0").click();
    await expect(page.getByTestId("coffee-diary-bean-numeric-keypad")).toBeVisible();
    await page.getByTestId("coffee-diary-bean-numeric-keypad").getByRole("button", { name: "Очистить" }).click();
    await page.getByTestId("coffee-diary-bean-numeric-keypad").getByRole("button", { name: "Цифра 2" }).click();
    await page.getByTestId("coffee-diary-bean-numeric-keypad").getByRole("button", { name: "Цифра 0" }).click();
    await page.getByTestId("coffee-diary-bean-numeric-keypad").getByRole("button", { name: "Готово" }).click();
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Эфиопия · длинное имя для touch-панели");
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Кофе: 20 г");

    await page.getByRole("button", { name: "Изменить" }).click();
    await page.getByTestId("coffee-diary-bean-numeric-0").click();
    await page.getByTestId("coffee-diary-bean-numeric-keypad").getByRole("button", { name: "Очистить" }).click();
    await page.getByTestId("coffee-diary-bean-numeric-keypad").getByRole("button", { name: "Цифра 2" }).click();
    await page.getByTestId("coffee-diary-bean-numeric-keypad").getByRole("button", { name: "Цифра 5" }).click();
    await page.getByTestId("coffee-diary-bean-numeric-keypad").getByRole("button", { name: "Готово" }).click();
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Кофе: 25 г");

    await page.getByTestId("coffee-diary-detail").getByRole("button", { name: "Добавить" }).click();
    await expect(page.getByTestId("coffee-diary-extraction-sheet")).toBeVisible();
    await page.getByRole("button", { name: "Без оценки" }).click();
    await page.getByTestId("coffee-diary-rating-keypad").getByRole("button", { name: "Цифра 9" }).click();
    await page.getByTestId("coffee-diary-rating-keypad").getByRole("button", { name: "Готово" }).click();
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Кофе: 25 г");
    await expect(page.getByTestId("coffee-diary-history")).toContainText("9/10");

    await page.getByRole("button", { name: "Изменить" }).click();
    await page.getByTestId("coffee-diary-bean-numeric-0").click();
    await page.getByTestId("coffee-diary-bean-numeric-keypad").getByRole("button", { name: "Очистить" }).click();
    await page.getByTestId("coffee-diary-bean-numeric-keypad").getByRole("button", { name: "Цифра 3" }).click();
    await page.getByTestId("coffee-diary-bean-numeric-keypad").getByRole("button", { name: "Цифра 0" }).click();
    await page.getByTestId("coffee-diary-bean-numeric-keypad").getByRole("button", { name: "Готово" }).click();
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Кофе: 30 г");
    await expect(page.getByTestId("coffee-diary-history")).toContainText("Кофе: 25 г");

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("coffee-diary-export").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("coffee-diary.json");
    const stream = await download.createReadStream();
    let exported = "";
    for await (const chunk of stream ?? []) exported += chunk.toString();
    const data = JSON.parse(exported) as { schemaVersion: string; beans: unknown[]; extractions: Array<{ recipeSnapshot: { fields: Array<{ value: number }> } }> };
    expect(data.schemaVersion).toBe("coffee.diary.export.v1");
    expect(data.beans).toHaveLength(1);
    expect(data.extractions[0].recipeSnapshot.fields[0].value).toBe(25);

    const history = page.getByTestId("coffee-diary-history");
    await history.getByRole("button", { name: "Удалить" }).click();
    await expect(page.getByTestId("action-confirmation")).toBeVisible();
    await page.getByTestId("action-confirmation").getByRole("button", { name: "Удалить запись" }).click();
    await expect(history).toContainText("Приготовлений пока нет.");
    await page.getByRole("button", { name: "Удалить" }).last().click();
    await expect(page.getByTestId("action-confirmation")).toBeVisible();
    await page.getByTestId("action-confirmation").getByRole("button", { name: "Убрать из коллекции" }).click();
    await expect(page.getByTestId("coffee-diary-empty")).toBeVisible();
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

    const collection = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { beans: BeanRecord[]; beanCount: number };
    expect(collection.beanCount).toBe(1);
    await removeBean(page, collection.beans[0]);
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
    await expect(page.getByRole("button", { name: "Сохранить" }).last()).toBeEnabled();
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Потерянный ответ зерна");
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);

    const collection = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { beans: BeanRecord[]; beanCount: number };
    expect(collection.beanCount).toBe(1);
    await removeBean(page, collection.beans[0]);
    await page.unroute("**/api/v1/coffee-diary/beans");
  });

  test("blocks a rapid extraction double-submit with one POST", async ({ page }) => {
    await page.goto("/coffee-diary");
    const bean = await seedBean(page, "Двойное касание приготовления", "e2e-seed-extraction-double");
    await page.reload();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Двойное касание приготовления");
    await page.getByTestId("coffee-diary-detail").getByRole("button", { name: "Добавить" }).click();

    const keys: string[] = [];
    let resolvePostStarted!: () => void;
    const postStarted = new Promise<void>((resolve) => { resolvePostStarted = resolve; });
    await page.route("**/api/v1/coffee-diary/beans/*/extractions", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"] ?? "");
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
    expect(keys).toHaveLength(1);

    const detail = await page.request.get(`/api/v1/coffee-diary/beans/${bean.id}`).then((response) => response.json()) as { bean: BeanRecord; extractions: ExtractionRecord[] };
    expect(detail.extractions).toHaveLength(1);
    expect(detail.extractions[0].beanId).toBe(bean.id);
    await removeExtraction(page, detail.extractions[0]);
    await removeBean(page, bean);
    await page.unroute("**/api/v1/coffee-diary/beans/*/extractions");
  });

  test("reuses an extraction key after a committed response is lost", async ({ page }) => {
    await page.goto("/coffee-diary");
    const bean = await seedBean(page, "Потерянный ответ приготовления", "e2e-seed-extraction-loss");
    await page.reload();
    await page.getByTestId("coffee-diary-detail").getByRole("button", { name: "Добавить" }).click();

    const keys: string[] = [];
    await page.route("**/api/v1/coffee-diary/beans/*/extractions", async (route) => {
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
    await expect(page.getByTestId("coffee-diary-extraction-sheet")).toBeVisible();
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-extraction-sheet")).toHaveCount(0);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);

    const detail = await page.request.get(`/api/v1/coffee-diary/beans/${bean.id}`).then((response) => response.json()) as { bean: BeanRecord; extractions: ExtractionRecord[] };
    expect(detail.extractions).toHaveLength(1);
    expect(detail.extractions[0].beanId).toBe(bean.id);
    await removeExtraction(page, detail.extractions[0]);
    await removeBean(page, bean);
    await page.unroute("**/api/v1/coffee-diary/beans/*/extractions");
  });

  test("interaction lock prevents diary mutation requests", async ({ page }) => {
    test.skip(process.env.VITE_TOUCH_INPUT_LOCK_ENABLED !== "true", "Focused lock gate enables the shared Interaction Lock.");
    await page.goto("/coffee-diary");
    await expect(page.getByTestId("route-coffee-diary")).toBeVisible();
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
    await expect(page.getByTestId("coffee-diary-bean-sheet")).toBeVisible();
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
    await page.getByTestId("coffee-diary-bean-numeric-0").click();
    await expect(page.getByTestId("coffee-diary-bean-numeric-keypad")).toBeVisible();
    const shortTargets = await page.locator(".coffee-diary-page button, .coffee-diary-sheet button").evaluateAll((elements) => elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.height >= 48 ? [] : [{ text: element.textContent?.trim(), height: rect.height }];
    }));
    expect(shortTargets, JSON.stringify(shortTargets)).toEqual([]);
    await page.getByRole("button", { name: "Отмена" }).last().click();
  });

  test("reconciles stale edit and delete conflicts without retrying mutations", async ({ page }) => {
    await page.goto("/coffee-diary");
    await expect(page.getByTestId("route-coffee-diary")).toBeVisible();
    await page.getByTestId("coffee-diary-add-bean").click();
    await page.getByTestId("coffee-diary-input-name").fill("Конфликтное зерно");
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Конфликтное зерно");

    const collection = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { beans: Array<{ id: string; version: number }> };
    const bean = collection.beans[0];
    expect(bean).toMatchObject({ version: 1 });
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

    patchRequests.length = 0;
    await page.getByRole("button", { name: "Изменить" }).click();
    await expect(page.getByTestId("coffee-diary-input-name")).toHaveValue("Каноническая версия");
    await page.getByTestId("coffee-diary-input-name").fill("Каноническая версия · подтверждено");
    await page.getByRole("button", { name: "Сохранить" }).last().click();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Каноническая версия · подтверждено");
    expect(patchRequests).toEqual(['"2"']);

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
