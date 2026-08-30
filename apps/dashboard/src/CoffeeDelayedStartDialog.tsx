import { useEffect, useState } from "react";
import type { CoffeeDelayedStartRecord } from "@artem/contracts";
import { applyNumericKey } from "./coffeeDiaryNumeric";
import { coffeeDelayCountdownLabel, coffeeDelayTargetLabel } from "./coffeeDelayedStartPresentation";
import { NumericKeypadButtons } from "./NumericKeypad";
import { Sheet } from "./Sheet";
import { isCoffeeDelayMinutes } from "./coffeeApi";
import "./CoffeeDelayedStartDialog.css";

function activeSchedule(schedule: CoffeeDelayedStartRecord | null): boolean {
  return schedule?.status === "pending" || schedule?.status === "executing";
}

function errorCopy(error: unknown): string {
  const code = error instanceof Error ? error.message : "coffee_delayed_start_unavailable";
  if (code === "coffee_delayed_start_delay_invalid") return "Укажите от 1 до 120 минут целым числом.";
  if (code === "coffee_write_disabled" || code === "coffee_delayed_start_unavailable") return "Отложенный запуск сейчас недоступен по политике панели или состоянию устройства.";
  if (code === "coffee_delayed_start_unavailable_at_due_time" || code === "coffee_action_unavailable") return "Запуск не выполнен: право управления или связь с Home Assistant больше не подтверждены.";
  return "Не удалось подтвердить состояние отложенного запуска. Проверьте кофемашину перед повтором.";
}

export function CoffeeDelayedStartDialog({
  schedule,
  saving,
  onCreate,
  onCancel,
  onClose
}: {
  schedule: CoffeeDelayedStartRecord | null;
  saving: boolean;
  onCreate: (delayMinutes: number) => Promise<void>;
  onCancel: () => Promise<void>;
  onClose: () => void;
}) {
  const [customMinutes, setCustomMinutes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const hasActiveSchedule = activeSchedule(schedule);

  useEffect(() => {
    if (!hasActiveSchedule) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasActiveSchedule]);

  async function submit(delayMinutes: number): Promise<void> {
    if (saving) return;
    if (!isCoffeeDelayMinutes(delayMinutes)) {
      setError("Укажите от 1 до 120 минут целым числом.");
      return;
    }
    setError(null);
    try {
      await onCreate(delayMinutes);
      setCustomMinutes("");
    } catch (nextError) {
      setError(errorCopy(nextError));
    }
  }

  async function cancel(): Promise<void> {
    if (saving) return;
    setError(null);
    try {
      await onCancel();
    } catch (nextError) {
      setError(errorCopy(nextError));
    }
  }

  const customValue = customMinutes ? Number(customMinutes) : null;
  const customValid = isCoffeeDelayMinutes(customValue);

  return (
    <Sheet
      title="Отложенный запуск"
      eyebrow="Кофемашина"
      description={hasActiveSchedule ? "Подтверждённый запуск хранится на Panel Agent и переживает перезагрузку панели." : "Выберите время запуска кофемашины. Решение о выполнении остаётся на сервере."}
      testId="coffee-delayed-start-dialog"
      canClose={() => !saving}
      onClose={onClose}
      footer={hasActiveSchedule ? (
        <button type="button" className="coffee-delay-dialog__cancel" disabled={saving} onClick={() => void cancel()}>
          {saving ? "Сохраняем…" : "Отменить запуск"}
        </button>
      ) : undefined}
    >
      {hasActiveSchedule && schedule && (
        <div className="coffee-delay-dialog__active" data-testid="coffee-delayed-start-active" role="status" aria-live="polite">
          <strong>{coffeeDelayCountdownLabel(schedule.dueAt, now) === "время наступило" ? "Проверяем запуск…" : `Включится через ${coffeeDelayCountdownLabel(schedule.dueAt, now)}`}</strong>
          <span>в {coffeeDelayTargetLabel(schedule.dueAt)}</span>
        </div>
      )}

      {schedule?.status === "failed" && (
        <p className="coffee-delay-dialog__error" data-testid="coffee-delayed-start-failure" role="alert">
          {errorCopy(schedule.failureCode)}
        </p>
      )}
      {error && <p className="coffee-delay-dialog__error" data-testid="coffee-delayed-start-error" role="alert">{error}</p>}

      <div className="coffee-delay-dialog__presets" role="group" aria-label="Готовое время запуска">
        {[5, 10, 15].map((minutes) => (
          <button key={minutes} type="button" className="coffee-delay-dialog__preset" disabled={saving} onClick={() => void submit(minutes)}>
            +{minutes} мин
          </button>
        ))}
      </div>

      <section className="coffee-delay-dialog__custom" aria-labelledby="coffee-delay-custom-title">
        <div className="coffee-delay-dialog__custom-heading">
          <h3 id="coffee-delay-custom-title">Своё время</h3>
          <output aria-live="polite">{customMinutes || "—"} мин</output>
        </div>
        <NumericKeypadButtons
          decimal={false}
          className="coffee-delay-dialog__keypad"
          buttonClassName="coffee-delay-dialog__key"
          utilityButtonClassName="coffee-delay-dialog__key coffee-delay-dialog__key--utility"
          ariaLabel="Цифровая клавиатура времени запуска"
          clearLabel="C"
          isKeyDisabled={() => saving}
          onKey={(key) => {
            const next = applyNumericKey(customMinutes, key, false, 3, 0);
            setCustomMinutes(next);
            setError(null);
          }}
        />
        <button type="button" className="coffee-delay-dialog__custom-submit" disabled={saving || !customValid} onClick={() => void submit(customValue as number)}>
          {saving ? "Сохраняем…" : "Запланировать своё время"}
        </button>
      </section>
    </Sheet>
  );
}
