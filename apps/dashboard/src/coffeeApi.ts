import type {
  CoffeeDelayedStartResponse,
  CoffeeActionResponse,
  CoffeeNotificationSettings,
  CoffeeTimingSettings
} from "@artem/contracts";

export const COFFEE_DELAY_MIN_MINUTES = 1;
export const COFFEE_DELAY_MAX_MINUTES = 120;

export function isCoffeeDelayMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= COFFEE_DELAY_MIN_MINUTES && value <= COFFEE_DELAY_MAX_MINUTES;
}

export class CoffeeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string
  ) {
    super(code);
  }
}

async function requestJson<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });
  if (!response.ok) {
    let code = `http_${response.status}`;
    try {
      const payload = await response.json() as { detail?: string };
      if (typeof payload.detail === "string") code = payload.detail;
    } catch {
      // Sanitized status is sufficient when the body is not JSON.
    }
    throw new CoffeeApiError(response.status, code);
  }
  return await response.json() as T;
}

export function getCoffeeTiming(): Promise<CoffeeTimingSettings> {
  return requestJson("/api/v1/settings/coffee/timing");
}

export function patchCoffeeTiming(
  payload: {
    expectedRevision: string;
    warmupMinutes?: number;
    longRunningMinutes?: number;
  }
): Promise<CoffeeTimingSettings> {
  return requestJson("/api/v1/settings/coffee/timing", {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function getCoffeeNotifications(): Promise<CoffeeNotificationSettings> {
  return requestJson("/api/v1/settings/notifications/coffee");
}

export function patchCoffeeNotifications(
  payload: Record<string, unknown>
): Promise<CoffeeNotificationSettings> {
  return requestJson("/api/v1/settings/notifications/coffee", {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function executeCoffeeAction(
  action: "turn_on" | "turn_off",
  requestId: string
): Promise<CoffeeActionResponse> {
  return requestJson("/api/v1/actions/home/coffee", {
    method: "POST",
    body: JSON.stringify({ action, requestId })
  });
}

export function getCoffeeDelayedStart(): Promise<CoffeeDelayedStartResponse> {
  return requestJson("/api/v1/actions/home/coffee/delayed-start", { cache: "no-store" });
}

export function createCoffeeDelayedStart(
  delayMinutes: number,
  requestId: string
): Promise<CoffeeDelayedStartResponse> {
  return requestJson("/api/v1/actions/home/coffee/delayed-start", {
    method: "POST",
    body: JSON.stringify({ delayMinutes, requestId })
  });
}

export function cancelCoffeeDelayedStart(): Promise<CoffeeDelayedStartResponse> {
  return requestJson("/api/v1/actions/home/coffee/delayed-start", { method: "DELETE" });
}
