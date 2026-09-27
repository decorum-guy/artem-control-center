import { useEffect, useRef, useState } from "react";
import { executeStationAction, fetchStationAvailability, STATION_ACTIONS,
  type StationActionAvailability, type StationActionId } from "../../stationActionsApi";
import { WorkZone } from "../../ShellPrimitives";

const LABELS: Record<StationActionId, string> = {
  "media.alice.play": "Play",
  "media.alice.pause": "Pause",
  "media.alice.volume_down": "Volume down",
  "media.alice.volume_up": "Volume up",
  "media.alice.previous": "Previous track",
  "media.alice.next": "Next track",
  "media.alice.like": "Like current track"
};

function ActionIcon({ actionId }: { actionId: StationActionId }) {
  const name = actionId.slice("media.alice.".length);
  return <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "play" && <path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none" />}
    {name === "pause" && <><path d="M8 5v14" strokeWidth="3" /><path d="M16 5v14" strokeWidth="3" /></>}
    {(name === "volume_down" || name === "volume_up") && <>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      <path d="M17 10v4" />
      {name === "volume_up" && <path d="M15 12h4" />}
    </>}
    {(name === "previous" || name === "next") && <>
      {name === "previous" ? <><path d="M5 5v14" /><path d="m18 5-11 7 11 7z" /></>
        : <><path d="M19 5v14" /><path d="M6 5 17 12 6 19z" /></>}
    </>}
    {name === "like" && <path d="M12 20s-8-4.8-8-10a4.2 4.2 0 0 1 8-1.7A4.2 4.2 0 0 1 20 10c0 5.2-8 10-8 10z" />}
  </svg>;
}

export function StationMiniWidget({ interactive }: { interactive: boolean }) {
  const [availability, setAvailability] = useState<StationActionAvailability | null>(null);
  const [pending, setPending] = useState(false);
  const [glow, setGlow] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const glowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    void fetchStationAvailability().then((value) => { if (active) setAvailability(value); })
      .catch(() => { if (active) setAvailability(null); });
    return () => { active = false; if (glowTimer.current) clearTimeout(glowTimer.current); };
  }, []);

  async function run(actionId: StationActionId) {
    if (pending || !interactive || !availability?.actions[actionId]?.allowed) return;
    setPending(true);
    setMessage(null);
    setGlow(true);
    if (glowTimer.current) clearTimeout(glowTimer.current);
    glowTimer.current = setTimeout(() => setGlow(false), 420);
    try {
      await executeStationAction(actionId);
      setMessage("Команда отправлена");
    } catch (error) {
      setMessage(error instanceof Error && error.message === "station_dispatch_uncertain"
        ? "Результат отправки неизвестен" : "Не удалось отправить команду");
    } finally {
      setPending(false);
      void fetchStationAvailability().then(setAvailability).catch(() => setAvailability(null));
    }
  }

  return <WorkZone className="overview-v2-real-widget station-mini-widget" data-testid="overview-station-mini-widget">
    <header className="station-mini-widget__header"><h2>Станция Mini 2</h2></header>
    <div className="station-mini-widget__art" data-testid="station-artwork-slot">
      <span className={`station-mini-widget__glow${glow ? " station-mini-widget__glow--active" : ""}`} aria-hidden="true" />
      <svg className="station-mini-widget__fallback" viewBox="0 0 80 100" aria-hidden="true">
        <rect x="16" y="8" width="48" height="84" rx="20" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="40" cy="77" r="3" fill="currentColor" />
      </svg>
    </div>
    <div className="station-mini-widget__controls" aria-label="Управление Станцией Mini 2">
      {STATION_ACTIONS.map((actionId) => <button key={actionId} type="button"
        className="station-mini-widget__button" aria-label={LABELS[actionId]} title={LABELS[actionId]}
        disabled={!interactive || pending || !availability?.actions[actionId]?.allowed}
        aria-busy={pending} onClick={() => { void run(actionId); }}>
        <ActionIcon actionId={actionId} />
      </button>)}
    </div>
    <p className="station-mini-widget__message" role="status">{message ?? (availability ? "" : "Управление недоступно")}</p>
  </WorkZone>;
}
