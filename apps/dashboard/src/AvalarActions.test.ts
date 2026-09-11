import { describe, expect, it } from "vitest";
import type { ServiceSnapshot } from "@artem/contracts";
import { actionsForService, titleForServiceAction } from "./AvalarActions";

function service(id: string, actions: ServiceSnapshot["actions"]): ServiceSnapshot {
  return {
    id,
    title: id,
    enabled: true,
    dataContract: "service.health.v1",
    health: "healthy",
    source: "live",
    summary: "Ready",
    actions,
    data: {}
  };
}

describe("AVALAR registry action materialization", () => {
  it("does not infer capabilities from a legacy service identity", () => {
    expect(actionsForService(service("avalar-site-stage", []))).toEqual([]);
  });

  it("uses explicit declared actions and their descriptor titles", () => {
    const stage = service("avalar.stage.website", [{
      id: "avalar.stage.smoke",
      title: "Smoke check",
      enabled: true,
      risk: "low"
    }]);

    expect(actionsForService(stage)).toEqual(["avalar.stage.smoke"]);
    expect(titleForServiceAction(stage, "avalar.stage.smoke")).toBe("Smoke check");
  });
});
