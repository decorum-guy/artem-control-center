import { describe, expect, it } from "vitest";
import { planningFixtures } from "./planningFixtures";
import {
  countOverdueTasks,
  displayPlanningOverviewItems,
  formatCalendarEventTime,
  formatOverdueTaskCount,
  formatReminderDueLabel,
  formatReminderExactTime,
  formatTaskDueLabel,
  planningHealthPresentation,
  planningDomainStatus,
  planningOverviewRowLimit,
  planningOverviewSummary,
  planningReferenceTime,
  planningTaskDueInstant,
  selectNextCalendarEvent,
  selectNextReminder,
  selectPrimaryOverdueTask,
  selectUpcomingCalendarEvents,
  selectUpcomingTasks
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
    expect(selectNextCalendarEvent(planningFixtures.timedEvent, fixtureNow)?.id).toBe("00000000-0000-4000-8000-000000000020");
    expect(formatCalendarEventTime(selectNextCalendarEvent(planningFixtures.timedEvent, fixtureNow)!)).toBe("17:30");
    expect(formatCalendarEventTime(selectNextCalendarEvent(planningFixtures.allDayEvent, fixtureNow)!)).toBe("Весь день");
    const upcomingOnly = {
      ...planningFixtures.empty,
      calendar: { ...planningFixtures.empty.calendar, upcoming: planningFixtures.timedEvent.calendar.today }
    };
    expect(selectNextCalendarEvent(upcomingOnly, fixtureNow)?.id).toBe("00000000-0000-4000-8000-000000000020");
    expect(selectNextCalendarEvent(planningFixtures.empty, fixtureNow)).toBeNull();
  });

  it("ignores ended today events and keeps the next future event", () => {
    const afternoon = new Date("2026-08-12T14:00:00Z");
    expect(selectNextCalendarEvent(planningFixtures.endedMorningAndFutureEvening, afternoon)?.title).toBe("Вечерняя встреча");
  });

  it("falls back to upcoming after every timed event today has ended", () => {
    const afternoon = new Date("2026-08-12T14:00:00Z");
    expect(selectNextCalendarEvent(planningFixtures.endedTodayWithUpcoming, afternoon)?.title).toBe("Завтрашняя встреча");
  });

  it("orders upcoming events by local calendar day before event type", () => {
    expect(selectNextCalendarEvent(planningFixtures.upcomingTimedBeforeLaterAllDay, fixtureNow)?.title).toBe("Завтрашняя timed-встреча");
  });

  it("prefers an upcoming all-day event before a timed event on the same day", () => {
    expect(selectNextCalendarEvent(planningFixtures.upcomingSameDayAllDayBeforeTimed, fixtureNow)?.title).toBe("Завтрашний день без времени");
  });

  it("orders upcoming timed events by day, then start time, then stable ID", () => {
    expect(selectNextCalendarEvent(planningFixtures.upcomingTimedDays, fixtureNow)?.title).toBe("Встреча завтра");
    expect(selectNextCalendarEvent(planningFixtures.upcomingTimedSameDay, fixtureNow)?.title).toBe("Ранняя встреча завтра");
    expect(selectNextCalendarEvent(planningFixtures.upcomingTimedTie, fixtureNow)?.id).toBe("00000000-0000-4000-8000-000000000033");
  });

  it("keeps an in-progress event relevant and orders future events by start then ID", () => {
    const afternoon = new Date("2026-08-12T14:00:00Z");
    expect(selectNextCalendarEvent(planningFixtures.runningEvent, afternoon)?.title).toBe("Встреча идёт");

    const first = planningFixtures.timedEvent.calendar.today[0];
    const tiedEarlierId = { ...first, id: "00000000-0000-4000-8000-000000000018", title: "Ранее по ID" };
    const tiedLaterId = { ...first, id: "00000000-0000-4000-8000-000000000019", title: "Позже по ID" };
    const tiedSnapshot = {
      ...planningFixtures.empty,
      calendar: { ...planningFixtures.empty.calendar, today: [tiedLaterId, tiedEarlierId] }
    };
    expect(selectNextCalendarEvent(tiedSnapshot, fixtureNow)?.id).toBe(tiedEarlierId.id);
  });

  it("advances current selection but freezes stale, degraded, and offline selection", () => {
    const currentSnapshot = {
      ...planningFixtures.timedEvent,
      calendar: {
        ...planningFixtures.timedEvent.calendar,
        upcoming: [planningFixtures.endedTodayWithUpcoming.calendar.upcoming[0]]
      }
    };
    expect(selectNextCalendarEvent(currentSnapshot, new Date("2026-08-12T15:00:00Z"))?.id).toBe("00000000-0000-4000-8000-000000000020");
    expect(selectNextCalendarEvent(currentSnapshot, new Date("2026-08-12T16:00:00Z"))?.id).toBe("00000000-0000-4000-8000-000000000025");

    for (const sourceStatus of ["stale", "degraded", "offline"] as const) {
      const frozenSnapshot = { ...planningFixtures.endedMorningAndFutureEvening, sourceStatus };
      expect(planningReferenceTime(frozenSnapshot, new Date("2026-08-12T20:00:00Z"))?.toISOString()).toBe("2026-08-12T11:59:00.000Z");
      expect(selectNextCalendarEvent(frozenSnapshot, new Date("2026-08-12T20:00:00Z"))?.title).toBe("Вечерняя встреча");

      const frozenUpcoming = { ...planningFixtures.upcomingTimedBeforeLaterAllDay, sourceStatus };
      expect(selectNextCalendarEvent(frozenUpcoming, new Date("2026-08-20T20:00:00Z"))?.title).toBe("Завтрашняя timed-встреча");
    }
  });

  it("does not invent a selection for an impossible timed event", () => {
    const impossible = {
      ...planningFixtures.timedEvent.calendar.today[0],
      id: "00000000-0000-4000-8000-000000000099",
      startAtUtc: "2026-08-12T16:00:00Z",
      endAtUtc: "2026-08-12T15:00:00Z"
    };
    const snapshot = {
      ...planningFixtures.empty,
      calendar: {
        ...planningFixtures.empty.calendar,
        today: [impossible],
        upcoming: planningFixtures.timedEvent.calendar.today
      }
    };
    expect(selectNextCalendarEvent(snapshot, fixtureNow)?.id).toBe("00000000-0000-4000-8000-000000000020");
  });

  it("reports current, degraded, stale, offline, and absent Planning states", () => {
    expect(planningHealthPresentation(planningFixtures.healthy)).toMatchObject({ state: "current", label: null });
    expect(planningHealthPresentation(planningFixtures.degraded)).toMatchObject({ state: "degraded", label: "Есть проблемы" });
    expect(planningHealthPresentation(planningFixtures.stale).state).toBe("stale");
    expect(planningHealthPresentation(planningFixtures.stale).label).toBe("Данные могут быть устаревшими");
    expect(planningHealthPresentation(planningFixtures.offlineWithLastGoodItems).label).toMatch(/недоступны/);
    expect(planningHealthPresentation(planningFixtures.offlineEmpty)).toMatchObject({ state: "offline", hasLastGoodData: false });
    expect(planningHealthPresentation(undefined)).toMatchObject({ state: "unavailable", label: "Планирование недоступно" });
  });

  it("keeps a recovered Calendar section current while another domain is retrying", () => {
    const partial = {
      ...planningFixtures.healthy,
      sourceStatus: "current" as const,
      health: {
        lastAttemptedAt: "2026-08-12T12:00:00Z",
        lastSuccessfulAt: "2026-08-12T11:59:00Z",
        consecutiveFailures: 1,
        issues: [{ source: "tasks" as const, status: "retrying" as const, consecutiveFailures: 1, lastAttemptedAt: "2026-08-12T12:00:00Z", lastSuccessfulAt: "2026-08-12T11:59:00Z" }],
        domains: [
          { domain: "reminders" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: "2026-08-12T12:00:00Z", lastSuccessfulAt: "2026-08-12T11:59:00Z" },
          { domain: "tasks" as const, status: "retrying" as const, consecutiveFailures: 1, lastAttemptedAt: "2026-08-12T12:00:00Z", lastSuccessfulAt: "2026-08-12T11:59:00Z" },
          { domain: "calendar" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: "2026-08-12T12:00:00Z", lastSuccessfulAt: "2026-08-12T12:00:00Z" },
          { domain: "projects" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: "2026-08-12T12:00:00Z", lastSuccessfulAt: "2026-08-12T12:00:00Z" }
        ]
      }
    };
    expect(planningDomainStatus(partial, "tasks")).toBe("retrying");
    expect(planningDomainStatus(partial, "calendar")).toBe("current");
    expect(planningReferenceTime(partial, new Date("2026-08-12T12:01:00Z"))?.toISOString()).toBe("2026-08-12T12:01:00.000Z");
  });

  it("deduplicates a repeated canonical object before selecting a row", () => {
    const reminder = planningFixtures.sseBefore.reminders.upcoming[0];
    const snapshot = {
      ...planningFixtures.sseBefore,
      reminders: { ...planningFixtures.sseBefore.reminders, upcoming: [reminder, reminder] }
    };
    expect(selectNextReminder(snapshot)?.id).toBe(reminder.id);
  });

  it("builds the compact Overview contribution from fixed module summaries", () => {
    const summary = planningOverviewSummary(planningFixtures.healthy, fixtureNow);
    expect(summary.modules).toEqual([{ moduleId: "planning.overview-summary", status: "available" }]);
    expect(summary.reminder?.title).toBe("Позвонить в сервис");
    expect(summary.overdueTask?.title).toBe("Подготовить отчёт");
    expect(summary.event?.title).toBe("Встреча с командой");
  });

  it("projects a bounded deterministic density for a sufficiently large Overview widget", () => {
    const summary = planningOverviewSummary(planningFixtures.overviewDensity, fixtureNow);
    expect(summary.overviewItems.map((entry) => entry.item.title)).toEqual([
      "Позвонить в сервис",
      "Ранняя задача",
      "Раннее событие",
      "Поздняя задача",
      "Позднее событие"
    ]);
    expect(selectUpcomingTasks(planningFixtures.overviewDensity).map((item) => item.title)).toEqual(["Ранняя задача", "Поздняя задача"]);
    expect(selectUpcomingCalendarEvents(planningFixtures.overviewDensity, fixtureNow).map((item) => item.title)).toEqual(["Раннее событие", "Позднее событие"]);
    expect(planningOverviewRowLimit("compact")).toBe(2);
    expect(planningOverviewRowLimit("standard")).toBe(3);
    expect(planningOverviewRowLimit("large")).toBe(3);
  });

  it("keeps the next same-kind real items ahead of placeholders", () => {
    const first = planningFixtures.overviewDensity.reminders.upcoming[0];
    const reminders = [
      { ...first, id: "00000000-0000-4000-8000-000000000041", title: "Напоминание 1", dueAtUtc: "2026-08-12T12:10:00Z" },
      { ...first, id: "00000000-0000-4000-8000-000000000042", title: "Напоминание 2", dueAtUtc: "2026-08-12T12:20:00Z" },
      { ...first, id: "00000000-0000-4000-8000-000000000043", title: "Напоминание 3", dueAtUtc: "2026-08-12T12:30:00Z" }
    ];
    const snapshot = {
      ...planningFixtures.overviewDensity,
      reminders: { ...planningFixtures.overviewDensity.reminders, upcoming: reminders },
      tasks: { ...planningFixtures.overviewDensity.tasks, overdue: [], upcoming: [] },
      calendar: { ...planningFixtures.overviewDensity.calendar, today: [], upcoming: [] }
    };
    const summary = planningOverviewSummary(snapshot, fixtureNow);
    expect(summary.overviewItems.map((entry) => entry.item.title)).toEqual(["Напоминание 1", "Напоминание 2", "Напоминание 3"]);
    expect(formatTaskDueLabel({ ...planningFixtures.overviewDensity.tasks.upcoming[0], dueDate: "2026-08-14", dueTime: null, timezone: null })).not.toContain("00:00");
  });

  it("normalizes unavailable domains before the bounded Overview curation", () => {
    const calendar = planningFixtures.overviewDensity.calendar.today[0];
    const task = planningFixtures.overviewDensity.tasks.upcoming[0];
    const reminder = planningFixtures.overviewDensity.reminders.upcoming[0];
    const snapshot = {
      ...planningFixtures.overviewDensity,
      health: {
        lastAttemptedAt: "2026-08-12T12:00:00Z",
        lastSuccessfulAt: "2026-08-12T11:59:00Z",
        consecutiveFailures: 3,
        issues: [],
        domains: [
          { domain: "reminders" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: "2026-08-12T11:59:00Z" },
          { domain: "tasks" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: "2026-08-12T11:59:00Z" },
          { domain: "calendar" as const, status: "unavailable" as const, consecutiveFailures: 3, lastAttemptedAt: "2026-08-12T12:00:00Z", lastSuccessfulAt: "2026-08-12T11:59:00Z" },
          { domain: "projects" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: "2026-08-12T11:59:00Z" }
        ]
      }
    };
    const meaningful = [
      { kind: "calendar" as const, item: { ...calendar, id: "calendar-a", title: "CAL_EVENT_A_159A4B" } },
      { kind: "calendar" as const, item: { ...calendar, id: "calendar-b", title: "CAL_EVENT_B_159A4B" } },
      { kind: "calendar" as const, item: { ...calendar, id: "calendar-c", title: "CAL_EVENT_C_159A4B" } },
      { kind: "task" as const, item: { ...task, id: "task-d", title: "TASK_D_159A4B" }, overdue: false },
      { kind: "reminder" as const, item: { ...reminder, id: "reminder-e", title: "REMINDER_E_159A4B" } }
    ];

    const standard = displayPlanningOverviewItems(snapshot, meaningful, 3);
    expect(standard.map((entry) => [entry.kind, entry.presentation, entry.item?.title])).toEqual([
      ["calendar", "unavailable", undefined],
      ["task", "meaningful", "TASK_D_159A4B"],
      ["reminder", "meaningful", "REMINDER_E_159A4B"]
    ]);
    expect(displayPlanningOverviewItems(snapshot, meaningful, 2)).toHaveLength(2);
    expect(standard).toHaveLength(3);
  });

  it("retains current, retrying, degraded, and stale meaningful Calendar candidates in stable order", () => {
    const calendar = planningFixtures.overviewDensity.calendar.today[0];
    const meaningful = [
      { kind: "calendar" as const, item: { ...calendar, id: "calendar-alpha", title: "ALPHA" } },
      { kind: "calendar" as const, item: { ...calendar, id: "calendar-beta", title: "BETA" } },
      { kind: "calendar" as const, item: { ...calendar, id: "calendar-gamma", title: "GAMMA" } }
    ];
    for (const status of ["current", "retrying", "degraded", "stale"] as const) {
      const snapshot = {
        ...planningFixtures.overviewDensity,
        health: {
          lastAttemptedAt: null,
          lastSuccessfulAt: "2026-08-12T11:59:00Z",
          consecutiveFailures: 0,
          issues: [],
          domains: [
            { domain: "reminders" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: null },
            { domain: "tasks" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: null },
            { domain: "calendar" as const, status, consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: null },
            { domain: "projects" as const, status: "current" as const, consecutiveFailures: 0, lastAttemptedAt: null, lastSuccessfulAt: null }
          ]
        }
      };
      const display = displayPlanningOverviewItems(snapshot, meaningful, 3);
      expect(display.map((entry) => entry.item?.title)).toEqual(["ALPHA", "BETA", "GAMMA"]);
      expect(display.every((entry) => entry.presentation === "meaningful")).toBe(true);
    }
  });

  it("orders cross-kind timed items by their actual instant and handles ties deterministically", () => {
    const baseTask = planningFixtures.overviewDensity.tasks.upcoming[0];
    const moscowTask = {
      ...baseTask,
      id: "00000000-0000-4000-8000-000000000051",
      title: "Задача Москва",
      dueDate: "2026-08-13",
      dueTime: "14:00",
      timezone: "Europe/Moscow"
    };
    const reminder = {
      ...planningFixtures.overviewDensity.reminders.upcoming[0],
      id: "00000000-0000-4000-8000-000000000052",
      dueAtUtc: "2026-08-13T12:00:00Z",
      title: "UTC напоминание"
    };
    const event = {
      ...planningFixtures.overviewDensity.calendar.upcoming[0],
      id: "00000000-0000-4000-8000-000000000053",
      title: "UTC событие",
      startAtUtc: "2026-08-13T13:00:00Z",
      endAtUtc: "2026-08-13T14:00:00Z"
    };
    const snapshot = {
      ...planningFixtures.empty,
      reminders: { ...planningFixtures.empty.reminders, upcoming: [reminder] },
      tasks: { ...planningFixtures.empty.tasks, upcoming: [moscowTask] },
      calendar: { ...planningFixtures.empty.calendar, upcoming: [event] }
    };
    expect(planningTaskDueInstant(moscowTask)).toBe(Date.parse("2026-08-13T11:00:00Z"));
    expect(planningOverviewSummary(snapshot, fixtureNow).overviewItems.map((entry) => entry.item.title))
      .toEqual(["Задача Москва", "UTC напоминание", "UTC событие"]);

    const tiedReminder = { ...reminder, id: "00000000-0000-4000-8000-000000000050", title: "UTC напоминание раньше по ID" };
    const tiedSnapshot = { ...snapshot, reminders: { ...snapshot.reminders, upcoming: [reminder, tiedReminder] } };
    expect(planningOverviewSummary(tiedSnapshot, fixtureNow).overviewItems.filter((entry) => entry.kind === "reminder").map((entry) => entry.item.id))
      .toEqual([tiedReminder.id, reminder.id]);
  });

  it("places date-only items by date and undated tasks last without inventing a clock time", () => {
    const baseTask = planningFixtures.overviewDensity.tasks.upcoming[0];
    const dateOnly = { ...baseTask, id: "00000000-0000-4000-8000-000000000061", title: "Дата без времени", dueDate: "2026-08-14", dueTime: null, timezone: null };
    const undated = { ...baseTask, id: "00000000-0000-4000-8000-000000000062", title: "Без срока", dueDate: null, dueTime: null, timezone: null };
    const snapshot = { ...planningFixtures.empty, tasks: { ...planningFixtures.empty.tasks, upcoming: [undated, dateOnly] } };
    expect(planningOverviewSummary(snapshot, fixtureNow).overviewItems.map((entry) => entry.item.title))
      .toEqual(["Дата без времени", "Без срока"]);
    expect(formatTaskDueLabel(dateOnly)).toMatch(/^срок /);
    expect(formatTaskDueLabel(dateOnly)).not.toContain("00:00");
    expect(planningTaskDueInstant(dateOnly)).toBeNull();
  });

  it("keeps the rest of `Дела` available when one summary selector fails", () => {
    const malformed = {
      ...planningFixtures.healthy,
      reminders: undefined as never
    };
    const summary = planningOverviewSummary(malformed, fixtureNow);
    expect(summary.reminder).toBeNull();
    expect(summary.overdueTask?.title).toBe("Подготовить отчёт");
    expect(summary.event?.title).toBe("Встреча с командой");
  });
});
