import { expect, test } from "@playwright/test";

function accessStatus(profile: "standard" | "full") {
  return {
    schemaVersion: 1,
    revision: profile === "full" ? 2 : 1,
    baseProfile: profile,
    effectiveProfile: profile,
    temporaryFull: false,
    temporaryFullExpiresAt: null,
    pinConfigured: true,
    lockoutUntil: null,
    capabilities: {}
  };
}

test("full access PIN can be entered entirely with the on-screen keypad", async ({ page }) => {
  let profile: "standard" | "full" = "standard";
  let submittedPin: string | null = null;

  await page.route("**/api/v1/access**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === "/api/v1/access" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(accessStatus(profile))
      });
      return;
    }

    if (url.pathname === "/api/v1/access/profile" && request.method() === "PATCH") {
      const payload = request.postDataJSON() as { profile?: string; pin?: string };
      submittedPin = payload.pin ?? null;
      if (payload.profile !== "full" || payload.pin !== "1234") {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ detail: "invalid_pin" })
        });
        return;
      }
      profile = "full";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(accessStatus(profile))
      });
      return;
    }

    await route.continue();
  });

  await page.goto("/settings");
  await page.getByRole("radio", { name: /Полный доступ/ }).click();

  const dialog = page.getByRole("dialog", { name: "Включить полный доступ" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("input")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Разблокировать" })).toBeDisabled();

  for (const digit of ["1", "2", "3", "4"]) {
    await dialog.getByRole("button", { name: digit, exact: true }).click();
  }

  await expect(dialog.getByRole("status", { name: "Введено цифр: 4" })).toBeVisible();
  await expect(dialog.locator(".pin-dots")).toHaveText("● ● ● ●");
  await expect(dialog.getByRole("button", { name: "Разблокировать" })).toBeEnabled();

  await dialog.getByRole("button", { name: "Удалить последнюю цифру" }).click();
  await expect(dialog.getByRole("status", { name: "Введено цифр: 3" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Разблокировать" })).toBeDisabled();

  await dialog.getByRole("button", { name: "4", exact: true }).click();
  await dialog.getByRole("button", { name: "Разблокировать" }).click();

  expect(submittedPin).toBe("1234");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Сейчас: Полный доступ")).toBeVisible();
});
