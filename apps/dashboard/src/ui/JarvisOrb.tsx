export type OrbState = "idle" | "processing" | "listening" | "transcribing" | "submitting" | "speaking" | "ready" | "error";

export function JarvisOrb({ state }: { state: OrbState }) {
  return <span className="cc-jarvis-orb" data-orb-state={state} aria-hidden="true">
    <svg viewBox="0 0 48 48" fill="none">
      <circle className="cc-orb-rim" cx="24" cy="24" r="21" />
      <g className="cc-orb-orbit">
        <circle cx="24" cy="24" r="17.2" strokeDasharray="49 9 23 27" />
        <circle cx="24" cy="24" r="12.5" strokeDasharray="3 5" />
      </g>
      <path className="cc-orb-wave" d="M13 24h4l3-5 3 11 3-14 3 10 2-2h4" />
    </svg>
  </span>;
}
