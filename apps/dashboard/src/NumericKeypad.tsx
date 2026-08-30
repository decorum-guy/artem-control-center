import { applyNumericKey, numericInputValue } from "./coffeeDiaryNumeric";
import { numericKeyLabel, numericKeyOrder, type NumericKey } from "./numericKeypadShared";
import "./coffeeDiary.css";

export function NumericKeypadButtons({
  decimal = true,
  onKey,
  className = "coffee-diary-keypad__grid",
  buttonClassName,
  utilityButtonClassName,
  clearLabel = "Очистить",
  clearAriaLabel,
  backspaceAriaLabel = "Удалить цифру",
  backspaceLabel = "←",
  digitAriaLabel = (key) => `Цифра ${key}`,
  isKeyDisabled,
  ariaLabel
}: {
  decimal?: boolean;
  onKey: (key: NumericKey) => void;
  className?: string;
  buttonClassName?: string;
  utilityButtonClassName?: string;
  clearLabel?: string;
  clearAriaLabel?: string;
  backspaceAriaLabel?: string;
  backspaceLabel?: string;
  digitAriaLabel?: (key: string) => string;
  isKeyDisabled?: (key: NumericKey) => boolean;
  ariaLabel?: string;
}) {
  return (
    <div className={className} aria-label={ariaLabel}>
      {numericKeyOrder(decimal).map((key) => (
        <button
          key={key}
          type="button"
          className={key === "backspace" || key === "clear" ? utilityButtonClassName ?? buttonClassName ?? "coffee-diary-keypad__utility" : buttonClassName}
          aria-label={key === "backspace" ? backspaceAriaLabel : key === "." ? "Десятичный разделитель" : key === "clear" ? clearAriaLabel ?? clearLabel : digitAriaLabel(key)}
          disabled={isKeyDisabled?.(key)}
          onClick={() => onKey(key)}
        >
          {numericKeyLabel(key, clearLabel, backspaceLabel)}
        </button>
      ))}
      {decimal && <button type="button" className={utilityButtonClassName ?? "coffee-diary-keypad__utility"} onClick={() => onKey("clear")}>{clearLabel}</button>}
    </div>
  );
}

export function NumericKeypad({
  value,
  onChange,
  onDone,
  decimal = true,
  maxLength = 12,
  maxDecimalPlaces = Number.POSITIVE_INFINITY,
  label = "Числовой ввод",
  testId = "coffee-diary-numeric-keypad",
  clearLabel = "Очистить"
}: {
  value: string;
  onChange: (value: string) => void;
  onDone: () => void;
  decimal?: boolean;
  maxLength?: number;
  maxDecimalPlaces?: number;
  label?: string;
  testId?: string;
  clearLabel?: string;
}) {
  const press = (key: NumericKey) => onChange(applyNumericKey(value, key, decimal, maxLength, maxDecimalPlaces));
  return (
    <section className="coffee-diary-keypad" data-testid={testId} aria-label={label}>
      <div className="coffee-diary-keypad__display" aria-live="polite">{value || "0"}</div>
      <NumericKeypadButtons decimal={decimal} onKey={press} clearLabel={clearLabel} backspaceLabel="⌫" />
      <button type="button" className="coffee-diary-keypad__done" disabled={numericInputValue(value) === null} onClick={onDone}>Готово</button>
    </section>
  );
}
