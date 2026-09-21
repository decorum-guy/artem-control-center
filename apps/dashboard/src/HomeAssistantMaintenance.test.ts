import { describe, expect, it } from "vitest";
import { HOME_SERVER_BOT_RESTART, HOME_SERVER_CADDY_RESTART, HA_RESTART, HA_UPDATE_CORE, type MaintenanceOperation } from "./homeAssistantMaintenanceApi";
import { maintenanceActionCopy, maintenanceOperationActive } from "./HomeAssistantMaintenance";

describe("Home server maintenance presentation", () => {
  it("uses a distinct progress message for each fixed target", () => {
    expect(maintenanceActionCopy(HA_RESTART)).toEqual({ title: "Home Assistant", progress: "Перезапускаем Home Assistant…" });
    expect(maintenanceActionCopy(HA_UPDATE_CORE).progress).toBe("Проверяем и обновляем Home Assistant…");
    expect(maintenanceActionCopy(HOME_SERVER_CADDY_RESTART)).toEqual({ title: "Caddy", progress: "Перезапускаем Caddy…" });
    expect(maintenanceActionCopy(HOME_SERVER_BOT_RESTART)).toEqual({ title: "Telegram Bot", progress: "Перезапускаем Telegram-бота…" });
  });

  it("unlocks the next action after either terminal state", () => {
    const base = { requestId: "request", actionId: HA_RESTART, failureCode: null };
    expect(maintenanceOperationActive({ ...base, status: "dispatching" })).toBe(true);
    expect(maintenanceOperationActive({ ...base, status: "success" })).toBe(false);
    expect(maintenanceOperationActive({ ...base, status: "failed" } as MaintenanceOperation)).toBe(false);
  });
});
