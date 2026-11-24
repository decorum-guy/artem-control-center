import { expect, test } from "@playwright/test";

test.skip(process.env.VITE_V2_VISUAL_SHELL !== "true", "Music settings use the V2 shell");

test("music settings separate the source track, recording choice and YouTube confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const endpoint = "**/api/v1/station/music-save";
  const operationId = "a".repeat(32);
  const status = {
    connection: "connected",
    channel: "@test",
    destination: "Понравившаяся музыка",
    canChoose: true,
    busyEvents: 0
  };
  const options = [
    { id: "0", title: "First song", artist: "Test artist", duration: 160 },
    { id: "1", title: "Second song", artist: "Other artist", duration: 202 }
  ];
  let operation = { id: operationId, status: "choose_source", title: "", options };
  await page.route(endpoint, route => route.fulfill({ json: { ...status, operation } }));
  await page.route(endpoint + "/choose", async route => {
    const choice = route.request().postDataJSON();
    expect(choice.operationId).toBe(operationId);
    if (operation.status === "choose_source") {
      expect(choice).toMatchObject({ stage: "choose_source", choiceId: "1" });
      operation = {
        id: operationId, status: "choose_version", title: "Second song",
        options: [
          { id: "aaaaaaaaaaa", title: "Second song", artist: "Other artist", duration: 202 },
          { id: "bbbbbbbbbbb", title: "Second song (Live)", artist: "Other artist", duration: 235 }
        ]
      };
    } else {
      expect(choice).toMatchObject({ stage: "choose_version", choiceId: "aaaaaaaaaaa" });
      operation = { id: operationId, status: "youtube_like", title: "Second song", options: [] };
    }
    await route.fulfill({ json: { ...status, operation } });
  });

  await page.goto("/settings");
  const card = page.getByTestId("music-save-settings");
  await expect(card.getByText(/Профиль подключён · @test/)).toBeVisible();
  await expect(card.getByRole("status")).toContainText("Какая песня играла");
  await card.getByRole("button", { name: /Second song/ }).click();
  await expect(card.getByRole("status")).toContainText("Какую запись сохранить");
  await expect(card.getByRole("button", { name: /Second song \(Live\).*3:55/ })).toBeVisible();
  await card.getByRole("button", { name: /Second song Other artist · 3:22/ }).click();
  await expect(card.getByRole("status")).toContainText("Лайк подтверждён в YouTube");
  await expect(card.getByRole("status")).not.toContainText("Песня появилась в понравившейся музыке");
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
  test(`Music settings reuses the login window and cancels at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const endpoint = "**/api/v1/music/youtube/connection";
    let current = { state: "idle", active: false, canConnect: true, canFocus: false, libraryStatus: "auth_required" };
    await page.route("**/api/v1/station/music-save", route => route.fulfill({ json: {
      connection: "connected", channel: "@test", destination: "Понравившаяся музыка", canChoose: true, busyEvents: 0
    } }));
    const actions: string[] = [];
    await page.route(endpoint, route => route.fulfill({ json: current }));
    await page.route(endpoint + "/*", async route => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(request.headers()["x-panel-intent"]).toBe("youtube-connect");
      expect(request.postData()).toBeNull();
      const action = request.url().split("/").at(-1) ?? "";
      actions.push(action);
      if (action === "connect") current = { ...current, state: "sign_in", active: true, canFocus: true };
      if (action === "cancel") current = { ...current, state: "cancelled", active: false, canFocus: false };
      await route.fulfill({ json: current });
    });
    await page.goto("/settings");
    await page.getByTestId("music-save-settings").locator("summary").click();
    const connection = page.getByTestId("youtube-browser-connection");
    await connection.getByRole("button", { name: "Подключить YouTube Music" }).click();
    await expect(connection.getByRole("status")).toContainText("Войди в Google");
    const show = connection.getByRole("button", { name: "Показать окно входа" });
    await show.click();
    await show.click();
    await expect(connection.getByRole("status")).toContainText("закрой окно Edge");
    await connection.getByRole("button", { name: "Отменить" }).click();
    await expect(connection.getByRole("status")).toHaveText("Подключение отменено.");
    await expect(show).toHaveCount(0);
    expect(actions).toEqual(["connect", "focus", "focus", "cancel"]);
  });
}
