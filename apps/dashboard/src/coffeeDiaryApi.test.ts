import { describe, expect, it, vi } from "vitest";
import { CoffeeDiaryApiError, parseCoffeeDiaryBean, parseCoffeeDiaryExport, parseCoffeeDiaryExtraction, patchCoffeeDiaryFavorite } from "./coffeeDiaryApi";
import { coffeeDiaryApiMessage } from "./coffeeDiaryMessages";

const bean = {
  id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  name: "Эфиопия",
  grindDescription: "Чуть мельче среднего",
  preferredDrink: "espresso",
  roaster: null,
  roastDate: null,
  roastLevel: null,
  roastNotes: null,
  origin: null,
  processing: null,
  notes: "Шоколад и ягоды",
  favoriteExtractionId: null,
  photoIds: [],
  createdAt: "2026-08-28T10:00:00Z",
  updatedAt: "2026-08-28T10:00:00Z",
  deletedAt: null
};

const extraction = {
  id: "22222222-2222-4222-8222-222222222222",
  version: 1,
  beanId: bean.id,
  brewedAt: "2026-08-28T10:00:00Z",
  doseGrams: 17.5,
  extractionSeconds: 27,
  yieldGrams: 36.0,
  notes: "Сладко, хороший баланс",
  rating: null,
  createdAt: "2026-08-28T10:00:00Z",
  updatedAt: "2026-08-28T10:00:00Z",
  deletedAt: null
};

describe("coffee diary API contracts", () => {
  it("accepts the v1 export and preserves favourite and photo relationships", () => {
    const parsed = parseCoffeeDiaryExport({
      schemaVersion: "coffee.diary.export.v1",
      sourceSchemaVersion: "coffee.diary.v1",
      revision: 2,
      updatedAt: "2026-08-28T10:00:00Z",
      beans: [{ ...bean, favoriteExtractionId: extraction.id }],
      extractions: [extraction],
      photos: []
    });
    expect(parsed.beans[0]?.grindDescription).toBe("Чуть мельче среднего");
    expect(parsed.beans[0]?.favoriteExtractionId).toBe(extraction.id);
    expect(parsed.photos).toEqual([]);
  });

  it("rejects the removed recipe-first shape and invalid gram precision", () => {
    expect(() => parseCoffeeDiaryBean({ ...bean, defaultRecipe: null })).toThrow("invalid_bean");
    expect(() => parseCoffeeDiaryExtraction({ ...extraction, doseGrams: 17.15 })).toThrow("invalid_extraction_dose_grams");
  });

  it("rejects export payloads above the bounded collection size", () => {
    expect(() => parseCoffeeDiaryExport({
      schemaVersion: "coffee.diary.export.v1",
      sourceSchemaVersion: "coffee.diary.v1",
      revision: 1,
      updatedAt: "2026-08-28T10:00:00Z",
      beans: [bean],
      extractions: [],
      photos: Array.from({ length: 2_001 }, () => ({
        id: "33333333-3333-4333-8333-333333333333",
        beanId: bean.id,
        storageId: "photo",
        mediaType: "image/jpeg",
        byteSize: 100,
        width: 10,
        height: 10,
        sha256: "a".repeat(64),
        createdAt: "2026-08-28T10:00:00Z",
        deletedAt: null
      }))
    })).toThrow("invalid_coffee_diary_export");
  });

  it("sends the fixed favourite mutation with If-Match and a nullable UUID body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(bean), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await patchCoffeeDiaryFavorite(bean.id, 4, null);
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/coffee-diary/beans/${bean.id}/favorite-extraction`, expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ extractionId: null }),
      headers: expect.objectContaining({ "If-Match": '"4"' })
    }));
    vi.unstubAllGlobals();
  });

  it("maps stable API codes to truthful Russian messages", () => {
    expect(coffeeDiaryApiMessage(new CoffeeDiaryApiError(409, "coffee_diary_idempotency_key_reused")))
      .toBe("Повторная команда с другим содержимым отклонена.");
    expect(coffeeDiaryApiMessage(new CoffeeDiaryApiError(422, "coffee_diary_grams_precision_invalid")))
      .toBe("Укажите вес с точностью до 0,1 г.");
  });
});
