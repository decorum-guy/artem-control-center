import catalogJson from "../interface-copy-catalog.json";
import type { InterfaceCopyCatalog } from "@artem/contracts";

export const fixtureScenarios = [
  "ha-healthy",
  "home-normal",
  "home-coffee-only",
  "home-coffee-kettle",
  "home-no-coffee",
  "home-no-devices",
  "home-ha-stale",
  "home-ha-offline",
  "home-long-russian",
  "ha-degraded",
  "ha-offline",
  "coffee-off",
  "coffee-turning-on",
  "coffee-warming",
  "coffee-policy-changed",
  "coffee-ready",
  "coffee-running",
  "coffee-running-too-long",
  "coffee-long-running-threshold-changed",
  "coffee-turning-off",
  "coffee-stale",
  "kettle-on",
  "kettle-off",
  "kettle-unavailable",
  "alice-down-ha-healthy",
  "alice-down-policy-stale",
  "ha-offline-policy-available",
  "coffee-no-timing-policy"
] as const;

export type FixtureScenario = (typeof fixtureScenarios)[number];

export const interfaceCopyCatalog = catalogJson satisfies InterfaceCopyCatalog;
export type InterfaceCopyFixtureScenario =
  | "defaults-only"
  | "custom-navigation"
  | "custom-page-copy"
  | "removed-subtitle"
  | "revision-conflict"
  | "malformed"
  | "unavailable";

export const interfaceCopyFixtureScenarios: readonly InterfaceCopyFixtureScenario[] = [
  "defaults-only",
  "custom-navigation",
  "custom-page-copy",
  "removed-subtitle",
  "revision-conflict",
  "malformed",
  "unavailable"
];
