import type {
  ProjectRegistryDeleteRequest,
  ProjectRegistryEnvironment,
  ProjectRegistryMonitor,
  ProjectRegistryMutationRequest,
  ProjectRegistryProject,
  ProjectRegistryProjectInput,
  ProjectRegistryService,
  ProjectRegistrySettings
} from "@artem/contracts";

export const PROJECT_REGISTRY_CAPABILITY = "settings.projects.manage" as const;
export const PROJECT_REGISTRY_PATH = "/api/v1/settings/projects" as const;
export const PROJECT_CONNECTION_TEST_PATH = "/api/v1/settings/projects/test-connection" as const;

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const URL_ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 3_600;
const MIN_STALE_AFTER_SECONDS = 15;
const MAX_STALE_AFTER_SECONDS = 86_400;

export type ProjectRegistryServerErrorCode =
  | "invalid_json"
  | "invalid_content_length"
  | "project_registry_request_too_large"
  | "project_registry_write_disabled"
  | "revision_conflict"
  | "project_exists"
  | "project_not_found"
  | "project_id_mismatch"
  | "unknown_environment"
  | "unknown_service"
  | "invalid_project_payload"
  | "project_registry_runtime_reconciliation_failed"
  | "config_read_error"
  | "config_not_a_file"
  | "config_too_large"
  | "malformed_yaml"
  | "invalid_schema"
  | "example_config_not_runtime"
  | "config_unavailable"
  | "invalid_project_config"
  | "revision_exhausted"
  | "registry_serialization_failed"
  | "registry_too_large"
  | "registry_write_failed"
  | "project_registry_unavailable";

export type ProjectRegistryApiErrorCode = ProjectRegistryServerErrorCode | "network" | "contract_invalid" | "http_error";

export type ProjectConnectionTestResult =
  | "reachable"
  | "endpoint_not_configured"
  | "endpoint_invalid"
  | "http_error"
  | "unreachable";

export interface ProjectConnectionTestResponse {
  schemaVersion: "project.connection-test.v1";
  result: ProjectConnectionTestResult;
  reachable: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  projectId: string;
  environmentId: string;
  serviceId: string;
}

