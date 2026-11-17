import { useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { Icon, type IconName } from "../icons";
import { Sheet } from "../Sheet";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: 48 | 56;
  icon?: IconName;
  pendingLabel?: string;
};

export function Button({ variant = "secondary", size = 48, icon, pendingLabel, disabled, className = "", children, ...props }: ButtonProps) {
  return (
    <button type="button" {...props} className={`cc-button ${className}`} data-variant={variant} data-size={size}
      aria-busy={pendingLabel ? true : undefined} disabled={disabled || Boolean(pendingLabel)}>
      {pendingLabel ? <i className="cc-live-dot" aria-hidden="true" /> : icon && <Icon name={icon} />}
      {pendingLabel ?? children}
    </button>
  );
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "stale" | "offline" | "unavailable" | "uncertain" | "heat";

export function StatusChip({ tone = "neutral", icon, label, running = false }: { tone?: Tone; icon: IconName; label: string; running?: boolean }) {
  return <span className="cc-status-chip" data-tone={tone} data-running={running}>
    <i className="cc-status-dot" aria-hidden="true" /><Icon name={icon} size={16} /><span>{label}</span>
  </span>;
}

export interface Choice { value: string; label: string; disabled?: boolean }
interface ChoiceProps {
  label: string; options: readonly Choice[]; value: string; onChange: (value: string) => void; disabled?: boolean;
}

function moveChoice(event: KeyboardEvent, index: number, options: readonly Choice[]): number | null {
  const enabled = options.map((option, i) => option.disabled ? -1 : i).filter((i) => i >= 0);
  if (!enabled.length) return null;
  const position = enabled.indexOf(index);
  switch (event.key) {
    case "Home": return enabled[0];
    case "End": return enabled[enabled.length - 1];
    case "ArrowDown":
    case "ArrowRight": return enabled[(position + 1) % enabled.length];
    case "ArrowUp":
    case "ArrowLeft": return enabled[(position - 1 + enabled.length) % enabled.length];
    default: return null;
  }
}

export function Select({ label, options, value, onChange, disabled, compact, testId }: ChoiceProps & { compact?: boolean; testId?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const initial = useRef<HTMLButtonElement>(null);
  const optionNodes = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const selected = options.find((option) => option.value === value);
  const initialOption = selected && !selected.disabled ? selected : options.find((option) => !option.disabled);
  return <>
    <button type="button" ref={trigger} className="cc-select" data-compact={Boolean(compact)} data-testid={testId}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={disabled || !initialOption} onClick={() => setOpen(true)}>
      <span><small>{label}</small><strong>{selected?.label ?? "—"}</strong></span><Icon name="chevron-down" />
    </button>
    {open && <Sheet title={label} testId="cc-select-sheet" onClose={() => setOpen(false)} initialFocusRef={initial} restoreFocusRef={trigger}>
      <div className="cc-select-options" id={id} role="listbox" aria-label={label}>
        {options.map((option, i) => <button type="button" key={option.value} role="option" aria-selected={option.value === value}
          ref={(node) => { optionNodes.current[i] = node; if (option === initialOption) initial.current = node; }}
          disabled={option.disabled} onKeyDown={(event) => {
            const next = moveChoice(event, i, options);
            if (next !== null) { event.preventDefault(); optionNodes.current[next]?.focus(); }
          }} onClick={() => { onChange(option.value); setOpen(false); }}>
          <i aria-hidden="true" />{option.label}
        </button>)}
      </div>
    </Sheet>}
  </>;
}

export function Segmented({ label, options, value, onChange, disabled }: ChoiceProps) {
  const nodes = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex((option) => option.value === value && !option.disabled);
  const tabStop = selected >= 0 ? selected : options.findIndex((option) => !option.disabled);
  return <div className="cc-segmented" role="radiogroup" aria-label={label}>
    {options.map((option, i) => <button type="button" role="radio" key={option.value}
      ref={(node) => { nodes.current[i] = node; }} aria-checked={option.value === value} tabIndex={i === tabStop ? 0 : -1}
      disabled={disabled || option.disabled} onClick={() => onChange(option.value)}
      onKeyDown={(event) => {
        const next = moveChoice(event, i, options);
        if (next !== null) { event.preventDefault(); onChange(options[next].value); nodes.current[next]?.focus(); }
      }}>{option.label}</button>)}
  </div>;
}

export function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" className="cc-switch" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
    <span>{label}</span><i aria-hidden="true" />
  </button>;
}

interface NumericControl {
  label: string; value: number; min: number; max: number; step?: number; unit?: string;
  disabled?: boolean; onChange: (value: number) => void;
}

function bounded(value: number, min: number, max: number, step: number): number {
  const rounded = Number((min + Math.round((value - min) / step) * step).toFixed(8));
  return Math.max(min, Math.min(max, rounded));
}

export function Slider({ label, value, min, max, step = 1, unit = "", disabled, onChange, onCommit, heat, testId }:
  NumericControl & { heat?: boolean; onCommit?: (value: number) => void; testId?: string }) {
  const id = useId();
  const drag = useRef<number | null>(null);
  const ratio = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  function pointerValue(event: PointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const percent = (event.clientX - rect.left - 12) / Math.max(1, rect.width - 24);
    return bounded(min + percent * (max - min), min, max, step);
  }
  return <div className="cc-slider-field" data-heat={heat || undefined}>
    <div className="cc-slider-copy"><span id={id}>{label}</span><output>{value}{unit}</output></div>
    <div className="cc-slider" role="slider" aria-labelledby={id} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}
      aria-valuetext={`${value}${unit}`} aria-disabled={Boolean(disabled)} tabIndex={disabled ? -1 : 0} data-testid={testId}
      style={{ "--cc-fill": `${ratio * 100}%` } as CSSProperties}
      onPointerDown={(event) => {
        if (disabled || !event.isPrimary || event.button !== 0) return;
        event.currentTarget.focus();
        drag.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        onChange(pointerValue(event));
      }}
      onPointerMove={(event) => { if (!disabled && event.pointerId === drag.current) onChange(pointerValue(event)); }}
      onPointerUp={(event) => {
        if (event.pointerId !== drag.current) return;
        drag.current = null;
        if (!disabled) { const next = pointerValue(event); onChange(next); onCommit?.(next); }
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => {
        if (disabled) return;
        const values: Record<string, number> = {
          ArrowRight: value + step, ArrowUp: value + step, ArrowLeft: value - step, ArrowDown: value - step,
          PageUp: value + step * 10, PageDown: value - step * 10, Home: min, End: max
        };
        if (!(event.key in values)) return;
        event.preventDefault();
        const next = bounded(values[event.key], min, max, step);
        onChange(next); onCommit?.(next);
      }}>
      <span className="cc-slider-track"><i /></span>
    </div>
  </div>;
}

export function Stepper({ label, value, min, max, step = 1, unit = "", disabled, onChange }: NumericControl) {
  return <div className="cc-stepper" role="group" aria-label={label}>
    <Button icon="minus" aria-label={`Уменьшить: ${label}`} disabled={disabled || value <= min} onClick={() => onChange(bounded(value - step, min, max, step))} />
    <output aria-live="polite">{value}<small>{unit}</small></output>
    <Button icon="plus" aria-label={`Увеличить: ${label}`} disabled={disabled || value >= max} onClick={() => onChange(bounded(value + step, min, max, step))} />
  </div>;
}
