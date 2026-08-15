import { describe, expect, it } from "vitest";
import {
  isTrustedPlanningModuleDefinition,
  planningModuleForId,
  planningModuleRegistry,
  planningModuleMutationCapabilitiesAreFalse,
  planningNavigationModules,
  planningModuleForRoute,
  trustedPlanningIconNames,
  type PlanningModuleDefinition
} from "./planningModuleRegistry";
import { planningModuleEnabled } from "./planningRouteConfig";

const syntheticReviewModule = {
  id: "planning.synthetic-review",
  route: "/synthetic-review",
  label: "Синтетический обзор",
  icon: "calendar",
  domain: "overview",
  rollout: "overview",
  freshnessSource: "planning.snapshot",
  capabilities: {
    read: true,
    create: false,
    update: false,
    complete: false,
    cancel: false,
    delete: false
  },
  futureMutationCapabilities: [],
  navigation: false
} as const satisfies PlanningModuleDefinition;

describe("trusted Planning module registry", () => {
  it("registers the three route modules and the compact Overview contribution", () => {
    expect(planningModuleRegistry.map((module) => module.id)).toEqual([
      "planning.calendar-agenda",
      "planning.tasks",
      "planning.reminders-monitoring",
      "planning.overview-summary"
    ]);
    expect(planningNavigationModules.map((module) => [module.route, module.label])).toEqual([
      ["/calendar", "Календарь"],
      ["/tasks", "Задачи"],
      ["/reminders", "Напоминания"]
    ]);
  });

  it("keeps ids/routes unique, icons trusted, and all PR9 mutations false", () => {
    const ids = planningModuleRegistry.map((module) => module.id);
    const routes = planningModuleRegistry.map((module) => module.route).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(routes).size).toBe(routes.length);
    expect(planningModuleRegistry.every((module) => trustedPlanningIconNames.includes(module.icon as typeof trustedPlanningIconNames[number]))).toBe(true);
    expect(planningModuleRegistry.every(planningModuleMutationCapabilitiesAreFalse)).toBe(true);
  });

  it("preserves the existing independent rollout gates", () => {
    expect(planningModuleForRoute("/tasks")?.rollout).toBe("tasks");
    expect(planningModuleForRoute("/calendar")?.rollout).toBe("calendar");
    expect(planningModuleForRoute("/reminders")?.rollout).toBe("reminders");
    expect(planningModuleEnabled(planningModuleForRoute("/tasks")!)).toBe(false);
    expect(planningModuleEnabled(planningModuleForRoute("/calendar")!)).toBe(false);
    expect(planningModuleEnabled(planningModuleForRoute("/reminders")!)).toBe(false);
  });

  it("accepts a source-controlled read-only future module without exposing it to navigation", () => {
    expect(isTrustedPlanningModuleDefinition(syntheticReviewModule)).toBe(true);
    expect(syntheticReviewModule.navigation).toBe(false);
    expect(planningModuleForId("planning.synthetic-review")).toBeNull();
    expect(planningNavigationModules.some((module) => String(module.route) === syntheticReviewModule.route)).toBe(false);
  });

  it("does not crash when a bounded module lacks a capability", () => {
    const moduleWithoutCreate = { ...syntheticReviewModule, capabilities: { ...syntheticReviewModule.capabilities, create: false } };
    expect(() => planningModuleMutationCapabilitiesAreFalse(moduleWithoutCreate)).not.toThrow();
    expect(planningModuleMutationCapabilitiesAreFalse(moduleWithoutCreate)).toBe(true);
  });
});
