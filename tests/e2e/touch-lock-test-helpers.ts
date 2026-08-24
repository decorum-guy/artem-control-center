import { expect, type Page } from "@playwright/test";

/** Unlocks only through the reviewed hold gesture used by the kiosk UI. */
export async function unlockTouchLockIfNeeded(page: Page): Promise<void> {
  const control = page.getByTestId("interaction-lock-control");
  if (await control.count() === 0) return;
  await expect(control).toBeVisible();
  if (await control.getAttribute("aria-pressed") !== "true") return;

  await control.focus();
  await page.keyboard.down("Space");
  await page.waitForTimeout(1_100);
  await page.keyboard.up("Space");
  await expect(control).toHaveAttribute("aria-pressed", "false");
}
