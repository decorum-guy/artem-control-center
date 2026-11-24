import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceSnapshot } from "@artem/contracts";
import { AccessProvider } from "./AccessControls";
import { ClimateControl, coalesceClimate } from "./ClimateControl";
import { HOME_CLIMATE_POWER_OFF, HOME_CLIMATE_SET_FAN_MODE, HOME_CLIMATE_SET_MODE, HOME_CLIMATE_SET_TEMPERATURE } from "./homeAssistantControlApi";
import { InteractionLockProvider } from "./InteractionLock";
import { NoticeCenterProvider } from "./NoticeCenter";

const climate = (state: "off" | "heat" = "off", targetTemperature = 32): ServiceSnapshot => ({
  id: "climate-main",
  title: "Кондиционер",
  enabled: true,
  dataContract: "home.climate.v1",
  health: "healthy",
  source: "fixture",
  summary: "fixture",
  actions: [],
  data: {
    state,
    available: true,
    stale: false,
    targetTemperature,
    currentTemperature: null,
    hvacModes: ["cool", "heat", "fan_only", "dry", "auto", "off"],
    fanMode: "one",
    fanModes: ["one", "two", "three", "four", "five"]
  }
});

function markup(service: ServiceSnapshot, variant: "home" | "overview" = "home"): string {
  return renderToStaticMarkup(
    <InteractionLockProvider>
      <AccessProvider>
        <NoticeCenterProvider>
          <ClimateControl service={service} variant={variant} />
        </NoticeCenterProvider>
      </AccessProvider>
    </InteractionLockProvider>
  );
}

describe("ClimateControl compact presentation", () => {
  it("uses a neutral confirmed-off power toggle and no legacy temperature tiles", () => {
    const html = markup(climate());
    expect(html).toContain('data-power-state="off"');
    expect(html).toContain("climate-control__power--off");
    expect(html).toContain("32°");
    expect(html).toContain("climate-temperature-confirm-home");
    expect(html).not.toContain("В комнате");
    expect(html).not.toContain("Температура в комнате недоступна");
    expect(html).not.toContain("Цель</");
  });

  it("uses the confirmed-on accent state without adding power text", () => {
    const html = markup(climate("heat"));
    expect(html).toContain('data-power-state="on"');
    expect(html).toContain("climate-control__power--on");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Выключить кондиционер"');
  });

  it("renders all climate action buttons with icon children", () => {
    const html = markup(climate());
    const actionTestIds = [
      "climate-power-home",
      "climate-temperature-decrease-home",
      "climate-temperature-increase-home",
      "climate-temperature-confirm-home"
    ];

    for (const testId of actionTestIds) {
      const button = new RegExp(`<button[^>]*data-testid="${testId}"[\\s\\S]*?</button>`).exec(html)?.[0];
      expect(button).toBeDefined();
      expect(button).toContain('<svg');
      expect(button).toContain('viewBox="0 0 24 24"');
    }
    expect(html).not.toContain(">−</button>");
    expect(html).not.toContain(">+</button>");
  });

  it("does not add an integration kicker to the Overview header", () => {
    expect(markup(climate(), "overview")).not.toContain("Дом · Home Assistant");
  });
});

describe("climate waiting intentions", () => {
  it("keeps different parameters and discards commands behind a new shutdown", () => {
    const temperature = (value: number) => ({ id: HOME_CLIMATE_SET_TEMPERATURE, temperature: value });
    const fan = { id: HOME_CLIMATE_SET_FAN_MODE, fanMode: "two" as const };
    const mode = { id: HOME_CLIMATE_SET_MODE, mode: "heat" as const };
    const off = { id: HOME_CLIMATE_POWER_OFF };
    expect(coalesceClimate([temperature(21), fan], temperature(24))).toEqual([fan, temperature(24)]);
    expect(coalesceClimate([temperature(21), mode], temperature(24))).toEqual([temperature(21), mode, temperature(24)]);
    expect(coalesceClimate([fan, temperature(24), mode], off)).toEqual([off]);
  });
});
