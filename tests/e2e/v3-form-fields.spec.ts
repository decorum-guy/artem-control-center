import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { unlockTouchLockIfNeeded } from "./touch-lock-test-helpers";

const observedAt = "2026-11-25T12:00:00Z";
const generation = "c".repeat(32);

// These fixtures expose the real editors without storing settings, reminders,
// tasks, or playback commands. Every non-GET API request is intercepted below.
async function formFixtures(page: Page) {
  const writes: string[] = [];
  await page.clock.setFixedTime(new Date(observedAt));
  await page.addInitScript(() => {
    localStorage.setItem("artem-control-center.accent", "rose");
  });
  await page.route("**/api/**", (route) => {
    if (new URL(route.request().url()).pathname === "/api/v1/system/runtime/kiosk-presence") {
      return route.fulfill({ status: 204 });
    }
    if (route.request().method() !== "GET") {
      writes.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ status: 405, json: { detail: "visual_fixture_read_only" } });
    }
    return route.fallback();
  });
  const getOnly = (json: unknown) => async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json });
  };
  await page.route("**/api/v1/station/reminders", getOnly({
    status: "fresh", observedAt, canCreate: true, canReschedule: true,
    canEdit: true, canDelete: true, voiceTargetConfigured: true,
    items: [{
      id: "a".repeat(64), version: "b".repeat(64), title: "Тестовое напоминание",
      dueAt: "2026-11-26T18:30:00+03:00", timezone: "Europe/Moscow",
      repeats: false, scheduleMode: "once", delivery: "station"
    }]
  }));
  await page.route("**/api/v1/settings/ai", getOnly({
    schemaVersion: "ai.provider-settings.v1", revision: 4, available: true,
    enabled: true, writesEnabled: true, selectedProvider: "gigachat", warnings: [],
    providers: [{ id: "gigachat", model: "GigaChat-2", models: ["GigaChat-2"],
      credentialPresent: false, configured: false, state: "not_configured" }]
  }));
  await page.route("**/api/v1/music/**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) return route.fulfill({ json: { generation, status: "ready", canPlay: true } });
    const items = path.endsWith("/catalog")
      ? [{ key: path.includes("/yandex/") ? "likes" : "LM", title: "Мне нравится", kind: "liked", cover: null, count: 1 }]
      : [{ key: "1".repeat(32), trackId: "1", title: "Тестовый трек", artist: "Тестовый исполнитель",
        album: "Тестовый альбом", duration: 181, cover: null, playable: true }];
    return route.fulfill({ json: { generation, items, next: null, observedAt } });
  });
  await page.route("**/api/v1/access", getOnly({
    schemaVersion: 1, revision: 1, baseProfile: "standard", effectiveProfile: "standard",
    temporaryFull: false, temporaryFullExpiresAt: null, pinConfigured: true, lockoutUntil: null,
    confirmationPolicy: { actionConfirmationRequired: true, mode: "profile_default" },
    capabilities: { "todoist.tasks.write": { capability: "todoist.tasks.write", minimumProfile: "standard",
      effectiveProfile: "standard", allowed: true, availability: "allowed" } }
  }));
  await page.route("**/api/v1/todoist/**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) return route.fulfill({ json: {
      provider: "todoist", enabled: true, configured: true, activeSource: "todoist", writesEnabled: true
    } });
    return route.fulfill({ json: {
      provider: "todoist", activeSource: "todoist", generatedAt: observedAt, lastSyncedAt: observedAt,
      results: path.endsWith("/projects") ? [{ id: "fixture-project", name: "Тестовый проект" }] : [], nextCursor: null
    } });
  });
  return writes;
}

