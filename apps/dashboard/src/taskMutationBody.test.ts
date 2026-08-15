import { describe, expect, it } from "vitest";
import { taskMutationBodyFromPreview } from "./taskMutationBody";

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
});
