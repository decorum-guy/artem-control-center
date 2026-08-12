import type {
  PlanningCalendarEvent,
  PlanningReminder,
  PlanningSnapshot,
  PlanningTask
} from "@artem/contracts";

const FIXTURE_NOW = "2026-08-12T12:00:00Z";
const FIXTURE_SYNCED_AT = "2026-08-12T11:59:00Z";

const ids = {
  reminder: "00000000-0000-4000-8000-000000000001",
  deliveryFailure: "00000000-0000-4000-8000-000000000002",
  deliveredOpen: "00000000-0000-4000-8000-000000000003",
  completed: "00000000-0000-4000-8000-000000000004",
  cancelled: "00000000-0000-4000-8000-000000000005",
  highTask: "00000000-0000-4000-8000-000000000010",
  normalTask: "00000000-0000-4000-8000-000000000011",
  lowTask: "00000000-0000-4000-8000-000000000012",
  noneTask: "00000000-0000-4000-8000-000000000013",
  timedEvent: "00000000-0000-4000-8000-000000000020",
  allDayEvent: "00000000-0000-4000-8000-000000000021"
} as const;

const capabilities = {
  create: false,
  edit: false,
  complete: false,
  cancel: false,
  delete: false,
  voice: false,
  providerSync: false
} as const;

function reminder(overrides: Partial<PlanningReminder> = {}): PlanningReminder {
  return {
    id: ids.reminder,
    version: 1,
    source: "alice",
    sourceLabel: "AliceTG Bot",
    title: "Позвонить в сервис",
    dueAtUtc: "2026-08-12T12:40:00Z",
    timezone: "Europe/Moscow",
    status: "pending",
    deliveryState: "not_due",
    createdAt: FIXTURE_SYNCED_AT,
    updatedAt: FIXTURE_SYNCED_AT,
    ...overrides
  };
}

function task(
  id: string,
  title: string,
  priority: PlanningTask["priority"],
  dueDate = "2026-08-11",
  dueTime: string | null = "15:20"
): PlanningTask {
  return {
    id,
    version: 1,
    source: "alice",
    sourceLabel: "AliceTG Bot",
    title,
    priority,
    status: "open",
    dueDate,
    dueTime,
    timezone: dueTime ? "Europe/Moscow" : null,
    projectId: null,
    createdAt: FIXTURE_SYNCED_AT,
    updatedAt: FIXTURE_SYNCED_AT
  };
}

function calendarEvent(overrides: Partial<PlanningCalendarEvent> = {}): PlanningCalendarEvent {
  return {
    id: ids.timedEvent,
    version: 1,
    source: "calendar-provider",
    sourceLabel: "Calendar provider",
    title: "Встреча с командой",
    allDay: false,
    timezone: "Europe/Moscow",
    syncState: "local_only",
    startAtUtc: "2026-08-12T14:30:00Z",
    endAtUtc: "2026-08-12T15:30:00Z",
    startDate: null,
    endDateExclusive: null,
    createdAt: FIXTURE_SYNCED_AT,
    updatedAt: FIXTURE_SYNCED_AT,
    ...overrides
  };
}

function planning(overrides: Partial<PlanningSnapshot> = {}): PlanningSnapshot {
  return {
    schemaVersion: "planning.panel.v1",
    generatedAt: FIXTURE_NOW,
    sourceStatus: "current",
    lastSyncedAt: FIXTURE_SYNCED_AT,
    staleAfter: "2026-08-12T12:05:00Z",
    reminders: {
      upcoming: [reminder()],
      overdue: [],
      deliveryFailures: []
    },
    tasks: {
      today: [],
      overdue: [task(ids.highTask, "Подготовить отчёт", "high")],
      upcoming: [],
      projects: []
    },
    calendar: {
      today: [calendarEvent()],
      upcoming: [],
      conflicts: []
    },
    capabilities,
    providerStatuses: [
      {
        id: "native-planning",
        label: "Local Planning",
        status: "local_only",
        configured: true,
        lastSyncedAt: FIXTURE_SYNCED_AT
      }
    ],
    ...overrides
  };
}

function withSourceStatus(snapshot: PlanningSnapshot, sourceStatus: PlanningSnapshot["sourceStatus"]): PlanningSnapshot {
  return { ...snapshot, sourceStatus };
}

function boundedTask(index: number): PlanningTask {
  const id = `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`;
  return task(id, `Открытая просроченная задача ${index + 1}`, index === 0 ? "high" : "normal");
}

