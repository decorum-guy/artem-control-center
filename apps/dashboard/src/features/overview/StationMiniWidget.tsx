import type { CSSProperties } from "react";
import type { StationPlayback } from "@artem/contracts";
import { v3VisualSkinEnabled } from "../../visualShellConfig";
import { Icon } from "../../icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { executeStationAction, fetchStationAvailability, STATION_ACTIONS,
  type StationActionAvailability, type StationActionId } from "../../stationActionsApi";
import { WorkZone } from "../../ShellPrimitives";
import { DialogFrame } from "../../DialogFrame";
import { addStationPreset, deleteStationPreset, executeStationPreset, fetchStationPresets,
  type StationPresetInventory } from "../../stationPresetsApi";
import { resolveWidgetAsset } from "../../widgetAssets";
import { useInteractionLock } from "../../InteractionLock";
import { useNoticeCenter } from "../../NoticeCenter";
import { useCommandSeries } from "../../useCommandSeries";

const STATION_ARTWORK = resolveWidgetAsset("./assets/widgets/station-mini-2.png", v3VisualSkinEnabled);
const STATION_GLOW_FEEDBACK_DURATION_MS = 1200;
const TRACK_TRANSITION_MS = 320;
type VolumeStep = "media.alice.volume_up" | "media.alice.volume_down";
function isVolumeStep(action: StationActionId): action is VolumeStep {
  return action === "media.alice.volume_up" || action === "media.alice.volume_down";
}

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

