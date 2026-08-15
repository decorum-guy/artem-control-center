export function SettingSwitchRow({
  label,
  checked,
  onChange,
  disabled = false,
  description,
  testId
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  description?: string;
  testId?: string;
}) {
  return (
    <label
      className={`setting-switch-row${disabled ? " setting-switch-row--disabled" : ""}`}
      data-testid={testId}
    >
      <span className="setting-switch-row__copy">
        <span>{label}</span>
        {description && <small>{description}</small>}
      </span>
      <span className="setting-switch-row__control">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="setting-switch-row__visual" aria-hidden="true">
          <span className="setting-switch-row__thumb" />
          <span className="setting-switch-row__state">{checked ? "Вкл" : "Выкл"}</span>
        </span>
      </span>
    </label>
  );
}