export const emptyPlanningFixture: PlanningSnapshot = {
  ...planning({
    sourceStatus: "offline",
    lastSyncedAt: null,
    staleAfter: null,
    reminders: { upcoming: [], overdue: [], deliveryFailures: [] },
    tasks: { today: [], overdue: [], upcoming: [], projects: [] },
    calendar: { today: [], upcoming: [], conflicts: [] },
    providerStatuses: [
      {
        id: "native-planning",
        label: "Local Planning",
        status: "local_only",
        configured: true,
        lastSyncedAt: null
      }
    ]
  })
};

export const planningFixtures = {
  healthy: planning(),
  empty: planning({
    reminders: { upcoming: [], overdue: [], deliveryFailures: [] },
    tasks: { today: [], overdue: [], upcoming: [], projects: [] },
    calendar: { today: [], upcoming: [], conflicts: [] }
  }),
  reminderSoon: planning({
    reminders: { upcoming: [reminder({ dueAtUtc: "2026-08-12T12:40:00Z" })], overdue: [], deliveryFailures: [] }
  }),
  multipleOverdueTasks: planning({
    tasks: {
      today: [],
      overdue: [
        task(ids.noneTask, "Низкий приоритет", "none", "2026-08-10", null),
        task(ids.lowTask, "Низкий, но более ранний", "low", "2026-08-09"),
        task(ids.normalTask, "Обычный приоритет", "normal", "2026-08-11"),
        task(ids.highTask, "Высокий приоритет", "high", "2026-08-12")
      ],
      upcoming: [],
      projects: []
    }
  }),
  timedEvent: planning({ calendar: { today: [calendarEvent()], upcoming: [], conflicts: [] } }),
  allDayEvent: planning({
    calendar: {
      today: [calendarEvent({
        id: ids.allDayEvent,
        title: "Отпуск",
        allDay: true,
        startAtUtc: null,
        endAtUtc: null,
        startDate: "2026-08-12",
        endDateExclusive: "2026-08-13"
      })],
      upcoming: [],
      conflicts: []
    }
  }),
  degraded: withSourceStatus(planning(), "degraded"),
  stale: withSourceStatus(planning(), "stale"),
  offlineWithLastGoodItems: withSourceStatus(planning(), "offline"),
  offlineEmpty: emptyPlanningFixture,
  deliveryFailure: planning({
    reminders: {
      upcoming: [reminder()],
      overdue: [],
      deliveryFailures: [reminder({
        id: ids.deliveryFailure,
        title: "Не выбранный сбой доставки",
        dueAtUtc: "2026-08-12T11:00:00Z",
        status: "due",
        deliveryState: "failed"
      })]
    }
  }),
  deliveredOpen: planning({
    reminders: {
      upcoming: [reminder({
        id: ids.deliveredOpen,
        title: "Доставлено, но не закрыто",
        dueAtUtc: "2026-08-12T12:45:00Z",
        status: "due",
        deliveryState: "delivered"
      })],
      overdue: [],
      deliveryFailures: []
    }
  }),
  completedCancelled: planning({
    reminders: {
      upcoming: [
        reminder({ id: ids.completed, title: "Завершённое", status: "completed" }),
        reminder({ id: ids.cancelled, title: "Отменённое", status: "cancelled" })
      ],
      overdue: [],
      deliveryFailures: []
    }
  }),
  longRussianTitles: planning({
    reminders: {
      upcoming: [reminder({
        title: "Проверить длинное русское напоминание о доставке документов в бухгалтерию до конца рабочего дня"
      })],
      overdue: [],
      deliveryFailures: []
    },
    tasks: {
      today: [],
      overdue: [task(
        ids.highTask,
        "Подготовить очень длинную просроченную задачу для квартального отчёта https://example.com light.turn_on /etc/passwd",
        "high"
      )],
      upcoming: [],
      projects: []
    },
    calendar: {
      today: [calendarEvent({
        title: "Длинная встреча с русским названием, которое должно спокойно занимать две строки"
      })],
      upcoming: [],
      conflicts: []
    }
  }),
  exactlyTwentyOverdueTasks: planning({
    tasks: { today: [], overdue: Array.from({ length: 20 }, (_, index) => boundedTask(index)), upcoming: [], projects: [] }
  }),
  sseBefore: planning(),
  sseAfter: planning({
    reminders: { upcoming: [reminder({ title: "Обновлённое напоминание" })], overdue: [], deliveryFailures: [] }
  })
} satisfies Record<string, PlanningSnapshot>;
