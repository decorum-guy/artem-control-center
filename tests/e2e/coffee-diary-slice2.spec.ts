import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";

const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

type BeanRecord = {
  id: string;
  version: number;
  name: string;
  photoIds: string[];
  deletedAt: string | null;
};

type BeanDetail = { bean: BeanRecord; extractions: Array<{ id: string; version: number }> };
type UploadSession = { sessionId: string; uploadUrl: string; pendingAttachmentId: string | null; photoId: string | null };

function artifactDirectory(testInfo: TestInfo): string {
  const directory = process.env.COFFEE_DIARY_SLICE2_ARTIFACT_DIR ?? testInfo.outputPath("coffee-diary-slice2-review");
  mkdirSync(directory, { recursive: true });
  return directory;
}

async function clearDiary(page: Page): Promise<void> {
  const collection = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { beans: BeanRecord[] };
  for (const bean of collection.beans) {
    const detail = await page.request.get(`/api/v1/coffee-diary/beans/${bean.id}`).then((response) => response.json()) as BeanDetail;
    for (const extraction of detail.extractions) {
      await page.request.delete(`/api/v1/coffee-diary/extractions/${extraction.id}`, { headers: { "If-Match": `"${extraction.version}"` } });
    }
    const refreshed = await page.request.get(`/api/v1/coffee-diary/beans/${bean.id}`).then((response) => response.json()) as BeanDetail;
    await page.request.delete(`/api/v1/coffee-diary/beans/${bean.id}`, { headers: { "If-Match": `"${refreshed.bean.version}"` } });
  }
}

async function seedBean(page: Page, name: string): Promise<BeanRecord> {
  const response = await page.request.post("/api/v1/coffee-diary/beans", {
    headers: { "Idempotency-Key": `slice2-${Date.now()}-${Math.random().toString(16).slice(2)}` },
    data: { name, grindDescription: "Средний помол", preferredDrink: "universal", notes: null }
  });
  expect(response.status()).toBe(201);
  return await response.json() as BeanRecord;
}

async function uploadFromMobile(page: Page, uploadUrl: string, browser: Browser): Promise<void> {
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const mobilePage = await mobileContext.newPage();
  try {
    await mobilePage.goto(uploadUrl);
    await expect.poll(() => new URL(mobilePage.url()).hash).toBe("");
    await expect(mobilePage.getByRole("heading", { name: "Фото кофе" })).toBeVisible();
    const overflow = await mobilePage.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      bodyWidth: document.body.scrollWidth
    }));
    expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
    expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
    await mobilePage.getByTestId("coffee-upload-file").setInputFiles({ name: "coffee.png", mimeType: "image/png", buffer: PNG_FIXTURE });
    await expect(mobilePage.getByTestId("coffee-upload-preview")).toBeVisible();
    await mobilePage.getByTestId("coffee-upload-submit").click();
    await expect(mobilePage.getByRole("status")).toContainText("Фото загружено");
  } finally {
    await mobileContext.close();
  }
}

async function uploadFromMobileWithResponseLoss(uploadUrl: string, browser: Browser): Promise<void> {
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const mobilePage = await mobileContext.newPage();
  let firstUpload = true;
  await mobilePage.route("**/api/v1/coffee-diary/photo-upload", async (route) => {
    if (!firstUpload) {
      await route.continue();
      return;
    }
    firstUpload = false;
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.abort("failed");
  });
  try {
    await mobilePage.goto(uploadUrl);
    await expect.poll(() => new URL(mobilePage.url()).hash).toBe("");
    await expect(mobilePage.getByRole("heading", { name: "Фото кофе" })).toBeVisible();
    await mobilePage.getByTestId("coffee-upload-file").setInputFiles({ name: "coffee.png", mimeType: "image/png", buffer: PNG_FIXTURE });
    await expect(mobilePage.getByTestId("coffee-upload-preview")).toBeVisible();
    await mobilePage.getByTestId("coffee-upload-submit").click();
    await expect(mobilePage.getByRole("alert")).toHaveText("Ответ сервера не получен. Можно повторить загрузку — фото не будет добавлено дважды.");
    await expect(mobilePage.getByTestId("coffee-upload-preview")).toBeVisible();
    await mobilePage.getByTestId("coffee-upload-submit").click();
    await expect(mobilePage.getByRole("status")).toContainText("Фото загружено");
    expect(firstUpload).toBe(false);
  } finally {
    await mobileContext.close();
  }
}

