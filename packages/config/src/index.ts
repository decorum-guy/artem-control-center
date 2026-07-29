export const fixtureScenarios = [
  "ha-healthy",
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
