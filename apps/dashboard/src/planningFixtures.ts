import type { PlanningSnapshot } from "@artem/contracts";

/** Contract-only fixture; B1 intentionally does not render this block. */
export const emptyPlanningFixture: PlanningSnapshot = {
  schemaVersion: "planning.panel.v1",
  generatedAt: "2026-08-12T09:00:00Z",
  sourceStatus: "offline",
  lastSyncedAt: null,
  staleAfter: null,
  reminders: { upcoming: [], overdue: [], deliveryFailures: [] },
  tasks: { today: [], overdue: [], upcoming: [], projects: [] },
  calendar: { today: [], upcoming: [], conflicts: [] },
  capabilities: {
    create: false,
    edit: false,
    complete: false,
    cancel: false,
    delete: false,
    voice: false,
    providerSync: false
  },
  providerStatuses: [
    {
      id: "native-planning",
      label: "Local Planning",
      status: "local_only",
      configured: true,
      lastSyncedAt: null
    }
  ]
};