export class ProjectRegistryApiError extends Error {
  constructor(
    public readonly code: ProjectRegistryApiErrorCode,
    public readonly status: number
  ) {
    super(code);
    this.name = "ProjectRegistryApiError";
  }
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`invalid_${label}`);
  }
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid_${label}`);
  }
  return value;
}

function nullableInteger(value: unknown, label: string, minimum: number, maximum: number): number | null {
  return value === null ? null : integer(value, label, minimum, maximum);
}

function text(value: unknown, label: string, maximum: number, required = true): string {
  if (typeof value !== "string" || value.length > maximum || /\p{C}/u.test(value) || (required && value.length === 0)) {
    throw new Error(`invalid_${label}`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !PROJECT_ID_PATTERN.test(value)) throw new Error(`invalid_${label}`);
  return value;
}

function urlEnv(value: unknown): string {
  if (typeof value !== "string" || !URL_ENV_PATTERN.test(value)) throw new Error("invalid_url_env");
  return value;
}

function parseMonitor(value: unknown): ProjectRegistryMonitor {
  if (!isRecord(value)) throw new Error("invalid_monitor");
  exactKeys(value, ["adapter", "urlEnv", "intervalSeconds", "staleAfterSeconds"], "monitor");
  const intervalSeconds = integer(value.intervalSeconds, "interval_seconds", MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
  const staleAfterSeconds = integer(value.staleAfterSeconds, "stale_after_seconds", MIN_STALE_AFTER_SECONDS, MAX_STALE_AFTER_SECONDS);
  if (staleAfterSeconds < intervalSeconds) throw new Error("invalid_stale_after_seconds");
  if (value.adapter !== "http") throw new Error("invalid_monitor_adapter");
  return {
    adapter: "http",
    urlEnv: urlEnv(value.urlEnv),
    intervalSeconds,
    staleAfterSeconds
  };
}

function parseService(value: unknown): ProjectRegistryService {
  if (!isRecord(value)) throw new Error("invalid_service");
  exactKeys(value, ["id", "monitor", "actions", "presentation"], "service");
  if (!Array.isArray(value.actions) || value.actions.length !== 0) throw new Error("invalid_service_actions");
  if (!isRecord(value.presentation)) throw new Error("invalid_service_presentation");
  exactKeys(value.presentation, ["widget"], "service_presentation");
  if (value.presentation.widget !== "core.generic-service") throw new Error("invalid_service_widget");
  return {
    id: identifier(value.id, "service_id"),
    monitor: parseMonitor(value.monitor),
    actions: [],
    presentation: { widget: "core.generic-service" }
  };
}

function parseEnvironment(value: unknown): ProjectRegistryEnvironment {
  if (!isRecord(value)) throw new Error("invalid_environment");
  exactKeys(value, ["id", "services"], "environment");
  if (!Array.isArray(value.services) || value.services.length > 64) throw new Error("invalid_environment_services");
  return {
    id: identifier(value.id, "environment_id"),
    services: value.services.map(parseService)
  };
}

function parseProject(value: unknown): ProjectRegistryProject {
  if (!isRecord(value)) throw new Error("invalid_project");
  exactKeys(value, ["id", "name", "enabled", "category", "environments"], "project");
  if (typeof value.enabled !== "boolean" || value.category !== "external") throw new Error("invalid_project_metadata");
  if (!Array.isArray(value.environments) || value.environments.length > 32) throw new Error("invalid_project_environments");
  return {
    id: identifier(value.id, "project_id"),
    name: text(value.name, "project_name", 100),
    enabled: value.enabled,
    category: "external",
    environments: value.environments.map(parseEnvironment)
  };
}

const registryErrorCodes = new Set<ProjectRegistrySettings["errorCode"]>([
  "config_read_error",
  "config_not_a_file",
  "config_too_large",
  "malformed_yaml",
  "invalid_schema",
  "example_config_not_runtime",
  "config_unavailable",
  null
]);

function isRegistryErrorCode(value: unknown): value is ProjectRegistrySettings["errorCode"] {
  return value === null || (
    typeof value === "string" && registryErrorCodes.has(value as ProjectRegistrySettings["errorCode"])
  );
}

export function parseProjectRegistry(value: unknown): ProjectRegistrySettings {
  if (!isRecord(value)) throw new Error("invalid_project_registry");
  exactKeys(value, ["schemaVersion", "revision", "available", "errorCode", "projects", "writesEnabled", "manageCapability", "manageMinimumProfile"], "project_registry");
  if (value.schemaVersion !== "project.registry.v1" || typeof value.available !== "boolean" || typeof value.writesEnabled !== "boolean" || value.manageCapability !== PROJECT_REGISTRY_CAPABILITY || value.manageMinimumProfile !== "full") {
    throw new Error("invalid_project_registry_metadata");
  }
  if (!isRegistryErrorCode(value.errorCode)) throw new Error("invalid_project_registry_error");
  if (value.available && value.errorCode !== null) throw new Error("invalid_project_registry_error");
  if (!value.available && value.errorCode === null) throw new Error("invalid_project_registry_error");
  const revision = integer(value.revision, "revision", 0, 2_147_483_647);
  if (!Array.isArray(value.projects) || value.projects.length > 128) throw new Error("invalid_project_registry_projects");
  return {
    schemaVersion: "project.registry.v1",
    revision,
    available: value.available,
    errorCode: value.errorCode,
    projects: value.projects.map(parseProject),
    writesEnabled: value.writesEnabled,
    manageCapability: PROJECT_REGISTRY_CAPABILITY,
    manageMinimumProfile: "full"
  };
}

const serverErrorCodes = new Set<ProjectRegistryServerErrorCode>([
  "invalid_json",
  "invalid_content_length",
  "project_registry_request_too_large",
  "project_registry_write_disabled",
  "revision_conflict",
  "project_exists",
  "project_not_found",
  "project_id_mismatch",
  "unknown_environment",
  "unknown_service",
  "invalid_project_payload",
  "project_registry_runtime_reconciliation_failed",
  "config_read_error",
  "config_not_a_file",
  "config_too_large",
  "malformed_yaml",
  "invalid_schema",
  "example_config_not_runtime",
  "config_unavailable",
  "invalid_project_config",
  "revision_exhausted",
  "registry_serialization_failed",
  "registry_too_large",
  "registry_write_failed",
  "project_registry_unavailable"
]);

function safeServerErrorCode(value: unknown): ProjectRegistryApiErrorCode {
  return typeof value === "string" && serverErrorCodes.has(value as ProjectRegistryServerErrorCode)
    ? value as ProjectRegistryServerErrorCode
    : "http_error";
}

export function parseProjectConnectionTest(value: unknown): ProjectConnectionTestResponse {
  if (!isRecord(value)) throw new Error("invalid_project_connection_test");
  exactKeys(value, ["schemaVersion", "result", "reachable", "httpStatus", "latencyMs", "projectId", "environmentId", "serviceId"], "project_connection_test");
  const result = value.result;
  if (result !== "reachable" && result !== "endpoint_not_configured" && result !== "endpoint_invalid" && result !== "http_error" && result !== "unreachable") {
    throw new Error("invalid_project_connection_test_result");
  }
  if (value.schemaVersion !== "project.connection-test.v1" || typeof value.reachable !== "boolean") {
    throw new Error("invalid_project_connection_test_metadata");
  }
  if (value.reachable !== (result === "reachable")) throw new Error("invalid_project_connection_test_reachable");

  const httpStatus = nullableInteger(value.httpStatus, "connection_http_status", 100, 599);
  const latencyMs = nullableInteger(value.latencyMs, "connection_latency_ms", 0, 30_000);
  if (result === "reachable" && httpStatus === null) throw new Error("invalid_project_connection_test_status");
  if ((result === "reachable" || result === "http_error") && latencyMs === null) throw new Error("invalid_project_connection_test_latency");
  if (result === "endpoint_not_configured" || result === "endpoint_invalid" || result === "unreachable") {
    if (httpStatus !== null || latencyMs !== null) throw new Error("invalid_project_connection_test_metadata");
  }
  return {
    schemaVersion: "project.connection-test.v1",
    result,
    reachable: value.reachable,
    httpStatus,
    latencyMs,
    projectId: identifier(value.projectId, "connection_project_id"),
    environmentId: identifier(value.environmentId, "connection_environment_id"),
    serviceId: identifier(value.serviceId, "connection_service_id")
  };
}

function projectPath(projectId: string): string {
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new ProjectRegistryApiError("project_id_mismatch", 422);
  }
  return `${PROJECT_REGISTRY_PATH}/${encodeURIComponent(projectId)}`;
}

function requestInit(init?: RequestInit): RequestInit {
  return {
    ...init,
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  };
}

async function parseResponse(response: Response): Promise<ProjectRegistrySettings> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = isRecord(body) ? body.detail : undefined;
    throw new ProjectRegistryApiError(safeServerErrorCode(detail), response.status);
  }
  try {
    return parseProjectRegistry(body);
  } catch {
    throw new ProjectRegistryApiError("contract_invalid", response.status);
  }
}

async function requestCollection(init?: RequestInit): Promise<ProjectRegistrySettings> {
  let response: Response;
  try {
    response = await fetch(PROJECT_REGISTRY_PATH, requestInit(init));
  } catch {
    throw new ProjectRegistryApiError("network", 0);
  }
  return parseResponse(response);
}

async function requestProject(projectId: string, init?: RequestInit): Promise<ProjectRegistrySettings> {
  let response: Response;
  try {
    response = await fetch(projectPath(projectId), requestInit(init));
  } catch {
    throw new ProjectRegistryApiError("network", 0);
  }
  return parseResponse(response);
}

export async function testProjectConnection(
  project: ProjectRegistryProjectInput,
  environmentId: string,
  serviceId: string
): Promise<ProjectConnectionTestResponse> {
  let response: Response;
  try {
    response = await fetch(PROJECT_CONNECTION_TEST_PATH, requestInit({
      method: "POST",
      body: JSON.stringify({ project, environmentId, serviceId })
    }));
  } catch {
    throw new ProjectRegistryApiError("network", 0);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = isRecord(body) ? body.detail : undefined;
    throw new ProjectRegistryApiError(safeServerErrorCode(detail), response.status);
  }

  let result: ProjectConnectionTestResponse;
  try {
    result = parseProjectConnectionTest(body);
  } catch {
    throw new ProjectRegistryApiError("contract_invalid", response.status);
  }
  if (
    result.projectId !== project.id
    || result.environmentId !== environmentId
    || result.serviceId !== serviceId
  ) {
    throw new ProjectRegistryApiError("contract_invalid", response.status);
  }
  return result;
}

export function getProjectRegistry(signal?: AbortSignal): Promise<ProjectRegistrySettings> {
  return requestCollection({ signal });
}

export function createProject(
  project: ProjectRegistryProjectInput,
  expectedRevision: number
): Promise<ProjectRegistrySettings> {
  const payload: ProjectRegistryMutationRequest = { expectedRevision, project };
  return requestCollection({ method: "POST", body: JSON.stringify(payload) });
}

export function replaceProject(
  projectId: string,
  project: ProjectRegistryProjectInput,
  expectedRevision: number
): Promise<ProjectRegistrySettings> {
  if (project.id !== projectId) throw new ProjectRegistryApiError("project_id_mismatch", 422);
  const payload: ProjectRegistryMutationRequest = { expectedRevision, project };
  return requestProject(projectId, { method: "PUT", body: JSON.stringify(payload) });
}

export function deleteProject(projectId: string, expectedRevision: number): Promise<ProjectRegistrySettings> {
  const payload: ProjectRegistryDeleteRequest = { expectedRevision };
  return requestProject(projectId, { method: "DELETE", body: JSON.stringify(payload) });
}
