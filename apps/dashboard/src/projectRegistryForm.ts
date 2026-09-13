import type { ProjectRegistryProject, ProjectRegistryProjectInput } from "@artem/contracts";

export interface ProjectDraft {
  id: string;
  name: string;
  enabled: boolean;
  environmentId: string;
  serviceId: string;
  urlEnv: string;
  intervalSeconds: number;
  staleAfterSeconds: number;
}

export type ProjectDraftField = keyof ProjectDraft;
export type ProjectDraftErrors = Partial<Record<ProjectDraftField, string>>;

export const DEFAULT_PROJECT_DRAFT: ProjectDraft = {
  id: "",
  name: "",
  enabled: true,
  environmentId: "production",
  serviceId: "api",
  urlEnv: "",
  intervalSeconds: 60,
  staleAfterSeconds: 180
};

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const URL_ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function projectDraftFromRegistry(project: ProjectRegistryProject): ProjectDraft | null {
  if (project.capabilities !== undefined) return null;
  if (project.environments.length !== 1) return null;
  const environment = project.environments[0];
  if (!environment || environment.services.length !== 1) return null;
  const service = environment.services[0];
  if (service?.backupProfile !== undefined) return null;
  if (!service || service.actions.length !== 0 || service.presentation.widget !== "core.generic-service") return null;
  if (service.monitor.adapter !== "http") return null;
  return {
    id: project.id,
    name: project.name,
    enabled: project.enabled,
    environmentId: environment.id,
    serviceId: service.id,
    urlEnv: service.monitor.urlEnv,
    intervalSeconds: service.monitor.intervalSeconds,
    staleAfterSeconds: service.monitor.staleAfterSeconds
  };
}

export function projectInputFromDraft(draft: ProjectDraft): ProjectRegistryProjectInput {
  return {
    id: draft.id,
    name: draft.name,
    enabled: draft.enabled,
    category: "external",
    environments: [
      {
        id: draft.environmentId,
        services: [
          {
            id: draft.serviceId,
            capabilities: {
              monitor: {
                adapter: "http",
                url_env: draft.urlEnv,
                interval_seconds: draft.intervalSeconds,
                stale_after_seconds: draft.staleAfterSeconds
              },
              actions: []
            },
            presentation: { widget: "core.generic-service" }
          }
        ]
      }
    ]
  };
}

export function projectInputFromRegistry(project: ProjectRegistryProject): ProjectRegistryProjectInput {
  return {
    id: project.id,
    name: project.name,
    enabled: project.enabled,
    category: project.category,
    ...(project.capabilities ? {
      capabilities: {
        backups: {
          profiles: [...project.capabilities.backups.profiles]
        }
      }
    } : {}),
    environments: project.environments.map((environment) => ({
      id: environment.id,
      services: environment.services.map((service) => ({
        id: service.id,
        capabilities: {
          monitor: {
            adapter: service.monitor.adapter,
            url_env: service.monitor.urlEnv,
            interval_seconds: service.monitor.intervalSeconds,
            stale_after_seconds: service.monitor.staleAfterSeconds
          },
          ...(service.details ? { details: service.details } : {}),
          actions: [...service.actions],
          ...(service.backupProfile !== undefined ? { backupProfile: service.backupProfile } : {})
        },
        presentation: { widget: "core.generic-service" }
      }))
    }))
  };
}

export function validateProjectDraft(draft: ProjectDraft): ProjectDraftErrors {
  const errors: ProjectDraftErrors = {};
  const name = draft.name.trim();
  const id = draft.id.trim();
  const environmentId = draft.environmentId.trim();
  const serviceId = draft.serviceId.trim();

  if (!name) errors.name = "Введите название проекта.";
  else if (name.length > 100) errors.name = "Название проекта слишком длинное.";

  if (!IDENTIFIER_PATTERN.test(id)) errors.id = "Используйте строчные латинские буквы, цифры, - и _; первый символ — буква или цифра.";
  if (!IDENTIFIER_PATTERN.test(environmentId)) errors.environmentId = "Укажите корректный ID окружения: строчные латинские буквы, цифры, - и _.";
  if (!IDENTIFIER_PATTERN.test(serviceId)) errors.serviceId = "Укажите корректный ID сервиса: строчные латинские буквы, цифры, - и _.";
  if (!URL_ENV_PATTERN.test(draft.urlEnv.trim())) errors.urlEnv = "Укажите имя ENV-переменной в формате EXTERNAL_API_HEALTH_URL.";

  if (!Number.isSafeInteger(draft.intervalSeconds) || draft.intervalSeconds < 5 || draft.intervalSeconds > 3_600) {
    errors.intervalSeconds = "Интервал должен быть от 5 до 3600 секунд.";
  }
  if (!Number.isSafeInteger(draft.staleAfterSeconds) || draft.staleAfterSeconds < 15 || draft.staleAfterSeconds > 86_400) {
    errors.staleAfterSeconds = "Порог устаревания должен быть от 15 до 86400 секунд.";
  } else if (Number.isSafeInteger(draft.intervalSeconds) && draft.staleAfterSeconds < draft.intervalSeconds) {
    errors.staleAfterSeconds = "Порог устаревания не может быть меньше интервала проверки.";
  }
  return errors;
}

export function normalizeProjectDraft(draft: ProjectDraft): ProjectDraft {
  return {
    ...draft,
    id: draft.id.trim(),
    name: draft.name.trim(),
    environmentId: draft.environmentId.trim(),
    serviceId: draft.serviceId.trim(),
    urlEnv: draft.urlEnv.trim()
  };
}
