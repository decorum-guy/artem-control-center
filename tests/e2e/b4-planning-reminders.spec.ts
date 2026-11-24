import { expect, test } from "@playwright/test";
import { unlockTouchLockIfNeeded } from "./touch-lock-test-helpers";

test("native Alice reminders move and disappear on the opened page", async ({ page }) => {
  const target = {
    id: "synthetic-alice-reminder",
    title: "Тестовое напоминание Алисы",
    dueAt: "2026-11-26T16:00:00+03:00",
    timezone: "Europe/Moscow",
    repeats: false
  };
  let items = [target];
  const methods: string[] = [];
  await page.route("**/api/v1/station/reminders", (route) => {
    methods.push(route.request().method());
    return route.fulfill({ json: { status: "fresh", observedAt: "2026-11-24T00:35:00Z", items } });
  });
  await page.clock.install();
  await page.goto("/reminders");
  const alice = page.getByRole("region", { name: "Напоминания Алисы" });
  await expect(alice.getByText(target.title)).toBeVisible();
  await expect(alice.getByText("16:00", { exact: false })).toBeVisible();

  items = [{ ...target, dueAt: "2026-11-26T16:15:00+03:00" }];
  await page.clock.fastForward(11_000);
  await expect(alice.getByText("16:15", { exact: false })).toBeVisible();
  items = [];
  await page.clock.fastForward(11_000);
  await expect(alice.getByText(target.title)).toHaveCount(0);
  await expect(alice.getByText("Активных напоминаний Алисы нет.")).toBeVisible();
  expect(methods.length).toBeGreaterThanOrEqual(3);
  expect(new Set(methods)).toEqual(new Set(["GET"]));
});

test("only Alice controls are shown and reminder presets cross midnight in Moscow", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-24T20:45:00Z"));
  const observedAt = "2026-11-24T20:45:00Z";
  const version = "b".repeat(64);
  const id = "a".repeat(64);
  const title = "Тестовый список";
  const changes: { method: string; dueLocal: string }[] = [];
  let items: { id: string; title: string; dueAt: string; timezone: string; repeats: boolean; version: string }[] = [];

  await page.route(/\/api\/v1\/station\/reminders(?:\/[a-f0-9]+)?$/, (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      expect(request.headers()["x-panel-intent"]).toBe("station-reminders");
      const body = request.postDataJSON();
      changes.push({ method: request.method(), dueLocal: body.dueLocal });
      if (request.method() === "POST") expect(body.title).toBe(title);
      if (request.method() === "PATCH") expect(body.expectedVersion).toBe(version);
      items = [{ id, title, dueAt: `${body.dueLocal}:00+03:00`, timezone: "Europe/Moscow", repeats: false, version }];
    }
    return route.fulfill({ json: { status: "fresh", items, observedAt, canCreate: true, canReschedule: true } });
  });
  await page.goto("/reminders");
  await unlockTouchLockIfNeeded(page);
  const section = page.getByRole("region", { name: "Напоминания Алисы" });
  await section.getByRole("button", { name: "Добавить" }).click();
  const editor = page.getByTestId("alice-reminder-editor");
  await editor.getByLabel("О чём напомнить").fill(title);
  for (const [label, expected] of [["Через час", "00:45"], ["Через 2 часа", "01:45"], ["Через 3 часа", "02:45"], ["Через 30 минут", "00:15"]]) {
    await editor.getByRole("button", { name: label, exact: true }).click();
    await expect(editor.getByLabel("Дата")).toHaveValue("2026-11-25");
    await expect(editor.getByLabel("Время (МСК)")).toHaveValue(expected);
    await expect(editor.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  expect(changes).toHaveLength(0);
  await editor.getByRole("button", { name: "Сохранить" }).click();
  await expect(section.getByText(title)).toBeVisible();
  await expect(page.getByTestId("planning-reminder-mutation-gate")).toHaveCount(0);
  await expect(page.getByTestId("planning-reminder-list")).toHaveCount(0);
  await section.getByRole("button", { name: "Перенести" }).click();
  await editor.getByLabel("Дата").fill("2026-11-27");
  await editor.getByLabel("Время (МСК)").fill("18:20");
  await editor.getByRole("button", { name: "Сохранить" }).click();
  await expect(section.getByText("18:20", { exact: false })).toBeVisible();
  expect(changes).toEqual([
    { method: "POST", dueLocal: "2026-11-25T00:15" },
    { method: "PATCH", dueLocal: "2026-11-27T18:20" }
  ]);
});

for (const [state, response, label] of [
  ["404", { status: 404 }, "Источник Алисы не настроен"],
  ["legacy null", { json: null }, "Источник Алисы не настроен"],
  ["auth", { json: { status: "auth_required", items: [], observedAt: null } }, "Нужно восстановить вход в Яндекс"],
  ["failed", { status: 503 }, "Не удалось связаться с панелью"]
] as const) {
  test(`keeps Alice on /reminders after ${state}`, async ({ page }) => {
    const planningReads: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/v1/planning/reminders")) planningReads.push(request.url());
    });
    await page.route("**/api/v1/station/reminders", (route) => route.fulfill(response));
    await page.goto("/reminders");
    const native = page.getByRole("region", { name: "Напоминания Алисы" });
    await expect(native).toContainText(label);
    await expect(native.getByRole("button", { name: "Добавить" })).toHaveCount(0);
    await expect(page.getByTestId("planning-reminder-list")).toHaveCount(0);
    expect(planningReads).toEqual([]);
  });
}

test("states that the next occurrence is unknown for a recurring reminder", async ({ page }) => {
  await page.route("**/api/v1/station/reminders", (route) => route.fulfill({ json: {
    status: "fresh", observedAt: "2026-11-24T00:35:00Z", items: [
      { id: "a", title: "Повторяющееся напоминание", dueAt: null, timezone: "Europe/Moscow", repeats: true }
    ]
  } }));
  await page.goto("/reminders");
  const row = page.getByRole("region", { name: "Напоминания Алисы" }).getByRole("listitem");
  await expect(row).toContainText("Ближайшее время неизвестно");
  await expect(row.locator("time")).toHaveCount(0);
});
