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
  allDayEvent: "00000000-0000-4000-8000-000000000021",
  endedMorning: "00000000-0000-4000-8000-000000000022",
  eveningEvent: "00000000-0000-4000-8000-000000000023",
  endedLate: "00000000-0000-4000-8000-000000000024",
  tomorrowEvent: "00000000-0000-4000-8000-000000000025",
  runningEvent: "00000000-0000-4000-8000-000000000026",
  upcomingTomorrowTimed: "00000000-0000-4000-8000-000000000027",
  upcomingLaterAllDay: "00000000-0000-4000-8000-000000000028",
  upcomingTomorrowAllDay: "00000000-0000-4000-8000-000000000029",
  upcomingTomorrowTimedSameDay: "00000000-0000-4000-8000-000000000030",
  upcomingEarlierDayTimed: "00000000-0000-4000-8000-000000000031",
  upcomingLaterDayTimed: "00000000-0000-4000-8000-000000000032",
  upcomingTieEarlier: "00000000-0000-4000-8000-000000000033",
  upcomingTieLater: "00000000-0000-4000-8000-000000000034"
} as const;

const capabilities = {
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
    notes: null,
    priority,
    status: "open",
    dueDate,
    dueTime,
    timezone: dueTime ? "Europe/Moscow" : null,
    projectId: null,
    sourceRef: null,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
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
    calendarIdentity: {
      providerId: "calendar-provider",
      providerLabel: "Calendar provider",
      calendarId: "primary",
      calendarLabel: "Основной календарь"
    },
    title: "Встреча с командой",
    notes: null,
    location: null,
    allDay: false,
    timezone: "Europe/Moscow",
    syncState: "local_only",
    localOnlyMutable: false,
    startAtUtc: "2026-08-12T14:30:00Z",
    endAtUtc: "2026-08-12T15:30:00Z",
    startDate: null,
    endDateExclusive: null,
    deletedAt: null,
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
  multipleCalendarIdentities: planning({
    calendar: {
      today: [
        calendarEvent({
          id: ids.timedEvent,
          title: "Встреча из личного календаря",
          calendarIdentity: {
            providerId: "calendar-provider",
            providerLabel: "Calendar provider",
            calendarId: "personal",
            calendarLabel: "Личный"
          }
        }),
        calendarEvent({
          id: ids.allDayEvent,
          title: "Встреча из рабочего календаря",
          calendarIdentity: {
            providerId: "calendar-provider",
            providerLabel: "Calendar provider",
            calendarId: "work",
            calendarLabel: "Рабочий"
          },
          startAtUtc: "2026-08-12T16:00:00Z",
          endAtUtc: "2026-08-12T17:00:00Z"
        })
      ],
      upcoming: [],
      conflicts: []
    }
  }),
  endedMorningAndFutureEvening: planning({
    calendar: {
      today: [
        calendarEvent({
          id: ids.endedMorning,
          title: "Утреннее совещание",
          startAtUtc: "2026-08-12T09:00:00Z",
          endAtUtc: "2026-08-12T10:00:00Z"
        }),
        calendarEvent({
          id: ids.eveningEvent,
          title: "Вечерняя встреча",
          startAtUtc: "2026-08-12T16:00:00Z",
          endAtUtc: "2026-08-12T17:00:00Z"
        })
      ],
      upcoming: [],
      conflicts: []
    }
  }),
  endedTodayWithUpcoming: planning({
    calendar: {
      today: [
        calendarEvent({
          id: ids.endedMorning,
          title: "Утреннее совещание",
          startAtUtc: "2026-08-12T09:00:00Z",
          endAtUtc: "2026-08-12T10:00:00Z"
        }),
        calendarEvent({
          id: ids.endedLate,
          title: "Дневная встреча",
          startAtUtc: "2026-08-12T11:00:00Z",
          endAtUtc: "2026-08-12T12:00:00Z"
        })
      ],
      upcoming: [calendarEvent({
        id: ids.tomorrowEvent,
        title: "Завтрашняя встреча",
        startAtUtc: "2026-08-13T09:00:00Z",
        endAtUtc: "2026-08-13T10:00:00Z"
      })],
      conflicts: []
    }
  }),
  runningEvent: planning({
    calendar: {
      today: [calendarEvent({
        id: ids.runningEvent,
        title: "Встреча идёт",
        startAtUtc: "2026-08-12T13:30:00Z",
        endAtUtc: "2026-08-12T15:00:00Z"
      })],
      upcoming: [],
      conflicts: []
    }
  }),
  upcomingTimedBeforeLaterAllDay: planning({
    calendar: {
      today: [],
      upcoming: [
        calendarEvent({
          id: ids.upcomingTomorrowTimed,
          title: "Завтрашняя timed-встреча",
          startAtUtc: "2026-08-13T06:00:00Z",
          endAtUtc: "2026-08-13T07:00:00Z"
        }),
        calendarEvent({
          id: ids.upcomingLaterAllDay,
          title: "Поздний день без времени",
          allDay: true,
          startAtUtc: null,
          endAtUtc: null,
          startDate: "2026-08-17",
          endDateExclusive: "2026-08-18"
        })
      ],
      conflicts: []
    }
  }),
  upcomingSameDayAllDayBeforeTimed: planning({
    calendar: {
      today: [],
      upcoming: [
        calendarEvent({
          id: ids.upcomingTomorrowTimedSameDay,
          title: "Завтрашняя timed-встреча",
          startAtUtc: "2026-08-13T09:00:00Z",
          endAtUtc: "2026-08-13T10:00:00Z"
        }),
        calendarEvent({
          id: ids.upcomingTomorrowAllDay,
          title: "Завтрашний день без времени",
          allDay: true,
          startAtUtc: null,
          endAtUtc: null,
          startDate: "2026-08-13",
          endDateExclusive: "2026-08-14"
        })
      ],
      conflicts: []
    }
  }),
  upcomingTimedDays: planning({
    calendar: {
      today: [],
      upcoming: [
        calendarEvent({
          id: ids.upcomingLaterDayTimed,
          title: "Встреча через несколько дней",
          startAtUtc: "2026-08-15T09:00:00Z",
          endAtUtc: "2026-08-15T10:00:00Z"
        }),
        calendarEvent({
          id: ids.upcomingEarlierDayTimed,
          title: "Встреча завтра",
          startAtUtc: "2026-08-13T11:00:00Z",
          endAtUtc: "2026-08-13T12:00:00Z"
        })
      ],
      conflicts: []
    }
  }),
  upcomingTimedSameDay: planning({
    calendar: {
      today: [],
      upcoming: [
        calendarEvent({
          id: ids.upcomingLaterDayTimed,
          title: "Поздняя встреча завтра",
          startAtUtc: "2026-08-13T11:00:00Z",
          endAtUtc: "2026-08-13T12:00:00Z"
        }),
        calendarEvent({
          id: ids.upcomingEarlierDayTimed,
          title: "Ранняя встреча завтра",
          startAtUtc: "2026-08-13T09:00:00Z",
          endAtUtc: "2026-08-13T10:00:00Z"
        })
      ],
      conflicts: []
    }
  }),
  upcomingTimedTie: planning({
    calendar: {
      today: [],
      upcoming: [
        calendarEvent({
          id: ids.upcomingTieLater,
          title: "Позже по ID",
          startAtUtc: "2026-08-13T09:00:00Z",
          endAtUtc: "2026-08-13T10:00:00Z"
        }),
        calendarEvent({
          id: ids.upcomingTieEarlier,
          title: "Ранее по ID",
          startAtUtc: "2026-08-13T09:00:00Z",
          endAtUtc: "2026-08-13T10:00:00Z"
        })
      ],
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
