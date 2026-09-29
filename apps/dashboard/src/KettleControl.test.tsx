import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ServiceSnapshot } from "@artem/contracts";
import { AccessProvider } from "./AccessControls";
import { InteractionLockProvider } from "./InteractionLock";
import { NoticeCenterProvider } from "./NoticeCenter";
import { KettleControl, kettleTeaLabels } from "./KettleControl";
import { executeHomeAssistantAction, HOME_KETTLE_BOIL, HOME_KETTLE_SET_TEA_MODE } from "./homeAssistantControlApi";

const kettle = (overrides: Record<string, unknown> = {}): ServiceSnapshot => ({
  id: "kettle", title: "Чайник", enabled: true, dataContract: "home.kettle.v1",
  health: "healthy", source: "fixture", summary: "Выключен", actions: [],
  data: { stage: "off", entityId: "water_heater.kukhnia_chainik", authority: "home-assistant", available: true,
    currentTemperature: 61, targetTemperature: 100, operationMode: "off", availableTeaModes: Object.keys(kettleTeaLabels),
    observedAt: "2026-09-29T00:00:00Z", stale: false, ...overrides }
});
function markup(service: ServiceSnapshot): string {
  return renderToStaticMarkup(<InteractionLockProvider><AccessProvider><NoticeCenterProvider><KettleControl service={service} /></NoticeCenterProvider></AccessProvider></InteractionLockProvider>);
}

describe("KettleControl", () => {
  it("shows current water temperature and bounded Russian status", () => {
    const html = markup(kettle());
    expect(html).toContain('data-testid="kettle-current-temperature"');
    expect(html).toContain('>61°</div>');
    expect(html).toContain("Выключен");
    expect(html).toContain("Включить");
    expect(html).toContain("Выбрать чай");
    expect(markup(kettle({ currentTemperature: null, targetTemperature: 100 }))).toContain('>—°</div>');
    expect(markup(kettle({ stage: "on", operationMode: "green_tea" }))).toContain("Зелёный чай");
    expect(markup(kettle({ stage: "on", operationMode: "on" }))).toContain("Нагрев до 100°");
    expect(markup(kettle({ stage: "on", operationMode: "unknown" }))).toContain("Состояние неизвестно");
  });
  it("has exactly the eight bounded tea labels", () => {
    expect(Object.values(kettleTeaLabels)).toEqual(["Белый чай", "Зелёный чай", "Красный чай", "Травяной чай", "Цветочный чай", "Пуэр", "Улун", "Чёрный чай"]);
    expect(markup(kettle())).not.toContain("<select");
  });
});

describe("typed kettle request serialization", () => {
  it("sends only ID and UUID for boil, and only allowlisted mode for tea", async () => {
    const original = globalThis.fetch;
    const requests: unknown[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({ status: "confirmed" }) } as Response;
    }) as typeof fetch;
    try {
      await executeHomeAssistantAction({ actionId: HOME_KETTLE_BOIL, requestId: "00000000-0000-4000-8000-000000000001" });
      await executeHomeAssistantAction({ actionId: HOME_KETTLE_SET_TEA_MODE, requestId: "00000000-0000-4000-8000-000000000002", teaMode: "green_tea" });
      expect(requests).toEqual([
        { actionId: HOME_KETTLE_BOIL, requestId: "00000000-0000-4000-8000-000000000001" },
        { actionId: HOME_KETTLE_SET_TEA_MODE, requestId: "00000000-0000-4000-8000-000000000002", teaMode: "green_tea" }
      ]);
    } finally { globalThis.fetch = original; }
  });
});
