import { describe, expect, it } from "vitest";
import {
  boundedLiteralTaskTitle,
  TASK_TITLE_MAX_LENGTH,
  taskMutationBodyFromPreview,
  taskMutationBodyFromUndatedTitle
} from "./taskMutationBody";

describe("task mutation body ownership", () => {
  it("includes the canonical parser priority for create", () => {
    expect(taskMutationBodyFromPreview("create", {
      title: "Купить продукты",
      priority: "none",
      due_date: "2026-08-14",
      due_time: null,
      timezone: null
    })).toEqual({
      title: "Купить продукты",
      priority: "none",
      due_date: "2026-08-14",
      due_time: null,
      timezone: null
    });
  });

  it("omits parser-default priority and unrelated canonical fields for edit", () => {
    const body = taskMutationBodyFromPreview("edit", {
      title: "Отправить отчёт",
      priority: "none",
      notes: null,
      project_id: null,
      due_date: "2026-08-14",
      due_time: null,
      timezone: null
    });
    expect(body).toEqual({
      title: "Отправить отчёт",
      due_date: "2026-08-14",
      due_time: null,
      timezone: null
    });
    expect(body).not.toHaveProperty("priority");
    expect(body).not.toHaveProperty("notes");
    expect(body).not.toHaveProperty("project_id");
  });

  it("keeps explicit timed edit fields together", () => {
    expect(taskMutationBodyFromPreview("edit", {
      title: "Позвонить",
      priority: "none",
      due_date: "2026-08-14",
      due_time: "18:30",
      timezone: "Europe/Moscow"
    })).toEqual({
      title: "Позвонить",
      due_date: "2026-08-14",
      due_time: "18:30",
      timezone: "Europe/Moscow"
    });
  });

  it("accepts a bounded literal title for an explicit undated create", () => {
    expect(taskMutationBodyFromUndatedTitle("create", "  Разобрать входящие  ")).toEqual({
      title: "Разобрать входящие",
      due_date: null,
      due_time: null,
      timezone: null,
      priority: "none"
    });
  });

  it("does not interpret or strip words from an undated literal title", () => {
    expect(taskMutationBodyFromUndatedTitle("create", " разобрать входящие без срока ")?.title)
      .toBe("разобрать входящие без срока");
  });

  it("rejects blank and overlong undated titles", () => {
    expect(taskMutationBodyFromUndatedTitle("create", " \t\n ")).toBeNull();
    expect(taskMutationBodyFromUndatedTitle("create", "x".repeat(TASK_TITLE_MAX_LENGTH + 1))).toBeNull();
    expect(boundedLiteralTaskTitle(`  ${"я".repeat(TASK_TITLE_MAX_LENGTH)}  `)).toHaveLength(TASK_TITLE_MAX_LENGTH);
  });

  it("keeps the strict null due shape and does not add create-only priority to edits", () => {
    expect(taskMutationBodyFromUndatedTitle("edit", "Без срока — буквальный текст")).toEqual({
      title: "Без срока — буквальный текст",
      due_date: null,
      due_time: null,
      timezone: null
    });
  });

  it("does not carry a dated preview into the explicit undated body", () => {
    const datedPreview = taskMutationBodyFromPreview("create", {
      title: "Разобрать входящие",
      priority: "high",
      due_date: "2026-08-14",
      due_time: "18:30",
      timezone: "Europe/Moscow"
    });

    expect(taskMutationBodyFromUndatedTitle("create", "Разобрать входящие")).toEqual({
      title: "Разобрать входящие",
      due_date: null,
      due_time: null,
      timezone: null,
      priority: "none"
    });
    expect(datedPreview).toMatchObject({ due_date: "2026-08-14", due_time: "18:30", timezone: "Europe/Moscow" });
  });

  it("keeps date-only and timed parser previews unchanged", () => {
    expect(taskMutationBodyFromPreview("create", {
      title: "Купить продукты",
      priority: "none",
      due_date: "2026-08-14",
      due_time: null,
      timezone: null
    })).toEqual({
      title: "Купить продукты",
      priority: "none",
      due_date: "2026-08-14",
      due_time: null,
      timezone: null
    });
    expect(taskMutationBodyFromPreview("create", {
      title: "Отправить отчёт",
      priority: "none",
      due_date: "2026-08-14",
      due_time: "18:30",
      timezone: "Europe/Moscow"
    })).toEqual({
      title: "Отправить отчёт",
      priority: "none",
      due_date: "2026-08-14",
      due_time: "18:30",
      timezone: "Europe/Moscow"
    });
  });
});
