import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceSnapshot } from "@artem/contracts";
import { AccessProvider } from "./AccessControls";
import { ClimateControl } from "./ClimateControl";
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

  it("does not add an integration kicker to the Overview header", () => {
    expect(markup(climate(), "overview")).not.toContain("Дом · Home Assistant");
  });
});
