export type ActionConfirmationId =
  | "avalar.stage.restart"
  | "avalar.stage.deploy"
  | "avalar.main.restart"
  | "avalar.main.deploy"
  | "home.coffee.turn_on"
  | "home.kettle.boil";

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
}

export const actionConfirmationCatalog: Record<ActionConfirmationId, ActionConfirmationSpec> = {
  "avalar.stage.restart": {
    id: "avalar.stage.restart",
    level: "simple",
    tone: "standard",
    title: "Перезапустить Stage?",
    target: "AVALAR Stage",
    environment: "stage",
    description: "Перезапустим текущий Stage без git pull, затем повторно проверим health и развёрнутую revision.",
    confirmLabel: "Перезапустить Stage"
  },
  "avalar.stage.deploy": {
    id: "avalar.stage.deploy",
    level: "simple",
    tone: "standard",
    title: "Задеплоить Stage?",
    target: "AVALAR Stage",
    environment: "stage",
    description: "Обновим Stage из утверждённой ветки GitHub и после deploy проверим live, ready, сайт и revision.",
    confirmLabel: "Задеплоить Stage"
  },
  "avalar.main.restart": {
    id: "avalar.main.restart",
    level: "strong",
    tone: "production",
    title: "Перезапустить production?",
    target: "AVALAR Main",
    environment: "production",
    description: "Это production. Перезапустим Main без смены развёрнутой revision и затем проверим его состояние.",
    confirmLabel: "Перезапустить Main",
    requiredPhrase: "RESTART MAIN"
  },
  "avalar.main.deploy": {
    id: "avalar.main.deploy",
    level: "strong",
    tone: "production",
    title: "Задеплоить production?",
    target: "AVALAR Main",
    environment: "production",
    description: "Это production deploy. Запустим только зарегистрированный Main deploy и после него проверим health, сайт и новую revision.",
    confirmLabel: "Задеплоить Main",
    requiredPhrase: "DEPLOY MAIN"
  },
  "home.coffee.turn_on": {
    id: "home.coffee.turn_on",
    level: "simple",
    tone: "standard",
    title: "Включить кофемашину?",
    target: "Кофемашина",
    environment: "Home Assistant",
    description: "Отправим разрешённую команду включения и покажем успех только после подтверждения состояния Home Assistant.",
    confirmLabel: "Включить кофемашину"
  },
  "home.kettle.boil": {
    id: "home.kettle.boil",
    level: "simple",
    tone: "standard",
    title: "Вскипятить чайник?",
    target: "Чайник",
    environment: "Home Assistant",
    description: "Запустим зарегистрированную команду кипячения и дождёмся подтверждения состояния Home Assistant.",
    confirmLabel: "Вскипятить"
  }
};
