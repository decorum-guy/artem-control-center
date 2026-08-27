import { describe, expect, it } from "vitest";
import { reminderLocalDateTime, reminderUtcFromLocal } from "./reminderMutationBody";

const reminder = {
  id: "00000000-0000-4000-8000-000000000001",
  version: 1,
  source: "alice" as const,
  sourceLabel: "AliceTG Bot",
  title: "Напоминание",
  dueAtUtc: "2026-08-13T12:00:00Z",
  timezone: "Europe/Moscow",
  status: "pending" as const,
  deliveryState: "not_due" as const,
  createdAt: "2026-08-12T09:00:00Z",
  updatedAt: "2026-08-12T09:00:00Z"
};

describe("explicit reminder scheduling fields", () => {
  it("initializes canonical due time in the reminder timezone", () => {
    expect(reminderLocalDateTime(reminder)).toEqual({ date: "2026-08-13", time: "15:00" });
  });

  it("converts one explicit wall-clock value back to canonical UTC", () => {
    expect(reminderUtcFromLocal("2026-08-13", "15:00", "Europe/Moscow")).toBe("2026-08-13T12:00:00Z");
  });

  it("rejects invalid timezone or date/time fields", () => {
    expect(reminderUtcFromLocal("2026-08-13", "вечер", "Europe/Moscow")).toBeNull();
    expect(reminderUtcFromLocal("2026-08-13", "15:00", "Not/AZone")).toBeNull();
  });
});
