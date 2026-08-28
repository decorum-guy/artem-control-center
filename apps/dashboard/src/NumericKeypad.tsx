import { applyNumericKey, numericInputValue, type NumericKey } from "./coffeeDiaryNumeric";
import "./coffeeDiary.css";

export function NumericKeypad({
  value,
  onChange,
  onDone,
  decimal = true,
  maxLength = 12,
  maxDecimalPlaces = Number.POSITIVE_INFINITY,
  label = "Числовой ввод",
  testId = "coffee-diary-numeric-keypad"
}: {
  value: string;
  onChange: (value: string) => void;
  onDone: () => void;
  decimal?: boolean;
  maxLength?: number;
  maxDecimalPlaces?: number;
  label?: string;
  testId?: string;
}) {
  const press = (key: NumericKey) => onChange(applyNumericKey(value, key, decimal, maxLength, maxDecimalPlaces));
  const keys: NumericKey[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "backspace", "0", decimal ? "." : "clear"];
  return (
    <section className="coffee-diary-keypad" data-testid={testId} aria-label={label}>
      <div className="coffee-diary-keypad__display" aria-live="polite">{value || "0"}</div>
      <div className="coffee-diary-keypad__grid">
        {keys.map((key) => (
          <button
            key={key}
            type="button"
            className={key === "backspace" ? "coffee-diary-keypad__utility" : undefined}
            aria-label={key === "backspace" ? "Удалить цифру" : key === "." ? "Десятичный разделитель" : `Цифра ${key}`}
            onClick={() => press(key)}
          >
            {key === "backspace" ? "⌫" : key === "." ? "," : key}
          </button>
        ))}
        {decimal && <button type="button" className="coffee-diary-keypad__utility" onClick={() => press("clear")}>Очистить</button>}
      </div>
      <button type="button" className="coffee-diary-keypad__done" disabled={numericInputValue(value) === null} onClick={onDone}>Готово</button>
    </section>
  );
}