test.describe("Coffee Diary Slice 2", () => {
  test.beforeEach(async ({ page }) => { await clearDiary(page); });
  test.afterEach(async ({ page }) => { await clearDiary(page); });

  test("uploads a photo from the mobile QR page to an exact existing bean", async ({ page, browser }, testInfo) => {
    const bean = await seedBean(page, "Кения · QR");
    const before = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { photos: Array<{ id: string; beanId: string }> };
    await page.goto("/coffee-diary");
    await expect(page.getByTestId("coffee-diary-detail")).toContainText(bean.name);

    const sessionResponse = page.waitForResponse((response) => response.url().includes("/photo-upload-sessions") && response.request().method() === "POST");
    await page.getByTestId("coffee-diary-detail").getByRole("button", { name: "Прикрепить фото" }).click();
    const session = await (await sessionResponse).json() as UploadSession;
    expect(new URL(session.uploadUrl).search).toBe("");
    expect(new URL(session.uploadUrl).hash).toMatch(/^#token=[A-Za-z0-9_-]{43,}$/);
    await expect(page.getByTestId("coffee-diary-qr")).toBeVisible();
    await page.screenshot({ path: join(artifactDirectory(testInfo), "coffee-diary-qr-dialog.png"), animations: "disabled" });

    await uploadFromMobile(page, session.uploadUrl, browser);
    await expect(page.getByTestId("coffee-diary-photo-upload-dialog")).toContainText("Фото прикреплено");
    await expect(page.getByTestId("coffee-diary-photos").locator("img")).toHaveCount(1);
    await page.reload();
    await expect(page.getByTestId("coffee-diary-photos").locator("img")).toHaveCount(1);

    const collection = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { beans: BeanRecord[]; photos: Array<{ id: string; beanId: string; mediaType: string }> };
    const saved = collection.beans.find((candidate) => candidate.id === bean.id);
    expect(saved?.photoIds).toHaveLength(1);
    expect(collection.photos).toHaveLength(before.photos.length + 1);
    expect(collection.photos.filter((photo) => photo.beanId === bean.id)).toEqual([expect.objectContaining({ mediaType: "image/png" })]);
  });

  test("replays an existing-bean upload after the browser loses the committed response", async ({ page, browser }) => {
    const bean = await seedBean(page, "Кения · потеря ответа");
    const before = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { photos: Array<{ id: string; beanId: string }> };
    await page.goto("/coffee-diary");
    const sessionResponse = page.waitForResponse((response) => response.url().includes("/photo-upload-sessions") && response.request().method() === "POST");
    await page.getByTestId("coffee-diary-detail").getByRole("button", { name: "Прикрепить фото" }).click();
    const session = await (await sessionResponse).json() as UploadSession;
    await uploadFromMobileWithResponseLoss(session.uploadUrl, browser);

    const collection = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { beans: BeanRecord[]; photos: Array<{ id: string; beanId: string }> };
    expect(collection.beans.find((candidate) => candidate.id === bean.id)?.photoIds).toHaveLength(1);
    expect(collection.photos).toHaveLength(before.photos.length + 1);
    expect(collection.photos.filter((photo) => photo.beanId === bean.id)).toHaveLength(1);
  });

  test("stages a new-bean photo, claims it atomically, and exposes CSV and ZIP exports", async ({ page, browser }) => {
    await page.goto("/coffee-diary");
    await page.getByTestId("coffee-diary-add-bean").click();
    await page.getByTestId("coffee-diary-input-name").fill("Эфиопия · staged QR");

    const sessionResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/coffee-diary/photo-upload-sessions") && response.request().method() === "POST");
    await page.getByTestId("coffee-diary-bean-sheet").getByRole("button", { name: "Прикрепить фото" }).click();
    const session = await (await sessionResponse).json() as UploadSession;
    await uploadFromMobile(page, session.uploadUrl, browser);
    await expect(page.getByTestId("coffee-diary-staged-previews")).toHaveCount(1);

    await page.getByRole("button", { name: "Сохранить" }).click();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Эфиопия · staged QR");
    await expect(page.getByTestId("coffee-diary-photos").locator("img")).toHaveCount(1);
    await page.reload();
    await expect(page.getByTestId("coffee-diary-photos").locator("img")).toHaveCount(1);

    const csvDownload = page.waitForEvent("download");
    await page.getByTestId("coffee-diary-export-csv").click();
    expect((await csvDownload).suggestedFilename()).toBe("coffee-diary-extractions.csv");
    const zipDownload = page.waitForEvent("download");
    await page.getByTestId("coffee-diary-export-zip").click();
    expect((await zipDownload).suggestedFilename()).toBe("coffee-diary.zip");
  });

  test("replays a staged upload after the browser loses the committed response", async ({ page, browser }) => {
    const before = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { photos: Array<{ id: string; beanId: string }> };
    await page.goto("/coffee-diary");
    await page.getByTestId("coffee-diary-add-bean").click();
    await page.getByTestId("coffee-diary-input-name").fill("Эфиопия · потеря ответа");

    const sessionResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/coffee-diary/photo-upload-sessions") && response.request().method() === "POST");
    await page.getByTestId("coffee-diary-bean-sheet").getByRole("button", { name: "Прикрепить фото" }).click();
    const session = await (await sessionResponse).json() as UploadSession;
    await uploadFromMobileWithResponseLoss(session.uploadUrl, browser);
    await expect(page.getByTestId("coffee-diary-staged-previews")).toHaveCount(1);

    await page.getByRole("button", { name: "Сохранить" }).click();
    await expect(page.getByTestId("coffee-diary-detail")).toContainText("Эфиопия · потеря ответа");
    await expect(page.getByTestId("coffee-diary-photos").locator("img")).toHaveCount(1);
    const collection = await page.request.get("/api/v1/coffee-diary").then((response) => response.json()) as { beans: BeanRecord[]; photos: Array<{ id: string; beanId: string }> };
    const bean = collection.beans.find((candidate) => candidate.name === "Эфиопия · потеря ответа");
    expect(bean?.photoIds).toHaveLength(1);
    expect(collection.photos).toHaveLength(before.photos.length + 1);
    expect(collection.photos.filter((photo) => photo.beanId === bean?.id)).toHaveLength(1);
  });

  test("does not create an upload session while the shared interaction lock is engaged", async ({ page }) => {
    test.skip(process.env.VITE_TOUCH_INPUT_LOCK_ENABLED !== "true", "Focused lock gate enables the shared Interaction Lock.");
    await seedBean(page, "Locked QR");
    await page.goto("/coffee-diary");
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("photo-upload-sessions") && request.method() === "POST") requests.push(request.method());
    });
    await page.getByTestId("interaction-lock-control").hover();
    await page.mouse.down();
    await page.waitForTimeout(1_100);
    await page.mouse.up();
    await expect(page.getByTestId("interaction-lock-status")).toBeVisible();
    await page.getByTestId("coffee-diary-detail").getByRole("button", { name: "Прикрепить фото" }).click();
    expect(requests).toEqual([]);
  });
});
