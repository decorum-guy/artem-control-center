import { describe, expect, it } from "vitest";
import type { DeviceVisibilitySettings, ServiceSnapshot } from "@artem/contracts";
import { visiblePresentationServices } from "./deviceVisibilityPresentation";

function service(id: string, dataContract: string): ServiceSnapshot {
  return { id, title: id, enabled: true, dataContract, health: "healthy", source: "fixture", summary: "fixture", actions: [], data: {} };
}

const visibleSettings: DeviceVisibilitySettings = {
  schemaVersion: "device.visibility.v1", revision: 0, updatedAt: "now", available: true, warnings: [], writesEnabled: true,
  devices: [{ key: "kettle", label: "Чайник", defaultVisible: true, visible: true }]
};

describe("device visibility presentation projection", () => {
  it("hides only the registered kettle and keeps unknown devices", () => {
    const kettle = service("kettle", "home.kettle.v1");
    const coffee = service("coffee-machine", "home.coffee-machine.v1");
    const unknown = service("kettle-copy", "home.kettle.v1");
    expect(visiblePresentationServices([kettle, coffee, unknown], { ...visibleSettings, devices: [{ ...visibleSettings.devices[0], visible: false }] }).map((item) => item.id)).toEqual(["coffee-machine", "kettle-copy"]);
  });

  it("fails open to the deterministic visible default when settings are unavailable", () => {
    const kettle = service("kettle", "home.kettle.v1");
    expect(visiblePresentationServices([kettle], null)).toEqual([kettle]);
    expect(visiblePresentationServices([kettle], { ...visibleSettings, available: false, warnings: ["stored_device_visibility_unavailable"], devices: [{ ...visibleSettings.devices[0], visible: false }] })).toEqual([kettle]);
  });
});
