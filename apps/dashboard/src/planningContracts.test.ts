import { describe, expect, it } from "vitest";
import { emptyPlanningFixture } from "./planningFixtures";

describe("Planning snapshot contract", () => {
  it("keeps the B1 fixture hidden/read-only at the typed boundary", () => {
    expect(emptyPlanningFixture.schemaVersion).toBe("planning.panel.v1");
    expect(emptyPlanningFixture.sourceStatus).toBe("offline");
    expect(emptyPlanningFixture.capabilities).toEqual({
      create: false,
      edit: false,
      complete: false,
      cancel: false,
      delete: false,
      voice: false,
      providerSync: false,
      tasks: {
        create: false,
        edit: false,
        complete: false,
        archive: false
      },
      calendar: {
        create: false,
        edit: false,
        delete: false
      }
    });
    expect(emptyPlanningFixture.reminders.upcoming).toHaveLength(0);
    expect(emptyPlanningFixture.taskMutationsEnabled).toBe(false);
    expect(emptyPlanningFixture.calendarMutationsEnabled).toBe(false);
    expect(emptyPlanningFixture.tasks.undated).toHaveLength(0);
    expect(emptyPlanningFixture.tasks.projects).toHaveLength(0);
    expect(emptyPlanningFixture.calendar.conflicts).toHaveLength(0);
  });
});
