import type { CoffeeData, CoffeeStage } from "@artem/contracts";

const labels: Record<CoffeeStage, string> = {
  off: "Выключена",
  turning_on: "Включаем",
  warming: "Разогревается",
  ready: "Готова",
  running: "Включена",
  running_too_long: "Работает слишком долго",
  turning_off: "Выключаем",
  unavailable: "Недоступна",
  stale: "Данные устарели"
};

export type CoffeeProgressTone = "cool-blue" | "transition-teal" | "ready-green";

function clampProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
}

/**
 * Progress tone is a semantic state value, not a decorative gradient. The
 * source-owned color changes with canonical progress so an early warm-up
 * cannot look ready merely because the fill is short.
 */
export function coffeeProgressTone(progress: number): CoffeeProgressTone {
  const normalized = clampProgress(progress);
  if (normalized < 0.3) return "cool-blue";
  if (normalized < 0.8) return "transition-teal";
  return "ready-green";
}

function interpolateChannel(start: number, end: number, progress: number): number {
  return Math.round(start + (end - start) * progress);
}

/** Restrained blue-to-green interpolation for the current canonical value. */
export function coffeeProgressColor(progress: number): string {
  const normalized = clampProgress(progress);
  const start = [77, 143, 199];
  const end = [95, 170, 125];
  const channels = start.map((channel, index) => interpolateChannel(channel, end[index], normalized));
  return `rgb(${channels[0]} ${channels[1]} ${channels[2]})`;
}

function validPositive(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function coffeePresentation(data: CoffeeData, nowIso: string) {
  const { machine, timingPolicy } = data;
  let stage: keyof typeof labels;
  let progress: number | null = null;
  let remainingSeconds: number | null = null;
  let runningSeconds: number | null = null;
  let timingMessage: string;
  const now = Date.parse(nowIso);
  const turnedOnAt = machine.turnedOnAt ? Date.parse(machine.turnedOnAt) : Number.NaN;

  if (Number.isFinite(now) && Number.isFinite(turnedOnAt) && turnedOnAt <= now) {
    runningSeconds = Math.max(0, (now - turnedOnAt) / 1000);
  }

  if (!machine.available || machine.state === "unavailable") {
    stage = "unavailable";
    timingMessage = "Home Assistant недоступен — timing policy не подтверждает состояние";
  } else if (machine.stale || machine.state === "stale") {
    stage = "stale";
    timingMessage = "Последнее состояние Home Assistant устарело";
  } else if (machine.state === "turning_on" || machine.state === "turning_off") {
    stage = machine.state;
    timingMessage = "Ожидаем подтверждение нового состояния Home Assistant";
  } else if (machine.state === "off") {
    stage = "off";
    timingMessage = "Параметры разогрева не требуются";
  } else {
    const canUseTiming =
      runningSeconds !== null &&
      !timingPolicy.stale &&
      validPositive(timingPolicy.warmupDurationSeconds) &&
      validPositive(timingPolicy.longRunningThresholdSeconds);

    if (!canUseTiming) {
      stage = "running";
      timingMessage = timingPolicy.stale
        ? "Параметры разогрева устарели — показываем только состояние HA"
        : "Параметры разогрева временно недоступны";
    } else {
      const elapsedSeconds = runningSeconds!;
      const warmupDuration = timingPolicy.warmupDurationSeconds!;
      const longRunningThreshold = timingPolicy.longRunningThresholdSeconds!;
      progress = Math.max(0, Math.min(1, elapsedSeconds / warmupDuration));
      remainingSeconds = Math.max(0, Math.ceil(warmupDuration - elapsedSeconds));
      if (elapsedSeconds >= longRunningThreshold) {
        stage = "running_too_long";
      } else if (elapsedSeconds < warmupDuration) {
        stage = "warming";
      } else {
        stage = "ready";
      }
      timingMessage = timingPolicy.sourceAvailable
        ? "Параметры разогрева подтверждены Home Assistant"
        : "Используются последние сохранённые параметры Home Assistant";
    }
  }

  return {
    stage,
    label: labels[stage],
    progress,
    progressText: progress === null ? null : `${Math.round(progress * 100)}%`,
    progressTone: progress === null ? null : coffeeProgressTone(progress),
    progressColor: progress === null ? null : coffeeProgressColor(progress),
    remainingSeconds,
    runningSeconds,
    timingMessage,
    warning: stage === "running_too_long" || stage === "stale",
    animated: ["turning_on", "warming", "turning_off"].includes(stage)
  };
}
