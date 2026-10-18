export const HOME_CLIMATE_POWER_ON = "home.climate.power_on" as const;
export const HOME_CLIMATE_POWER_OFF = "home.climate.power_off" as const;
export const HOME_CLIMATE_SET_TEMPERATURE = "home.climate.set_temperature" as const;
export const HOME_CLIMATE_SET_MODE = "home.climate.set_mode" as const;
export const HOME_CLIMATE_SET_FAN_MODE = "home.climate.set_fan_mode" as const;
export const HOME_KETTLE_BOIL = "home.kettle.boil" as const;
export const HOME_KETTLE_SET_TEA_MODE = "home.kettle.set_tea_mode" as const;
export const HOME_KETTLE_STOP = "home.kettle.stop" as const;
export const LIGHT_STRIP_POWER_ON = "home.light_strip.power_on" as const;
export const LIGHT_STRIP_POWER_OFF = "home.light_strip.power_off" as const;
export const LIGHT_STRIP_SET_BRIGHTNESS = "home.light_strip.set_brightness" as const;
export const LIGHT_STRIP_SET_COLOR = "home.light_strip.set_color" as const;
export const LIGHT_STRIP_SET_TEMPERATURE = "home.light_strip.set_temperature" as const;
export const LIGHT_STRIP_SET_EFFECT = "home.light_strip.set_effect" as const;
export type LightStripActionId = typeof LIGHT_STRIP_POWER_ON | typeof LIGHT_STRIP_POWER_OFF | typeof LIGHT_STRIP_SET_BRIGHTNESS | typeof LIGHT_STRIP_SET_COLOR | typeof LIGHT_STRIP_SET_TEMPERATURE | typeof LIGHT_STRIP_SET_EFFECT;
export type KettleTeaMode = "white_tea" | "green_tea" | "red_tea" | "herbal_tea" | "flower_tea" | "puerh_tea" | "oolong_tea" | "black_tea";
export type KettleActionId = typeof HOME_KETTLE_BOIL | typeof HOME_KETTLE_SET_TEA_MODE | typeof HOME_KETTLE_STOP;

export const ROG_PSU_MODE_NORMAL = "system.rog_g703.psu.mode.normal" as const;
export const ROG_PSU_MODE_FULL = "system.rog_g703.psu.mode.full" as const;
export const ROG_PSU_BP1_ON = "system.rog_g703.psu.bp1.on" as const;
export const ROG_PSU_BP1_OFF = "system.rog_g703.psu.bp1.off" as const;
export const ROG_PSU_BP2_ON = "system.rog_g703.psu.bp2.on" as const;
export const ROG_PSU_BP2_OFF = "system.rog_g703.psu.bp2.off" as const;

export type ClimateActionId =
  | typeof HOME_CLIMATE_POWER_ON
  | typeof HOME_CLIMATE_POWER_OFF
  | typeof HOME_CLIMATE_SET_TEMPERATURE
  | typeof HOME_CLIMATE_SET_MODE
  | typeof HOME_CLIMATE_SET_FAN_MODE;

export type RogPsuActionId =
  | typeof ROG_PSU_MODE_NORMAL
  | typeof ROG_PSU_MODE_FULL
  | typeof ROG_PSU_BP1_ON
  | typeof ROG_PSU_BP1_OFF
  | typeof ROG_PSU_BP2_ON
  | typeof ROG_PSU_BP2_OFF;

export type HomeAssistantActionId = ClimateActionId | RogPsuActionId | KettleActionId | LightStripActionId;
export type ClimateHvacMode = "cool" | "heat" | "fan_only" | "dry" | "auto" | "off";
export type ClimateFanMode = "one" | "two" | "three" | "four" | "five";
export type HomeAssistantAvailability =
  | "allowed"
  | "elevation_required"
  | "profile_blocked"
  | "pin_not_configured"
  | "gate_disabled"
  | "integration_unavailable"
  | "busy"
  | "cooldown"
  | "precondition_failed";

export interface HomeAssistantCapabilityDecision {
  capability: string;
  minimumProfile: "read_only" | "standard" | "full";
  effectiveProfile: "read_only" | "standard" | "full";
  allowed: boolean;
  availability: HomeAssistantAvailability;
  gateEnabled: boolean;
  integrationAvailable: boolean;
  busy: boolean;
  preconditionOk: boolean;
}

