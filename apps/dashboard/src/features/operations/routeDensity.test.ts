import { describe, expect, it } from "vitest";
import type { ServiceSnapshot } from "@artem/contracts";
import {
  classifySystemService,
  countHealth,
  groupHealthyServices,
  healthLabel,
  selectHomePrimaryDevices,
  servicesByAttention,
  trustedServiceGroup
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

  it("classifies only explicit system contracts into System zones", () => {
    expect(classifySystemService(service("rog_g703gi", { dataContract: "system.rog-g703.v1" }))).toBe("rog");
    expect(classifySystemService(service("runtime", { dataContract: "system.runtime.v1" }))).toBe("runtime");
    expect(classifySystemService(service("backup", { dataContract: "backup.snapshot.v1" }))).toBe("backup");
    expect(classifySystemService(service("new-service", { dataContract: "future.service.v1" }))).toBe("other");
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
