import type { ReactNode } from "react";

export function SettingsSummaryRow({
  title,
  summary,
  stateLabel,
  stateTone = "neutral",
  onClick,
  testId
}: {
  title: string;
  summary: string;
  stateLabel?: string;
  stateTone?: "neutral" | "success" | "warning" | "unavailable";
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      className="settings-summary-row"
      data-testid={testId}
      onClick={onClick}
    >
      <span className="settings-summary-row__copy">
        <strong>{title}</strong>
        <span>{summary}</span>
      </span>
      <span className="settings-summary-row__end">
        {stateLabel && (
          <span className={`settings-summary-row__state settings-summary-row__state--${stateTone}`}>
            {stateLabel}
          </span>
        )}
        <span className="settings-summary-row__chevron" aria-hidden="true">›</span>
      </span>
    </button>
  );
}

export function SettingsSummaryColumn({ children }: { children: ReactNode }) {
  return <div className="settings-summary-column">{children}</div>;
}
