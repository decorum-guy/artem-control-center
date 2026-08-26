import { describe, expect, it } from "vitest";
import { actionConfirmationCatalog } from "./actionConfirmationCatalog";

describe("action confirmation catalog", () => {
  it("keeps Main actions on strong production confirmation", () => {
    expect(actionConfirmationCatalog["avalar.main.restart"]).toMatchObject({
      level: "strong",
      tone: "production",
      requiredPhrase: "RESTART MAIN"
    });
    expect(actionConfirmationCatalog["avalar.main.deploy"]).toMatchObject({
      level: "strong",
      tone: "production",
      requiredPhrase: "DEPLOY MAIN"
    });
  });

  it("uses simple shared confirmation for Stage, coffee, kettle and ASUS hibernate", () => {
    for (const actionId of [
      "avalar.stage.restart",
      "avalar.stage.deploy",
      "home.coffee.turn_on",
      "home.kettle.boil",
      "system.rog_g703.hibernate"
    ] as const) {
      expect(actionConfirmationCatalog[actionId].level).toBe("simple");
      expect(actionConfirmationCatalog[actionId].requiredPhrase).toBeUndefined();
    }
    expect(actionConfirmationCatalog["system.rog_g703.hibernate"]).toMatchObject({
      title: "Перевести ASUS ROG G703GI в гибернацию?",
      target: "ASUS ROG G703GI",
      environment: "Windows"
    });
  });

  it("does not put smoke or stop actions in the confirmation catalog", () => {
    expect("avalar.stage.smoke" in actionConfirmationCatalog).toBe(false);
    expect("avalar.main.smoke" in actionConfirmationCatalog).toBe(false);
    expect("home.coffee.turn_off" in actionConfirmationCatalog).toBe(false);
    expect("home.kettle.stop" in actionConfirmationCatalog).toBe(false);
  });

  it("uses simple lifecycle confirmation for explicit reminder completion and cancellation", () => {
    expect(actionConfirmationCatalog["planning.reminders.complete"]).toMatchObject({
      level: "simple",
      title: "Явно завершить напоминание?",
      confirmLabel: "Завершить напоминание"
    });
    expect(actionConfirmationCatalog["planning.reminders.cancel"]).toMatchObject({
      level: "simple",
      title: "Явно отменить напоминание?",
      confirmLabel: "Отменить напоминание"
    });
    expect(actionConfirmationCatalog["planning.reminders.complete"].description).toContain("Доставка не меняет его статус");
    expect(actionConfirmationCatalog["planning.reminders.cancel"].description).toContain("Доставка не меняет его статус");
  });

  it("uses current shared confirmation for task completion and owner-facing archive", () => {
    expect(actionConfirmationCatalog["planning.tasks.complete"]).toMatchObject({
      level: "simple",
      title: "Завершить задачу?",
      confirmLabel: "Завершить задачу"
    });
    expect(actionConfirmationCatalog["planning.tasks.archive"].description).toBe("Задача исчезнет из активных списков.");
  });

  it("marks full panel shutdown as the only non-waivable confirmation", () => {
    expect(actionConfirmationCatalog["system.runtime.shutdown"]).toMatchObject({
      level: "simple",
      title: "Полностью закрыть панель?",
      confirmLabel: "Полностью закрыть",
      alwaysConfirm: true
    });
    const mandatory = Object.values(actionConfirmationCatalog)
      .filter((spec) => spec.alwaysConfirm)
      .map((spec) => spec.id);
    expect(mandatory).toEqual(["system.runtime.shutdown"]);
  });
});
