import { describe, expect, it } from "vitest";
import { canonicalCreateBodyIdentity, createCoffeeDiaryCreateAttempt } from "./coffeeDiaryCreateAttempt";

describe("coffee diary create attempts", () => {
  it("generates once, reuses after transport uncertainty, and rotates after a body change", () => {
    const keys = ["key-1", "key-2"];
    const attempt = createCoffeeDiaryCreateAttempt(() => keys.shift() ?? "unexpected-key");
    const first = attempt.begin({ name: "Эфиопия", grindDescription: "Средний помол", preferredDrink: "espresso", notes: null });
    expect(first?.key).toBe("key-1");
    attempt.release();
    expect(attempt.begin({ name: "Эфиопия", grindDescription: "Средний помол", preferredDrink: "espresso", notes: null })?.key).toBe("key-1");
    attempt.release();
    expect(attempt.begin({ name: "Эфиопия", grindDescription: "Мельче", preferredDrink: "espresso", notes: null })?.key).toBe("key-2");
  });

  it("blocks a second concurrent begin synchronously and resets after success", () => {
    const keys = ["key-1", "key-2"];
    const attempt = createCoffeeDiaryCreateAttempt(() => keys.shift() ?? "unexpected-key");
    expect(attempt.begin({ name: "Эфиопия" })?.key).toBe("key-1");
    expect(attempt.isPending()).toBe(true);
    expect(attempt.begin({ name: "Эфиопия" })).toBeNull();
    attempt.complete();
    expect(attempt.isPending()).toBe(false);
    expect(attempt.begin({ name: "Эфиопия" })?.key).toBe("key-2");
  });

  it("canonicalizes object ordering and scopes extraction identity to its bean", () => {
    expect(canonicalCreateBodyIdentity({ b: 2, a: 1 })).toBe(canonicalCreateBodyIdentity({ a: 1, b: 2 }));
    const shot = { brewedAt: "2026-08-28T10:00:00Z", doseGrams: 17.5, extractionSeconds: 27, yieldGrams: 36.0, notes: "Баланс", rating: null, makeFavorite: false };
    expect(canonicalCreateBodyIdentity(shot, "bean-a")).toBe(canonicalCreateBodyIdentity({ ...shot }, "bean-a"));
    expect(canonicalCreateBodyIdentity(shot, "bean-a")).not.toBe(canonicalCreateBodyIdentity(shot, "bean-b"));
    expect(canonicalCreateBodyIdentity(shot, "bean-a")).not.toBe(canonicalCreateBodyIdentity({ ...shot, doseGrams: 18 }, "bean-a"));
    expect(canonicalCreateBodyIdentity(shot, "bean-a")).not.toBe(canonicalCreateBodyIdentity({ ...shot, makeFavorite: true }, "bean-a"));
  });

  it("retains a key through a failed response but gives a new session a new key", () => {
    const keys = ["key-1", "key-2"];
    const attempt = createCoffeeDiaryCreateAttempt(() => keys.shift() ?? "unexpected-key");
    const first = attempt.begin({ name: "Эфиопия" });
    attempt.release();
    expect(attempt.current()).toEqual(first);
    attempt.complete();
    expect(attempt.begin({ name: "Эфиопия" })?.key).toBe("key-2");
  });
});
