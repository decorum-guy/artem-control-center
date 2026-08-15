import type { PlanningCapability, PlanningCapabilitySet } from "@artem/contracts";
import type { IconName } from "./icons";

export type PlanningRoutePath = "/calendar" | "/tasks" | "/reminders";
export type TrustedPlanningModuleRoute = PlanningRoutePath | "/synthetic-review";
export type PlanningModuleDomain = "calendar" | "tasks" | "reminders" | "overview";
export type PlanningRolloutGate = "calendar" | "tasks" | "reminders" | "overview";

export type PlanningModuleCapabilitySlots = PlanningCapabilitySet;

export interface PlanningOverviewContributionDescriptor {
  readonly slot: "Дела";
  readonly summaryKind: "canonical-reminder-task-calendar";
}

export interface PlanningModuleDefinition {
  readonly id: string;
  readonly route: TrustedPlanningModuleRoute | null;
  readonly label: string;
  readonly icon: IconName;
  readonly domain: PlanningModuleDomain;
  readonly rollout: PlanningRolloutGate;
  readonly freshnessSource: "planning.snapshot";
  readonly capabilities: PlanningModuleCapabilitySlots;
  readonly futureMutationCapabilities: readonly PlanningCapability[];
  readonly navigation: boolean;
  readonly overviewContribution?: PlanningOverviewContributionDescriptor;
}

const readOnlyPlanningCapabilities: PlanningModuleCapabilitySlots = {
  read: true,
  create: false,
  update: false,
  complete: false,
  cancel: false,
  delete: false
};

const noMutationCapabilities: readonly PlanningCapability[] = [];

/**
 * Closed, source-controlled Planning vocabulary. Registry entries are trusted
 * code: no browser/server config can provide a renderer, URL, icon, or action.
 */
export const planningModuleRegistry: readonly PlanningModuleDefinition[] = [
  {
    id: "planning.calendar-agenda",
    route: "/calendar",
    label: "Календарь",
    icon: "calendar",
    domain: "calendar",
    rollout: "calendar",
    freshnessSource: "planning.snapshot",
    capabilities: readOnlyPlanningCapabilities,
    futureMutationCapabilities: noMutationCapabilities,
    navigation: true
  },
  {
    id: "planning.tasks",
    route: "/tasks",
    label: "Задачи",
    icon: "tasks",
    domain: "tasks",
    rollout: "tasks",
    freshnessSource: "planning.snapshot",
    capabilities: readOnlyPlanningCapabilities,
    futureMutationCapabilities: noMutationCapabilities,
    navigation: true
  },
  {
    id: "planning.reminders-monitoring",
    route: "/reminders",
    label: "Напоминания",
    icon: "reminder",
    domain: "reminders",
    rollout: "reminders",
    freshnessSource: "planning.snapshot",
    capabilities: readOnlyPlanningCapabilities,
    futureMutationCapabilities: noMutationCapabilities,
    navigation: true
  },
  {
    id: "planning.overview-summary",
    route: null,
    label: "Дела",
    icon: "calendar",
    domain: "overview",
    rollout: "overview",
    freshnessSource: "planning.snapshot",
    capabilities: readOnlyPlanningCapabilities,
    futureMutationCapabilities: noMutationCapabilities,
    navigation: false,
    overviewContribution: {
      slot: "Дела",
      summaryKind: "canonical-reminder-task-calendar"
    }
  }
];

export const trustedPlanningIconNames = ["calendar", "tasks", "reminder"] as const satisfies readonly IconName[];

function isPlanningRoutePath(route: TrustedPlanningModuleRoute | null): route is PlanningRoutePath {
  return route === "/calendar" || route === "/tasks" || route === "/reminders";
}

export const planningRoutePaths = planningModuleRegistry
  .map((module) => module.route)
  .filter(isPlanningRoutePath);

export const planningNavigationModules = planningModuleRegistry.filter(
  (module) => module.navigation && isPlanningRoutePath(module.route)
) as readonly (PlanningModuleDefinition & { route: PlanningRoutePath })[];

export const planningOverviewModules = planningModuleRegistry.filter(
  (module) => Boolean(module.overviewContribution)
);

export function planningModuleForRoute(route: string): PlanningModuleDefinition | null {
  return planningModuleRegistry.find((module) => module.route === route) ?? null;
}

export function planningModuleForId(id: string): PlanningModuleDefinition | null {
  return planningModuleRegistry.find((module) => module.id === id) ?? null;
}

export function planningModuleHasCapability(
  module: PlanningModuleDefinition,
  capability: PlanningCapability
): boolean {
  return module.capabilities[capability];
}

export function planningModuleMutationCapabilitiesAreFalse(module: PlanningModuleDefinition): boolean {
  return module.futureMutationCapabilities.length === 0
    && !module.capabilities.create
    && !module.capabilities.update
    && !module.capabilities.complete
    && !module.capabilities.cancel
    && !module.capabilities.delete;
}

export function isTrustedPlanningModuleDefinition(module: PlanningModuleDefinition): boolean {
  return module.id.startsWith("planning.")
    && (module.route === null || module.route === "/calendar" || module.route === "/tasks" || module.route === "/reminders" || module.route === "/synthetic-review")
    && new Set<string>(trustedPlanningIconNames).has(module.icon)
    && ["calendar", "tasks", "reminders", "overview"].includes(module.domain)
    && ["calendar", "tasks", "reminders", "overview"].includes(module.rollout)
    && module.freshnessSource === "planning.snapshot"
    && module.futureMutationCapabilities.every((capability) => ["create", "update", "complete", "cancel", "delete"].includes(capability));
}