function TrackCover({ source }: { source: string | null }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const available = source !== null && /^\/api\/v1\/station-playback\/cover\/[a-f0-9]{64}$/.test(source) && !failed;
  return <span className="station-mini-widget__cover" data-cover-loaded={loaded} aria-hidden="true">
    {!loaded && <span>♪</span>}
    {available && <img src={source} alt="" decoding="async" draggable={false}
      onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
  </span>;
}

function StationTrack({ track }: { track: StationPlayback | null }) {
  const previousTrack = useRef(track);
  const [exitComplete, setExitComplete] = useState(track === null);
  const hasTrack = track !== null;

  useLayoutEffect(() => {
    if (track) previousTrack.current = track;
  }, [track]);

  useEffect(() => {
    if (hasTrack) {
      setExitComplete(false);
      return;
    }
    const timeout = setTimeout(() => {
      previousTrack.current = null;
      setExitComplete(true);
    }, TRACK_TRANSITION_MS);
    return () => clearTimeout(timeout);
  }, [hasTrack]);

  const display = track ?? (exitComplete ? null : previousTrack.current);
  return <div className="station-mini-widget__track" data-track-layer=""
    data-testid={hasTrack ? "station-current-track" : undefined} aria-hidden={!hasTrack || undefined}>
    {display && <>
      <TrackCover key={display.coverPath} source={display.coverPath} />
      <div className="station-mini-widget__track-text">
        <strong title={display.title ?? undefined}>{display.title}</strong>
        {display.artist && <span title={display.artist}>{display.artist}</span>}
        {display.status === "paused" && <small>Пауза</small>}
      </div>
    </>}
  </div>;
}

export function StationMiniWidget({ interactive, playback }: {
  interactive: boolean;
  playback?: StationPlayback | null;
}) {
  const track = (playback?.status === "playing" || playback?.status === "paused") && playback.title ? playback : null;
  const { locked, guardMutation } = useInteractionLock();
  const { showNotice } = useNoticeCenter();
  const [availability, setAvailability] = useState<StationActionAvailability | null>(null);
  const [pending, setPending] = useState(false);
  const [glowPulse, setGlowPulse] = useState(0);
  const [glowActive, setGlowActive] = useState(false);
  const [artworkFailed, setArtworkFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"closed" | "music" | "manage" | "add">("closed");
  const [inventory, setInventory] = useState<StationPresetInventory | null>(null);
  const [title, setTitle] = useState("");
  const [command, setCommand] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [sheetMessage, setSheetMessage] = useState("");
  const musicButton = useRef<HTMLButtonElement>(null);
  const glowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const otherAction = useRef(false);
  const decisionEpoch = useRef(0);
  function refreshActions() {
    const epoch = ++decisionEpoch.current;
    void fetchStationAvailability().then(
      value => { if (epoch === decisionEpoch.current) setAvailability(value); },
      () => { if (epoch === decisionEpoch.current) setAvailability(null); }
    );
  }
  const volume = useCommandSeries<VolumeStep, void>({
    mode: "ordered", enabled: interactive && !locked,
    dispatch: async (step, signal) => {
      if (signal.aborted || !guardMutation() || !availability?.actions[step]?.allowed) throw new Error("blocked");
      await executeStationAction(step);
    },
    onFinish: ({ accepted, completed, error, cancelled }) => {
      const uncertain = error instanceof Error && error.message === "station_dispatch_uncertain";
      const detail = error || cancelled
        ? `Отправка подтверждена для ${completed} из ${accepted}. ${uncertain ? "Результат следующей команды неизвестен." : "Серия остановлена."}`
        : accepted === 1 ? "Команда отправлена" : `Команды громкости отправлены · ${completed}`;
      showNotice({ id: "station.volume", title: "Громкость Алисы", detail,
        severity: error || cancelled ? "warning" : "success" });
      refreshActions();
    }
  });

  useEffect(() => {
    refreshActions();
    return () => { decisionEpoch.current++; if (glowTimer.current) clearTimeout(glowTimer.current); };
  }, []);

  function triggerGlowFeedback() {
    setGlowPulse((pulse) => pulse + 1);
    setGlowActive(true);
    if (glowTimer.current) clearTimeout(glowTimer.current);
    glowTimer.current = setTimeout(() => {
      glowTimer.current = null;
      setGlowActive(false);
    }, STATION_GLOW_FEEDBACK_DURATION_MS);
  }

  async function run(actionId: StationActionId) {
    if (otherAction.current || !interactive || !guardMutation() || !availability?.actions[actionId]?.allowed) return;
    if (isVolumeStep(actionId)) {
      if (volume.submit(actionId)) { decisionEpoch.current++; setMessage(null); triggerGlowFeedback(); }
      return;
    }
    if (volume.isActive()) return;
    decisionEpoch.current++;
    otherAction.current = true;
    setPending(true);
    setMessage(null);
    triggerGlowFeedback();
    try {
      await executeStationAction(actionId);
      setMessage("Команда отправлена");
    } catch (error) {
      setMessage(error instanceof Error && error.message === "station_dispatch_uncertain"
        ? "Результат отправки неизвестен" : "Не удалось отправить команду");
    } finally {
      otherAction.current = false;
      setPending(false);
      refreshActions();
    }
  }

  async function refreshPresets() {
    try {
      setInventory(await fetchStationPresets());
    } catch {
      setSheetMessage("Список подборок временно недоступен");
    }
  }

  function closeSheet() {
    setSheet("closed");
    setTitle("");
    setCommand("");
    setDeleteId(null);
  }

  function openMusic() {
    if (!interactive) return;
    setSheet("music");
    setSheetMessage("");
    void refreshPresets();
  }

  async function runPreset(presetId: string) {
    if (otherAction.current || volume.isActive() || !guardMutation() || !availability?.actions["media.alice.play"]?.allowed) return;
    otherAction.current = true;
    setPending(true);
    triggerGlowFeedback();
    setSheetMessage("");
    try {
      await executeStationPreset(presetId);
      setMessage("Команда отправлена");
      closeSheet();
    } catch (error) {
      setSheetMessage(error instanceof Error && error.message === "station_dispatch_uncertain"
        ? "Результат отправки неизвестен" : "Не удалось отправить команду");
      if (error instanceof Error && error.message === "unknown_station_preset") void refreshPresets();
    } finally {
      otherAction.current = false;
      setPending(false);
    }
  }

  async function mutate(kind: "add" | "delete", presetId?: string) {
    if (!inventory || otherAction.current || volume.isActive() || !guardMutation()) return;
    otherAction.current = true;
    setPending(true);
    try {
      const next = kind === "add"
        ? await addStationPreset(inventory.revision, title, command)
        : await deleteStationPreset(inventory.revision, presetId ?? "");
      setInventory(next);
      setSheet("manage");
      setTitle("");
      setCommand("");
      setDeleteId(null);
      setSheetMessage("");
    } catch (error) {
      if (error instanceof Error && error.message === "revision_conflict") {
        await refreshPresets();
        setSheetMessage("Список изменился в другом интерфейсе. Показана актуальная версия.");
        setDeleteId(null);
      } else {
        setSheetMessage("Не удалось изменить подборки");
      }
    } finally {
      otherAction.current = false;
      setPending(false);
    }
  }

  return <WorkZone className="overview-v2-real-widget station-mini-widget" data-testid="overview-station-mini-widget" data-instrument-active={v3VisualSkinEnabled ? glowActive : undefined}>
    <header className="station-mini-widget__header">
      <h2>Станция Mini 2</h2>
      <p className="station-mini-widget__message" role="status">{volume.active ? "Меняем громкость…" : message ?? (availability ? "" : "Управление недоступно")}</p>
    </header>
    <div className="station-mini-widget__art" data-testid="station-artwork-slot" data-track-present={Boolean(track)}
      style={{ "--station-track-duration": `${TRACK_TRANSITION_MS}ms` } as CSSProperties}>
      <div className="station-mini-widget__speaker">
        <span key={glowPulse} className={`station-mini-widget__glow${glowActive ? " station-mini-widget__glow--active" : ""}`} aria-hidden="true" />
        {STATION_ARTWORK && !artworkFailed && <img className="station-mini-widget__image" src={STATION_ARTWORK}
          alt="" aria-hidden="true" draggable={false} decoding="async" onError={() => setArtworkFailed(true)} />}
        {(!STATION_ARTWORK || artworkFailed) && <svg className="station-mini-widget__fallback" viewBox="0 0 80 100" aria-hidden="true">
          <rect x="16" y="8" width="48" height="84" rx="20" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="40" cy="77" r="3" fill="currentColor" />
        </svg>}
      </div>
      <StationTrack track={track} />
      {playback?.status === "stale" && <small className="station-mini-widget__read-status">Нет связи с колонкой</small>}
      {playback?.status === "auth_required" && <small className="station-mini-widget__read-status">Требуется вход в Яндекс</small>}
    </div>
    <div className="station-mini-widget__controls" aria-label="Управление Станцией Mini 2">
      {STATION_ACTIONS.map((actionId) => <button key={actionId} type="button"
        className="station-mini-widget__button" aria-label={LABELS[actionId]} title={LABELS[actionId]}
        disabled={!interactive || locked || pending || (isVolumeStep(actionId) ? volume.full : volume.active) || !availability?.actions[actionId]?.allowed}
        aria-busy={pending || (volume.active && isVolumeStep(actionId))} onClick={() => { void run(actionId); }}>
        <ActionIcon actionId={actionId} />
      </button>)}
    </div>
    <button ref={musicButton} type="button" className="station-mini-widget__music" onClick={openMusic} aria-haspopup="dialog"
      disabled={!interactive}>🎵 Музыка <span aria-hidden="true">⌄</span></button>
    {sheet !== "closed" && <DialogFrame className="station-presets__sheet" testId="station-presets"
      title={sheet === "music" ? "Что включить?" : sheet === "manage" ? "Настроить подборки" : "Добавить подборку"}
      onClose={closeSheet} restoreFocusRef={musicButton}>
        {sheet === "music" && <>
          <div className="station-presets__list">
            {inventory?.presets.map((preset) => <button key={preset.id} type="button"
              className="station-presets__row" disabled={pending || volume.active || !availability?.actions["media.alice.play"]?.allowed}
              onClick={() => { void runPreset(preset.id); }}>
              <span>{preset.title}</span><span aria-hidden="true">{v3VisualSkinEnabled ? <Icon name="chevron-right" /> : "▶"}</span>
            </button>)}
          </div>
          {availability?.actions["media.alice.play"]?.allowed && <button className="station-presets__secondary"
            type="button" onClick={() => setSheet("manage")}>{v3VisualSkinEnabled ? <Icon name="settings" /> : "⚙"} Настроить подборки</button>}
        </>}
        {sheet === "manage" && <>
          <div className="station-presets__list">
            {inventory?.presets.map((preset) => <div className="station-presets__manage-row" key={preset.id}>
              <span>{preset.title}</span>
              <button type="button" onClick={() => setDeleteId(preset.id)}>Удалить</button>
            </div>)}
          </div>
          {deleteId && <div className="station-presets__confirm">
            <p>Удалить «{inventory?.presets.find((item) => item.id === deleteId)?.title}»?</p>
            <button type="button" disabled={pending} onClick={() => { void mutate("delete", deleteId); }}>Удалить</button>
            <button type="button" onClick={() => setDeleteId(null)}>Отмена</button>
          </div>}
          <button type="button" className="station-presets__secondary" onClick={() => { setSheet("add"); setSheetMessage(""); }}>{v3VisualSkinEnabled ? <Icon name="plus" /> : "➕"} Добавить</button>
          <button type="button" className="station-presets__secondary" onClick={() => setSheet("music")}>{v3VisualSkinEnabled ? <Icon name="chevron-left" /> : "←"} Назад</button>
        </>}
        {sheet === "add" && <form className="station-presets__form" onSubmit={(event) => { event.preventDefault(); void mutate("add"); }}>
          <label>Название кнопки<input value={title} maxLength={32} required onChange={(event) => setTitle(event.target.value)} /></label>
          <label>Команда для Алисы<input value={command} maxLength={160} required onChange={(event) => setCommand(event.target.value)} /></label>
          <button type="submit" disabled={pending || !title.trim() || !command.trim()}>Сохранить</button>
          <button type="button" onClick={() => { setTitle(""); setCommand(""); setSheet("manage"); }}>Отмена</button>
        </form>}
        <p className="station-presets__message" role="status">
          {sheetMessage || (sheet === "music" && !inventory ? "Загружаем подборки…" : "")}
        </p>
    </DialogFrame>}
  </WorkZone>;
}