export interface HomeAssistantActionAvailability {
  schemaVersion: 1;
  actions: Record<HomeAssistantActionId, HomeAssistantCapabilityDecision>;
}

export type HomeAssistantActionRequest = {
  actionId: typeof HOME_KETTLE_STOP;
  requestId: string;
  temperature?: never;
  mode?: never;
  fanMode?: never;
  teaMode?: never;
  brightness?: never;
  hsColor?: never;
  kelvin?: never;
  effect?: never;
} | {
  actionId: Exclude<HomeAssistantActionId, typeof HOME_KETTLE_STOP>;
  requestId: string;
  temperature?: number | null;
  mode?: ClimateHvacMode | null;
  fanMode?: ClimateFanMode | null;
  teaMode?: KettleTeaMode;
  brightness?: number;
  hsColor?: [number, number];
  kelvin?: number;
  effect?: string;
};

export interface HomeAssistantActionResponse {
  schemaVersion: 1;
  requestId: string;
  actionId: HomeAssistantActionId;
  status: "confirmed";
  observedAt: string;
  climate: {
    state: ClimateHvacMode;
    targetTemperature: number | null;
    fanMode: ClimateFanMode | null;
  } | null;
  psu: {
    mode: "full" | "normal" | "secondary_only" | "off" | "unavailable";
    psu1State: "on" | "off" | "unavailable";
    psu2State: "on" | "off" | "unavailable";
  } | null;
  kettle?: {
    state?: "on" | "off";
    lastUpdated?: string | null;
    operationMode: "on" | "off" | KettleTeaMode;
    currentTemperature: number | null;
    targetTemperature: number | null;
  } | null;
  light?: {
    state: "on" | "off";
    brightness: number | null;
    hsColor: [number, number] | null;
    colorTempKelvin: number | null;
    effect: string | null;
  } | null;
}

const boundedErrorCodes = new Set([
  "ha_action_disabled",
  "ha_integration_unavailable",
  "ha_entity_unavailable",
  "ha_service_failed",
  "ha_verification_timeout",
  "ha_invalid_state",
  "ha_action_busy",
  "last_psu_off_blocked",
  "gate_disabled",
  "profile_blocked",
  "pin_not_configured",
  "elevation_required",
  "precondition_failed"
]);

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `request_failed_${response.status}`;
    try {
      const payload = await response.json() as { detail?: unknown };
      if (typeof payload.detail === "string" && boundedErrorCodes.has(payload.detail)) {
        detail = payload.detail;
      }
    } catch {
      // Keep the bounded status fallback.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export async function fetchHomeAssistantActionAvailability(): Promise<HomeAssistantActionAvailability> {
  return parse<HomeAssistantActionAvailability>(await fetch(
    "/api/v1/actions/home-assistant/availability",
    { cache: "no-store" }
  ));
}

export async function executeHomeAssistantAction(
  request: HomeAssistantActionRequest
): Promise<HomeAssistantActionResponse> {
  const body = request.actionId === HOME_KETTLE_BOIL || request.actionId === HOME_KETTLE_STOP
    ? { actionId: request.actionId, requestId: request.requestId }
    : request.actionId === HOME_KETTLE_SET_TEA_MODE
    ? { actionId: request.actionId, requestId: request.requestId, teaMode: request.teaMode }
    : request.actionId.startsWith("home.light_strip.")
    ? {
      actionId: request.actionId, requestId: request.requestId,
      brightness: request.brightness ?? null, hsColor: request.hsColor ?? null,
      kelvin: request.kelvin ?? null, effect: request.effect ?? null
    }
    : {
      actionId: request.actionId,
      requestId: request.requestId,
      temperature: request.temperature ?? null,
      mode: request.mode ?? null,
      fanMode: request.fanMode ?? null
    };
  return parse<HomeAssistantActionResponse>(await fetch("/api/v1/actions/home-assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }));
}

export function newHomeAssistantRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
    ? crypto.getRandomValues(new Uint8Array(16))
    : Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
