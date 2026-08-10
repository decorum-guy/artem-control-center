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

  it("uses simple shared confirmation for Stage, coffee and kettle boil", () => {
    for (const actionId of [
      "avalar.stage.restart",
      "avalar.stage.deploy",
      "home.coffee.turn_on",
      "home.kettle.boil"
    ] as const) {
      expect(actionConfirmationCatalog[actionId].level).toBe("simple");
      expect(actionConfirmationCatalog[actionId].requiredPhrase).toBeUndefined();
    }
  });

  it("does not put smoke or stop actions in the confirmation catalog", () => {
    expect("avalar.stage.smoke" in actionConfirmationCatalog).toBe(false);
    expect("avalar.main.smoke" in actionConfirmationCatalog).toBe(false);
    expect("home.coffee.turn_off" in actionConfirmationCatalog).toBe(false);
    expect("home.kettle.stop" in actionConfirmationCatalog).toBe(false);
  });
});
