import { describe, expect, it } from "vitest";
import type { MaterializedWidget, ServiceSnapshot } from "@artem/contracts";
import { reconcileLayout, resolveManifest } from "./registry";

function service(id: string, dataContract = "service.health.v1"): ServiceSnapshot {
  return {
    id,
    title: id,
    enabled: true,
    dataContract,
    health: "healthy",
    source: "fixture",
    summary: "fixture",
    actions: [],
    data: {}
  };
}

describe("widget registry", () => {
  it("resolves coffee through the specialized manifest", () => {
    const manifest = resolveManifest(service("coffee-machine", "home.coffee-machine.v1"));
    expect(manifest.id).toBe("home.coffee-machine");
    expect(manifest.defaultSection).toBe("overview");
    expect(manifest.visualAsset).toEqual(expect.objectContaining({
      sourcePath: "./assets/widgets/coffee-machine.png",
      fit: "contain"
    }));
  });

  it("materializes unknown enabled services through generic fallback", () => {
    const widgets = reconcileLayout([service("new-service", "future.contract.v1")]);
    expect(widgets).toEqual([
      expect.objectContaining({
        serviceId: "new-service",
        manifestId: "core.generic-service",
        section: "new-items"
      })
    ]);
  });

  it("materializes a monitor-only declarative service without action chrome", () => {
    const declarative = service("external-api.production.api", "service.health.v1");
    const widgets = reconcileLayout([declarative]);

    expect(resolveManifest(declarative).id).toBe("core.generic-service");
    expect(declarative.actions).toEqual([]);
    expect(widgets[0]).toEqual(expect.objectContaining({
      serviceId: "external-api.production.api",
      manifestId: "core.generic-service"
    }));
  });

  it("preserves existing layout and adds registry updates", () => {
    const existing: MaterializedWidget[] = [
      {
        id: "custom-existing",
        serviceId: "existing",
        manifestId: "core.generic-service",
        section: "services",
        preserved: false
      }
    ];
    const widgets = reconcileLayout([service("existing"), service("new-service")], existing);
    expect(widgets[0]).toEqual(expect.objectContaining({ id: "custom-existing", preserved: true }));
    expect(widgets[1]).toEqual(expect.objectContaining({ serviceId: "new-service", preserved: false }));
  });
});
