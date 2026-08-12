import { describe, expect, it } from "vitest";
import { planningFixtures } from "./planningFixtures";
import {
  countOverdueTasks,
  formatCalendarEventTime,
  formatOverdueTaskCount,
  formatReminderDueLabel,
  formatReminderExactTime,
  planningHealthPresentation,
  selectNextCalendarEvent,
  selectNextReminder,
  selectPrimaryOverdueTask
} from "./planningOverview";

const fixtureNow = new Date("2026-08-12T12:00:00Z");

describe("Planning Overview selectors and presentation", () => {
  it("selects the canonical upcoming reminder and keeps exact time visible", () => {
    const reminder = selectNextReminder(planningFixtures.reminderSoon);
    expect(reminder?.title).toBe("Позвонить в сервис");
    expect(formatReminderDueLabel(reminder!, "current", fixtureNow)).toBe("через 40 мин");
    expect(formatReminderExactTime(reminder!)).toBe("15:40");
  });

  it("ignores completed/cancelled reminders and delivery failures", () => {
    expect(selectNextReminder(planningFixtures.completedCancelled)).toBeNull();
    expect(selectNextReminder(planningFixtures.deliveryFailure)?.title).toBe("Позвонить в сервис");
    expect(selectNextReminder(planningFixtures.deliveredOpen)?.deliveryState).toBe("delivered");
  });

  it("freezes reminder labels for stale and offline snapshots", () => {
    const reminder = selectNextReminder(planningFixtures.stale)!;
    const staleAtStart = formatReminderDueLabel(reminder, "stale", fixtureNow);
    const staleLater = formatReminderDueLabel(reminder, "stale", new Date("2026-08-12T12:20:00Z"));
    const offlineLater = formatReminderDueLabel(reminder, "offline", new Date("2026-08-12T12:20:00Z"));
    expect(staleAtStart).toBe("срок 15:40");
    expect(staleLater).toBe(staleAtStart);
    expect(offlineLater).toBe(staleAtStart);
    expect(staleLater).not.toMatch(/через/);
  });

  it("orders overdue tasks by high, normal, low, none and deterministic due/ID ties", () => {
    expect(selectPrimaryOverdueTask(planningFixtures.multipleOverdueTasks)?.title).toBe("Высокий приоритет");
    const first = planningFixtures.multipleOverdueTasks.tasks.overdue[0];
    const second = { ...first, id: "00000000-0000-4000-8000-000000000099", title: "Tie second" };
    const tieSnapshot = {
      ...planningFixtures.multipleOverdueTasks,
      tasks: { ...planningFixtures.multipleOverdueTasks.tasks, overdue: [second, first] }
    };
    expect(selectPrimaryOverdueTask(tieSnapshot)?.id).toBe(first.id);
  });

  it("renders bounded overdue counts truthfully", () => {
    expect(countOverdueTasks(planningFixtures.multipleOverdueTasks)).toBe(4);
    expect(countOverdueTasks(planningFixtures.exactlyTwentyOverdueTasks)).toBe(20);
    expect(formatOverdueTaskCount(countOverdueTasks(planningFixtures.exactlyTwentyOverdueTasks))).toBe("20+");
    expect(formatOverdueTaskCount(0)).toBe("0");
    expect(formatOverdueTaskCount(19)).toBe("19");
    expect(formatOverdueTaskCount(20)).toBe("20+");
    expect(formatOverdueTaskCount(21)).toBe("20+");
  });

  it("prefers today calendar events, then falls back to upcoming", () => {
    expect(selectNextCalendarEvent(planningFixtures.timedEvent)?.id).toBe("00000000-0000-4000-8000-000000000020");
    expect(formatCalendarEventTime(selectNextCalendarEvent(planningFixtures.timedEvent)!)).toBe("17:30");
    expect(formatCalendarEventTime(selectNextCalendarEvent(planningFixtures.allDayEvent)!)).toBe("Весь день");
    const upcomingOnly = {
      ...planningFixtures.empty,
      calendar: { ...planningFixtures.empty.calendar, upcoming: planningFixtures.timedEvent.calendar.today }
    };
    expect(selectNextCalendarEvent(upcomingOnly)?.id).toBe("00000000-0000-4000-8000-000000000020");
    expect(selectNextCalendarEvent(planningFixtures.empty)).toBeNull();
  });

  it("reports current, degraded, stale, offline, and absent Planning states", () => {
    expect(planningHealthPresentation(planningFixtures.healthy)).toMatchObject({ state: "current", label: null });
    expect(planningHealthPresentation(planningFixtures.degraded)).toMatchObject({ state: "degraded", label: "Есть проблемы" });
    expect(planningHealthPresentation(planningFixtures.stale).state).toBe("stale");
    expect(planningHealthPresentation(planningFixtures.stale).label).toMatch(/^Данные от /);
    expect(planningHealthPresentation(planningFixtures.offlineWithLastGoodItems).label).toMatch(/недоступны/);
    expect(planningHealthPresentation(planningFixtures.offlineEmpty)).toMatchObject({ state: "offline", hasLastGoodData: false });
    expect(planningHealthPresentation(undefined)).toMatchObject({ state: "unavailable", label: "Планирование недоступно" });
  });

  it("deduplicates a repeated canonical object before selecting a row", () => {
    const reminder = planningFixtures.sseBefore.reminders.upcoming[0];
    const snapshot = {
      ...planningFixtures.sseBefore,
      reminders: { ...planningFixtures.sseBefore.reminders, upcoming: [reminder, reminder] }
    };
    expect(selectNextReminder(snapshot)?.id).toBe(reminder.id);
  });
});
