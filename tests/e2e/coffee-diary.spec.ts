import { expect, test } from "@playwright/test";

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
