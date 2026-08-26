export type ActionConfirmationId =
  | "avalar.stage.restart"
  | "avalar.stage.deploy"
  | "avalar.main.restart"
  | "avalar.main.deploy"
  | "home.coffee.turn_on"
  | "home.kettle.boil"
  | "system.runtime.shutdown"
  | "system.rog_g703.hibernate"
  | "planning.reminders.complete"
  | "planning.reminders.cancel"
  | "planning.tasks.complete"
  | "planning.tasks.archive"
  | "planning.calendar.delete";

export type ActionConfirmationLevel = "simple" | "strong";
export type ActionConfirmationTone = "standard" | "production";

export interface ActionConfirmationSpec {
  id: ActionConfirmationId;
  level: ActionConfirmationLevel;
  tone: ActionConfirmationTone;
  title: string;
  target: string;
  environment: string;
  description: string;
  confirmLabel: string;
  requiredPhrase?: string;
  alwaysConfirm?: boolean;
}

export const actionConfirmationCatalog: Record<ActionConfirmationId, ActionConfirmationSpec> = {
  "avalar.stage.restart": {
    id: "avalar.stage.restart", level: "simple", tone: "standard", title: "Перезапустить Stage?", target: "AVALAR Stage", environment: "stage", description: "Перезапустим Stage и проверим его состояние.", confirmLabel: "Перезапустить Stage"
  },
  "avalar.stage.deploy": {
    id: "avalar.stage.deploy", level: "simple", tone: "standard", title: "Задеплоить Stage?", target: "AVALAR Stage", environment: "stage", description: "Обновим Stage и проверим его состояние после запуска.", confirmLabel: "Задеплоить Stage"
  },
  "avalar.main.restart": {
    id: "avalar.main.restart", level: "strong", tone: "production", title: "Перезапустить production?", target: "AVALAR Main", environment: "production", description: "Это production. Перезапустим Main без обновления версии.", confirmLabel: "Перезапустить Main", requiredPhrase: "RESTART MAIN"
  },
  "avalar.main.deploy": {
    id: "avalar.main.deploy", level: "strong", tone: "production", title: "Задеплоить production?", target: "AVALAR Main", environment: "production", description: "Это production. Обновим Main и проверим его состояние после запуска.", confirmLabel: "Задеплоить Main", requiredPhrase: "DEPLOY MAIN"
  },
  "home.coffee.turn_on": {
    id: "home.coffee.turn_on", level: "simple", tone: "standard", title: "Включить кофемашину?", target: "Кофемашина", environment: "Home Assistant", description: "Включим кофемашину и покажем успех только после подтверждения её состояния.", confirmLabel: "Включить кофемашину"
  },
  "home.kettle.boil": {
    id: "home.kettle.boil", level: "simple", tone: "standard", title: "Вскипятить чайник?", target: "Чайник", environment: "Home Assistant", description: "Запустим кипячение и покажем успех только после подтверждения состояния чайника.", confirmLabel: "Вскипятить"
  },
  "system.runtime.shutdown": {
    id: "system.runtime.shutdown", level: "simple", tone: "standard", title: "Полностью закрыть панель?", target: "Локальная панель Windows", environment: "система", description: "Закроем панель и локальные процессы. Скрытие панели остаётся отдельной командой.", confirmLabel: "Полностью закрыть", alwaysConfirm: true
  },
  "system.rog_g703.hibernate": {
    id: "system.rog_g703.hibernate", level: "simple", tone: "standard", title: "Перевести ASUS ROG G703GI в гибернацию?", target: "ASUS ROG G703GI", environment: "Windows", description: "Переведём ASUS в гибернацию и дождёмся завершения перехода.", confirmLabel: "Гибернация"
  },
  "planning.reminders.complete": {
    id: "planning.reminders.complete", level: "simple", tone: "standard", title: "Явно завершить напоминание?", target: "Напоминание", environment: "Planning · AliceTG Bot", description: "Это завершит напоминание. Доставка не меняет его статус автоматически.", confirmLabel: "Завершить напоминание"
  },
  "planning.reminders.cancel": {
    id: "planning.reminders.cancel", level: "simple", tone: "standard", title: "Явно отменить напоминание?", target: "Напоминание", environment: "Planning · AliceTG Bot", description: "Это отменит напоминание. Доставка не меняет его статус автоматически.", confirmLabel: "Отменить напоминание"
  },
  "planning.tasks.complete": {
    id: "planning.tasks.complete", level: "simple", tone: "standard", title: "Завершить задачу?", target: "Задача", environment: "Planning · AliceTG Bot", description: "Задача будет помечена как завершённая.", confirmLabel: "Завершить задачу"
  },
  "planning.tasks.archive": {
    id: "planning.tasks.archive", level: "simple", tone: "standard", title: "Архивировать задачу?", target: "Задача", environment: "Planning · AliceTG Bot", description: "Задача исчезнет из активных списков.", confirmLabel: "Архивировать задачу"
  },
  "planning.calendar.delete": {
    id: "planning.calendar.delete", level: "simple", tone: "standard", title: "Удалить локальное событие?", target: "Событие календаря", environment: "Planning · AliceTG Bot", description: "Удалим локальное событие. Внешний календарь не изменится.", confirmLabel: "Удалить событие"
  }
};
