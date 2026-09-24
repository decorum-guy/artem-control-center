import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

type TimePart = "hour" | "minute";

function padded(value: number): string { return String(value).padStart(2, "0"); }

function wrap(value: number, count: number): number { return (value + count) % count; }

export function CalendarTimePicker({ value, onChange, label }: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const [hour, minute] = value.split(":").map(Number);
  const selectedHour = useRef<HTMLButtonElement>(null);
  const selectedMinute = useRef<HTMLButtonElement>(null);
  const hourColumn = useRef<HTMLDivElement>(null);
  const minuteColumn = useRef<HTMLDivElement>(null);
  function change(part: TimePart, valuePart: number): void {
    onChange(part === "hour" ? `${padded(wrap(valuePart, 24))}:${padded(minute)}` : `${padded(hour)}:${padded(wrap(valuePart, 60))}`);
  }
  function handleKeys(event: KeyboardEvent<HTMLDivElement>, part: TimePart): void {
    const current = part === "hour" ? hour : minute;
    const max = part === "hour" ? 23 : 59;
    const next = event.key === "ArrowUp" ? current - 1
      : event.key === "ArrowDown" ? current + 1
        : event.key === "PageUp" ? current - (part === "hour" ? 1 : 15)
          : event.key === "PageDown" ? current + (part === "hour" ? 1 : 15)
            : event.key === "Home" ? 0
              : event.key === "End" ? max : null;
    if (next === null) return;
    event.preventDefault();
    change(part, next);
  }
  useEffect(() => {
    const bindings: Array<[HTMLDivElement | null, TimePart, number]> = [
      [hourColumn.current, "hour", hour], [minuteColumn.current, "minute", minute]
    ];
    const cleanups = bindings.map(([element, part, current]) => {
      if (!element) return () => {};
      const onWheel = (wheel: WheelEvent) => {
        if (wheel.deltaY === 0) return;
        wheel.preventDefault();
        const next = current + (wheel.deltaY > 0 ? 1 : -1);
        onChange(part === "hour" ? `${padded(wrap(next, 24))}:${padded(minute)}` : `${padded(hour)}:${padded(wrap(next, 60))}`);
      };
      element.addEventListener("wheel", onWheel, { passive: false });
      return () => element.removeEventListener("wheel", onWheel);
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [hour, minute, onChange]);
  function column(part: TimePart, current: number, max: number, selectedRef: RefObject<HTMLButtonElement | null>, columnRef: RefObject<HTMLDivElement | null>) {
    return (
      <div
        ref={columnRef}
        className="calendar-time-picker__column"
        role="group"
        aria-label={part === "hour" ? `${label}: часы` : `${label}: минуты`}
        onKeyDown={(event) => handleKeys(event, part)}
        data-testid={`calendar-time-${part}-column`}
      >
        {[-1, 0, 1].map((offset) => {
          const number = wrap(current + offset, max + 1);
          return <button
            key={offset}
            ref={offset === 0 ? selectedRef : undefined}
            type="button"
            className={`calendar-time-picker__value${offset === 0 ? " calendar-time-picker__value--selected" : ""}`}
            aria-label={`${part === "hour" ? "Часы" : "Минуты"} ${padded(number)}`}
            aria-current={offset === 0 ? "true" : undefined}
            tabIndex={offset === 0 ? 0 : -1}
            data-testid={`calendar-time-${part}-${offset === 0 ? "selected" : offset < 0 ? "previous" : "next"}`}
            onClick={() => {
              change(part, number);
              (part === "hour" ? selectedHour : selectedMinute).current?.focus();
            }}
          >{padded(number)}</button>;
        })}
      </div>
    );
  }
  return (
    <div className="calendar-time-picker" data-testid="calendar-time-picker" aria-label={`Выбор времени: ${label}`}>
      <div className="calendar-time-picker__wheels">
        {column("hour", hour, 23, selectedHour, hourColumn)}
        <span className="calendar-time-picker__separator" aria-hidden="true">:</span>
        {column("minute", minute, 59, selectedMinute, minuteColumn)}
      </div>
      <div className="calendar-time-picker__quick" role="group" aria-label="Быстрый выбор минут">
        {[0, 15, 30, 45].map((option) => <button
          type="button"
          key={option}
          className="calendar-time-picker__quick-button"
          aria-pressed={minute === option}
          onClick={() => change("minute", option)}
        >:{padded(option)}</button>)}
      </div>
      <p className="calendar-time-picker__hint">Нажмите соседнее значение, прокрутите колонку или используйте стрелки клавиатуры.</p>
    </div>
  );
}
