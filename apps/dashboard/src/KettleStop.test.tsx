import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ServiceSnapshot } from "@artem/contracts";
import { AccessProvider } from "./AccessControls";
import { InteractionLockProvider } from "./InteractionLock";
import { NoticeCenterProvider } from "./NoticeCenter";
import { KettleControl } from "./KettleControl";
import { executeHomeAssistantAction, HOME_KETTLE_STOP, type HomeAssistantActionRequest, type KettleActionId } from "./homeAssistantControlApi";

function markup(stage: "on" | "off", variant: "home" | "overview") {
  const service: ServiceSnapshot = {
    id: "kettle", title: "Чайник", enabled: true, dataContract: "home.kettle.v1",
    health: "healthy", source: "live", summary: "Чайник", actions: [],
    data: { stage, available: true, stale: false, operationMode: stage, currentTemperature: 61, targetTemperature: 80 }
  };
  return renderToStaticMarkup(<InteractionLockProvider><AccessProvider><NoticeCenterProvider>
    <KettleControl service={service} variant={variant} />
  </NoticeCenterProvider></AccessProvider></InteractionLockProvider>);
}

describe("kettle stop", () => {
  for (const variant of ["home", "overview"] as const) {
    it(`switches the ${variant} primary action from boil to stop while active`, () => {
      expect(markup("off", variant)).toContain("Включить");
      expect(markup("off", variant)).not.toContain("Остановить");
      expect(markup("on", variant)).toContain("Остановить");
      expect(markup("on", variant)).not.toContain("Включить");
      expect(markup("on", variant)).toContain("Выбрать чай");
    });
  }

  it("is a typed no-value kettle action and serializes exactly ID plus UUID", async () => {
    const actionId: KettleActionId = HOME_KETTLE_STOP;
    const requestId = "00000000-0000-4000-8000-000000000003";
    const request: HomeAssistantActionRequest = { actionId, requestId };
    // @ts-expect-error STOP cannot accept a temperature.
    const invalid: HomeAssistantActionRequest = { actionId: HOME_KETTLE_STOP, requestId, temperature: 100 };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ status: "confirmed" }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      await executeHomeAssistantAction(request);
      await executeHomeAssistantAction(invalid);
      for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
        expect(call[0]).toBe("/api/v1/actions/home-assistant");
        expect(JSON.parse(String(call[1].body))).toEqual({ actionId: HOME_KETTLE_STOP, requestId });
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
