import { describe, expect, it } from "vitest";
import type { ServiceSnapshot } from "@artem/contracts";
import {
  classifySystemService,
  countHealth,
  groupHealthyServices,
  healthLabel,
  selectHomePrimaryDevices,
  selectSystemServiceSubjects,
  servicesByAttention,
  systemRelevantServices,
  trustedServiceGroup,
  visibleSystemServices
} from "./routeDensity";

function service(
  id: string,
  overrides: Partial<ServiceSnapshot> = {}
): ServiceSnapshot {
  return {
    id,
    title: id,
    enabled: true,
    dataContract: "service.health.v1",
    health: "healthy",
    source: "fixture",
    summary: "fixture",
    actions: [],
    data: {},
    ...overrides
  };
}

describe("PR7 route density helpers", () => {
  it("orders offline before degraded/stale and healthy while preserving equal-state order", () => {
    const ordered = servicesByAttention([
      service("healthy-a"),
      service("stale-a", { health: "stale" }),
      service("offline-a", { health: "offline" }),
      service("degraded-a", { health: "degraded" }),
      service("offline-b", { health: "offline" }),
      service("healthy-b")
    ]);
    expect(ordered.map((item) => item.id)).toEqual([
      "offline-a",
      "offline-b",
      "stale-a",
      "degraded-a",
      "healthy-a",
      "healthy-b"
    ]);
  });

  it("groups only healthy services by trusted group and keeps missing group in the safe System fallback", () => {
    const groups = groupHealthyServices([
      service("home", { presentation: { category: "home-infrastructure", group: "Home infrastructure", overview: "aggregate", priority: 10 } }),
      service("unknown", { presentation: undefined }),
      service("attention", { health: "degraded", presentation: { category: "system", group: "System", overview: "incident-only", priority: 20 } })
    ]);
    expect(groups.get("Home infrastructure")?.map((item) => item.id)).toEqual(["home"]);
    expect(groups.get("System")?.map((item) => item.id)).toEqual(["unknown"]);
    expect(trustedServiceGroup(service("missing-group"))).toBe("System");
  });

  it("selects Coffee and Kettle without manufacturing a peer for sparse Home snapshots", () => {
    const coffee = service("coffee", { dataContract: "home.coffee-machine.v1", presentation: { category: "home-device", group: "Home infrastructure", overview: "primary", priority: 100 } });
    const kettle = service("kettle", { dataContract: "home.kettle.v1", presentation: { category: "home-device", group: "Home infrastructure", overview: "quick-control", priority: 70 }, data: { stage: "off" } });
    const lamp = service("lamp", { presentation: { category: "home-device", group: "Home infrastructure", overview: "quick-control", priority: 60 }, data: { stage: "on" } });

    expect(selectHomePrimaryDevices([coffee]).fallback).toBeNull();
    expect(selectHomePrimaryDevices([coffee]).additional).toEqual([]);
    expect(selectHomePrimaryDevices([coffee, kettle, lamp])).toMatchObject({
      coffee,
      kettle,
      fallback: null,
      additional: [lamp]
    });
    expect(selectHomePrimaryDevices([lamp])).toMatchObject({ fallback: lamp, additional: [] });
  });

  it("classifies only trusted system contracts and explicit System categories", () => {
    expect(classifySystemService(service("rog_g703gi", { dataContract: "system.rog-g703.v1" }))).toBe("rog");
    expect(classifySystemService(service("runtime", { dataContract: "system.runtime.v1" }))).toBe("runtime");
    expect(classifySystemService(service("update", { dataContract: "system.update.v1" }))).toBe("update");
    expect(classifySystemService(service("backup", { dataContract: "backup.snapshot.v1" }))).toBe("backup");
    expect(classifySystemService(service("diagnostic", { dataContract: "service.health.v1", presentation: { category: "system", group: "System", overview: "incident-only", priority: 20 } }))).toBe("system");
    expect(classifySystemService(service("new-service", { dataContract: "future.service.v1" }))).toBe("other");
  });

  it("does not promote unknown ID substrings into System semantics", () => {
    expect(classifySystemService(service("future-runtime-proxy", { dataContract: "future.service.v1" }))).toBe("other");
    expect(classifySystemService(service("backup-helper-unknown", { dataContract: "future.service.v1" }))).toBe("other");
    expect(classifySystemService(service("my-update-monitor", { dataContract: "future.service.v1" }))).toBe("other");
    expect(classifySystemService(service("something-rog-like", { dataContract: "future.service.v1" }))).toBe("other");
  });

  it("keeps every System aggregate contributor represented by a primary subject or diagnostic row", () => {
    const fixtureDiagnostic = service("fixture-multi-action", {
      dataContract: "service.health.v1",
      health: "degraded",
      presentation: { category: "system", group: "System", overview: "incident-only", priority: 20 }
    });
    const runtime = service("panel-runtime", {
      dataContract: "system.runtime.v1",
      health: "degraded",
      summary: "Runtime requires attention",
      presentation: { category: "system", group: "System", overview: "aggregate", priority: 75 }
    });
    const subjects = selectSystemServiceSubjects([fixtureDiagnostic, runtime]);
    const represented = visibleSystemServices(subjects);

    expect(systemRelevantServices([fixtureDiagnostic, runtime]).map((item) => item.id)).toEqual([
      "panel-runtime",
      "fixture-multi-action"
    ]);
    expect(represented.map((item) => item.id)).toEqual(["panel-runtime", "fixture-multi-action"]);
    expect(represented.filter((item) => item.health !== "healthy").map((item) => item.id)).toEqual([
      "panel-runtime",
      "fixture-multi-action"
    ]);
    expect(subjects.diagnostics.map((item) => item.id)).toEqual(["fixture-multi-action"]);
  });

  it("uses the bounded Russian health vocabulary", () => {
    expect(healthLabel("healthy")).toBe("В норме");
    expect(healthLabel("degraded")).toBe("Требует внимания");
    expect(healthLabel("stale")).toBe("Данные устарели");
    expect(healthLabel("offline")).toBe("Недоступен");
  });

  it("counts only the supplied subject", () => {
    expect(countHealth([
      service("a"),
      service("b", { health: "offline" }),
      service("c", { health: "stale" })
    ])).toEqual({ healthy: 1, degraded: 0, stale: 1, offline: 1 });
  });
});