async function fieldStyles(field: Locator) {
  await field.scrollIntoViewIfNeeded();
  await field.focus();
  // Programmatic focus after a pointer action need not match :focus-visible.
  // Enter through keyboard navigation before measuring the focus treatment.
  await field.press("Tab");
  await field.page().keyboard.press("Shift+Tab");
  await expect(field).toBeFocused();
  return field.evaluate((element) => {
    const style = getComputedStyle(element);
    const placeholder = getComputedStyle(element, "::placeholder");
    const resolveColor = (token: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      element.parentElement!.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const box = element.getBoundingClientRect();
    return {
      tag: element.tagName, type: element.getAttribute("type"), height: box.height,
      radius: style.borderRadius, background: style.backgroundColor, text: style.color,
      focus: style.outlineColor, focusWidth: style.outlineWidth, focusStyle: style.outlineStyle,
      focusOffset: style.outlineOffset, placeholder: placeholder.color,
      placeholderOpacity: placeholder.opacity, hasPlaceholder: element.hasAttribute("placeholder"),
      animation: style.animationName, transition: style.transitionDuration, colorScheme: style.colorScheme,
      tokens: {
        radius: style.getPropertyValue("--cc-radius-control").trim(),
        background: resolveColor(element.classList.contains("cc-select") ? "--cc-interactive" : "--cc-surface-2"),
        text: resolveColor("--cc-text"), muted: resolveColor("--cc-text-muted"), focus: resolveColor("--cc-focus")
      }
    };
  });
}

async function expectField(field: Locator, name: string, observations: Record<string, unknown>, theme: string) {
  await expect(field, name).toBeVisible();
  const styles = await fieldStyles(field);
  observations[name] = styles;
  expect.soft(styles.height, `${name}: touch height`).toBeGreaterThanOrEqual(48);
  expect.soft(styles.radius, `${name}: radius`).toBe(styles.tokens.radius);
  expect.soft(styles.background, `${name}: surface`).toBe(styles.tokens.background);
  expect.soft(styles.text, `${name}: text`).toBe(styles.tokens.text);
  expect.soft(styles.focusWidth, `${name}: focus width`).toBe("3px");
  expect.soft(styles.focusOffset, `${name}: focus offset`).toBe("2px");
  expect.soft(styles.focusStyle, `${name}: focus style`).toBe("solid");
  expect.soft(styles.focus, `${name}: focus accent`).toBe(styles.tokens.focus);
  expect.soft(styles.colorScheme, `${name}: native controls`).toBe(theme === "day" ? "light" : "dark");
  expect.soft(styles.animation, `${name}: reduced motion`).toBe("none");
  expect.soft(styles.transition, `${name}: reduced transition`).toBe("0s");
  if (styles.hasPlaceholder) {
    expect.soft(styles.placeholder, `${name}: placeholder`).toBe(styles.tokens.muted);
    expect.soft(styles.placeholderOpacity, `${name}: placeholder opacity`).toBe("1");
  }
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
    sheets: Array.from(document.querySelectorAll<HTMLElement>(".cc-overlay__body"))
      .map((node) => node.scrollWidth - node.clientWidth)
  }));
  expect.soft(overflow.document).toBeLessThanOrEqual(1);
  expect.soft(overflow.body).toBeLessThanOrEqual(1);
  for (const amount of overflow.sheets) expect.soft(amount).toBeLessThanOrEqual(1);
}

test.describe("V3 form surfaces with synthetic fixtures", () => {
  test.skip(process.env.VITE_V3_VISUAL_SKIN !== "true", "Requires the V3 fixture profile");

  for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 1280 }]) {
    for (const theme of ["night", "day"]) {
      test(`${theme} at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
        const writes = await formFixtures(page);
        const observations: Record<string, unknown> = {};
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: "reduce" });
        const open = async (path: string) => {
          await page.goto(`${path}?theme=${theme}&motion=reduced`);
          await unlockTouchLockIfNeeded(page);
          await expect(page.locator("html")).toHaveAttribute("data-skin", "v3");
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expect(page.locator("html")).toHaveAttribute("data-accent", "rose");
          await page.evaluate(() => document.fonts.ready);
        };
        const capture = async (name: string) => {
          await expectNoHorizontalOverflow(page);
          await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
        };
        const inspectReminder = async (name: string) => {
          const editor = page.getByTestId("alice-reminder-editor");
          for (const label of ["О чём напомнить", "Дата", "Время (МСК)"]) {
            await expectField(editor.getByLabel(label, { exact: true }), `${name}: ${label}`, observations, theme);
          }
          await expectField(editor.locator(".cc-select"), `${name}: Повтор`, observations, theme);
          await editor.getByLabel("О чём напомнить", { exact: true }).focus();
          await capture(name);
        };

        await open("/reminders");
        const reminders = page.getByRole("region", { name: "Напоминания Алисы" });
        await reminders.getByRole("button", { name: "Добавить", exact: true }).click();
        await inspectReminder("reminder-create");
        await page.getByTestId("alice-reminder-editor").locator(".cc-select").click();
        await expect(page.getByRole("listbox", { name: "Повтор" })).toBeVisible();
        await capture("reminder-repeat");
        await page.getByRole("option", { name: "Каждый день", exact: true }).click();
        await expect(page.getByTestId("alice-reminder-editor").locator(".cc-select")).toContainText("Каждый день");
        await page.getByTestId("alice-reminder-editor").getByRole("button", { name: "Закрыть", exact: true }).click();
        await reminders.getByRole("button", { name: "Изменить", exact: true }).click();
        await inspectReminder("reminder-edit");

        await open("/music");
        const music = page.getByRole("region", { name: "Яндекс Музыка", exact: true });
        const search = music.getByRole("searchbox");
        await expect(search).toBeEnabled();
        await expectField(search, "music search", observations, theme);
        await capture("music-search");

        await open("/settings");
        await page.getByTestId("settings-summary-ai").click();
        await expectField(page.getByTestId("ai-credential-input"), "settings credential", observations, theme);
        await capture("settings-credential");

        await open("/tasks");
        await page.getByRole("button", { name: "Новая задача", exact: true }).click();
        await expectField(page.getByLabel("Название", { exact: true }), "task title", observations, theme);
        await expectField(page.getByLabel("Описание", { exact: true }), "task description", observations, theme);
        await capture("task-description");

        const computedPath = testInfo.outputPath("computed-fields.json");
        await writeFile(computedPath, JSON.stringify(observations, null, 2));
        await testInfo.attach("computed-fields.json", { path: computedPath, contentType: "application/json" });
        expect(writes).toEqual([]);
      });
    }
  }
});
