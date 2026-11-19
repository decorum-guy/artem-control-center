import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Tone } from "./Controls";

const degrees = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

export type RingReading =
  | { kind: "progress"; fraction: number }
  | { kind: "stages"; count: number; active: number }
  | { kind: "idle" | "stale" | "unavailable" | "running_too_long" };

interface Face { reading: RingReading; tone: Tone }
interface Props extends Face { size?: 64 | 96 | 148; label: string; children?: ReactNode }

function RingFace({ reading, tone, size }: Face & { size: number }) {
  const center = size / 2;
  const width = size === 148 ? 8 : 6;
  const radius = center - width;
  const circle = { cx: center, cy: center, r: radius, fill: "none", strokeWidth: width, pathLength: 100 };
  const offline = reading.kind === "stale" || reading.kind === "unavailable";
  const warning = reading.kind === "running_too_long";
  const count = reading.kind === "stages" ? Math.max(1, Math.min(32, Math.trunc(reading.count))) : 1;
  const faceTone = warning ? "warning" : offline ? "offline" : tone;
  const trackClass = warning ? "cc-gauge-value" : `cc-gauge-track${offline ? " cc-gauge-track--dashed" : ""}`;
  return <g data-tone={faceTone} transform={`rotate(-90 ${center} ${center})`}>
    <circle {...circle} className={trackClass}
      strokeDasharray={offline ? "2 6" : reading.kind === "stages" ? `${80 / count} ${20 / count}` : undefined} />
    {reading.kind === "progress" && Number.isFinite(reading.fraction) && reading.fraction > 0 &&
      <circle {...circle} className="cc-gauge-value" strokeLinecap="round" strokeDasharray={`${Math.min(1, reading.fraction) * 100} 100`} />}
    {reading.kind === "stages" && reading.active >= 0 && reading.active < count &&
      <circle {...circle} className="cc-gauge-value" strokeDasharray={`${80 / count} 100`} strokeDashoffset={-reading.active * 100 / count} />}
  </g>;
}

export function RingGauge({ reading, tone, size = 96, label, children }: Props) {
  const current = useRef<Face>({ reading, tone });
  const [previous, setPrevious] = useState<Face | null>(null);
  const appearance = tone + ":" + reading.kind;
  useLayoutEffect(() => {
    const old = current.current;
    if (old.tone !== tone || old.reading.kind !== reading.kind) setPrevious(old);
    current.current = { tone, reading };
  }, [tone, reading]);
  useLayoutEffect(() => {
    if (!previous) return;
    const timer = window.setTimeout(() => setPrevious(null), 420);
    return () => window.clearTimeout(timer);
  }, [previous]);
  const diameter = `var(--cc-gauge-size, ${size}px)`;
  return <span className="cc-gauge" role="img" aria-label={label} style={{ width: diameter, height: diameter }}>
    <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {previous && <g className="cc-gauge-old"><RingFace {...previous} size={size} /></g>}
      <g key={appearance} className={previous ? "cc-gauge-new" : undefined}><RingFace reading={reading} tone={tone} size={size} /></g>
    </svg>
    {children && <span className="cc-gauge-center" data-characters={typeof children === "string" ? children.length : undefined} aria-hidden="true">{children}</span>}
  </span>;
}

export function TemperatureGauge({ value, label, reading, tone }: Face & { value: number | null | undefined; label: string }) {
  const text = (typeof value === "number" && Number.isFinite(value) ? degrees.format(value) : "—") + "°";
  return <RingGauge size={64} label={label + " " + text} reading={reading} tone={tone}>{text}</RingGauge>;
}
