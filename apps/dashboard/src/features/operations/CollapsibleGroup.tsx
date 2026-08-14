import { useId, useState, type ReactNode } from "react";

export function CollapsibleGroup({
  label,
  count,
  children,
  defaultOpen = false,
  testId
}: {
  label: string;
  count: number;
  children: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = `${useId().replace(/:/g, "")}-body`;
  return (
    <section className={`collapsible-group${open ? " collapsible-group--open" : ""}`} data-testid={testId}>
      <button
        type="button"
        className="collapsible-group__summary"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="collapsible-group__copy">
          <strong>{label}</strong>
          <span>{count} {count === 1 ? "сервис" : "сервиса"} в норме</span>
        </span>
        <span className="collapsible-group__disclosure" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && <div id={bodyId} className="collapsible-group__body">{children}</div>}
    </section>
  );
}
