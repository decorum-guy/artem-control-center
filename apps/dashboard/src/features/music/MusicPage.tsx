import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StationPlayback } from "@artem/contracts";
import { useInteractionLock } from "../../InteractionLock";
import { useInterfaceCopy } from "../../interfaceCopy";
import { Icon, type IconName } from "../../icons";
import { Sheet } from "../../Sheet";
import { PageHeader } from "../../ui/PageHeader";
import { executeStationAction, fetchStationAvailability, type StationActionAvailability, type StationActionId } from "../../stationActionsApi";
import { useCommandSeries } from "../../useCommandSeries";
import { MUSIC_ROW_HEIGHT, useMusicLibrary, type Provider, type Recording } from "./musicLibraryStore";
import "./musicPage.css";

const labels: Record<Provider, string> = { yandex: "Яндекс Музыка", youtube: "YouTube Music" };
const libraryErrors: Record<string, string> = {
  auth_required: "Нужно подключить аккаунт.",
  not_configured: "Источник пока не подключён.",
  page_expired: "Порция устарела. Обновите список.",
  account_changed: "Аккаунт изменился. Обновите список.",
  source_unavailable: "Источник временно недоступен.",
  busy: "Библиотека занята. Повторите чуть позже."
};
const outcomes: Record<string, string> = {
  already_playing: "Эта запись уже играет.",
  playing: "Станция подтвердила воспроизведение.",
  no_match: "В Яндекс Музыке подходящая запись не найдена.",
  unavailable: "Станция или источник сейчас недоступны.",
  unconfirmed: "Запуск не подтверждён.",
  blocked: "Управление недоступно в этом профиле.",
  play_blocked: "Управление недоступно в этом профиле.",
  busy: "Станция выполняет предыдущую команду.",
  auth_required: "Нужно заново подключить источник.",
  choice_expired: "Выбор устарел. Нажмите «Включить на Станции» ещё раз.",
  row_expired: "Обновите список перед запуском этой записи.",
  account_changed: "Аккаунт изменился. Выберите запись заново."
};

function Artwork({ url, className = "" }: { url?: string | null; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const visible = url && failed !== url;
  return <span className={`music-art ${className}`}>
    {visible ? <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(url)} />
      : <Icon name="music" size={19} />}
  </span>;
}

const buttons: ReadonlyArray<{ action: StationActionId; icon: IconName; title: string }> = [
  { action: "media.alice.previous", icon: "previous", title: "Предыдущая песня" },
  { action: "media.alice.next", icon: "next", title: "Следующая песня" },
  { action: "media.alice.volume_down", icon: "minus", title: "Тише" },
  { action: "media.alice.volume_up", icon: "plus", title: "Громче" }
];

const StationMiniPlayer = memo(function StationMiniPlayer({ playback }: { playback?: StationPlayback | null }) {
  const { locked, guardMutation } = useInteractionLock();
  const [available, setAvailable] = useState<StationActionAvailability | null>(null);
  const [message, setMessage] = useState("");
  const playing = playback?.status === "playing";
  const paused = playback?.status === "paused";
  const live = playing || paused;
  const playbackLabel = playing ? "Играет" : paused ? "Пауза" : playback?.status === "auth_required"
    ? "Нужно подключить Станцию" : playback?.status === "idle" ? "Музыка не играет" : "Нет свежего состояния";
  useEffect(() => {
    let active = true;
    const stopped = () => { active = false; };
    void fetchStationAvailability().then(result => { if (active) setAvailable(result); }).catch(() => {});
    return stopped;
  }, []);
  const queue = useCommandSeries<StationActionId, unknown>({
    mode: "ordered", enabled: !locked,
    dispatch: async (action, signal) => {
      if (signal.aborted || !guardMutation()) throw new Error("locked");
      return executeStationAction(action);
    },
    onFinish: ({ cancelled, error }) => {
      if (!cancelled) {
        setMessage(error ? "Результат команды не подтверждён." : "");
        void fetchStationAvailability().then(setAvailable).catch(() => setAvailable(null));
      }
    }
  });
  const actions = [buttons[0], {
    action: playing ? "media.alice.pause" as const : "media.alice.play" as const,
    icon: playing ? "pause" as const : "play" as const,
    title: playing ? "Пауза" : "Продолжить"
  }, ...buttons.slice(1)];
  return <section className="music-mini" aria-label="Плеер Яндекс Станции" data-playing={playing}>
    <Artwork url={live ? playback.coverPath : null} className="music-mini__art" />
    <div className="music-mini__meta">
      <span className="music-mini__status"><i aria-hidden="true" /> Яндекс Станция · {playbackLabel}</span>
      <strong>{live && playback.title ? playback.title : "Мини 2"}</strong>
      <small>{live && playback.artist ? playback.artist : message || "\u00a0"}</small>
    </div>
    <div className="music-mini__controls" aria-label="Управление воспроизведением">
      {actions.map(item => <button key={item.action} type="button" className="music-icon-button"
        data-primary={item.icon === "play" || item.icon === "pause"}
        aria-label={item.title} title={item.title}
        aria-busy={queue.pending().includes(item.action)}
        disabled={locked || queue.full || !available?.actions[item.action]?.allowed}
        onClick={() => { if (guardMutation()) { setMessage(""); queue.submit(item.action); } }}>
        <Icon name={item.icon} size={20} />
      </button>)}
    </div>
    {message && live && <span role="status" className="music-mini__notice">{message}</span>}
  </section>;
});

function duration(value: number | null) {
  return value ? `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}` : "";
}

const LibraryPanel = memo(function LibraryPanel({ provider, current }: { provider: Provider; current?: string | null }) {
  const [library, state] = useMusicLibrary(provider);
  const { locked, guardMutation } = useInteractionLock();
  const list = library.getList(state.selected);
  const listNode = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(360);
  const [active, setActive] = useState<string | null>(null);
  const gate = useRef(false);
  const [result, setResult] = useState<{ message: string; record: Recording } | null>(null);
  const [choose, setChoose] = useState<{ original: Recording; options: Recording[] } | null>(null);
  const [matched, setMatched] = useState<{ key: string; stationId: string } | null>(null);
  const presence = useRef(true);

  useEffect(() => {
    presence.current = true;
    void library.sync();
    const timer = window.setInterval(() => { if (!document.hidden) void library.sync(); }, 20_000);
    const wake = () => { if (!document.hidden) void library.sync(); };
    document.addEventListener("visibilitychange", wake);
    return () => { presence.current = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", wake); };
  }, [library]);

  useEffect(() => {
    setResult(null);
    setChoose(null);
    setMatched(null);
  }, [state.selected, state.generation]);

  useLayoutEffect(() => {
    const node = listNode.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.clientHeight));
    observer.observe(node);
    setHeight(node.clientHeight);
    return () => observer.disconnect();
  }, [state.selected]);

  useLayoutEffect(() => {
    if (listNode.current && Math.abs(listNode.current.scrollTop - list.scroll) >= 1) listNode.current.scrollTop = list.scroll;
  }, [state.selected, list.scroll, list.items.length]);

  const filtered = useMemo(() => {
    const term = list.query.trim().toLocaleLowerCase("ru");
    return term ? list.items.filter(item => `${item.title} ${item.artist}`.toLocaleLowerCase("ru").includes(term)) : list.items;
  }, [list.items, list.query]);
  const from = Math.max(0, Math.floor(list.scroll / MUSIC_ROW_HEIGHT) - 4);
  const to = Math.min(filtered.length, from + Math.ceil(height / MUSIC_ROW_HEIGHT) + 9);
  const visible = filtered.slice(from, to);

  async function play(record: Recording, choice?: string) {
    if (gate.current || !guardMutation()) return;
    gate.current = true;
    const { generation, selected } = library.read();
    setActive(record.key);
    setChoose(null);
    setResult(null);
    const currentSelection = () => presence.current && library.read().generation === generation && library.read().selected === selected;
    try {
      const response = await library.play(record, choice);
      if (!currentSelection()) return;
      if (response.status === "choose" && response.options?.length) {
        setChoose({ original: record, options: response.options });
      } else {
        setResult({ message: outcomes[response.status] ?? "Запуск не подтверждён.", record });
        if (response.stationTrackId) setMatched({ key: record.key, stationId: response.stationTrackId });
      }
    } catch (error) {
      if (currentSelection()) setResult({
        record, message: outcomes[error instanceof Error ? error.message : "unconfirmed"] ?? outcomes.unconfirmed
      });
    } finally {
      gate.current = false;
      if (presence.current) setActive(null);
    }
  }

  const errors = state.catalogError || list.error || (["auth_required", "not_configured", "unavailable"].includes(state.status) ? state.status : null);
  const errorText = errors ? libraryErrors[errors] ?? libraryErrors.source_unavailable : "";
  const emptyText = state.catalogPending || list.pending ? "Загрузка…"
    : errors && !list.observedAt ? "Данные пока недоступны."
    : state.selected ? list.query ? "Среди загруженных записей совпадений нет." : "В списке пока нет записей."
    : "Выберите плейлист.";
  const subtitle = provider === "youtube" ? "На Станции играет версия из Яндекс Музыки" : "";
  const retry = () => {
    if (state.selected) void library.tracks(false, true);
    else void library.sync().then(() => library.catalog());
  };

  return <section className="music-library" data-provider={provider} aria-label={labels[provider]}>
    <header className="music-library__head">
      <span className="music-library__badge" aria-hidden="true"><Icon name={provider === "youtube" ? "play" : "music"} size={18} /></span>
      <div><h2>{labels[provider]}</h2>{subtitle && <p>{subtitle}</p>}</div>
    </header>
    <div className="music-picker" aria-label={`Плейлисты · ${labels[provider]}`}>
      {state.playlists.map(playlist => <button type="button" key={playlist.key}
        aria-pressed={state.selected === playlist.key} title={playlist.title}
        disabled={Boolean(active)} onClick={() => library.select(playlist.key)}>
        <Artwork url={playlist.cover} />
        <span><strong>{playlist.title}</strong>{playlist.count !== null && <small>{playlist.count} треков</small>}</span>
      </button>)}
      {state.catalogNext && <button type="button" disabled={state.catalogPending}
        onClick={() => void library.catalog(true)} className="music-picker__more">Ещё плейлисты <Icon name="chevron-right" size={18} /></button>}
    </div>
    <div className="music-library__tools">
      <input type="search" value={list.query} maxLength={90} disabled={!state.selected}
        aria-label={`Поиск · ${labels[provider]}`} placeholder="Среди загруженных треков"
        onChange={event => library.search(event.currentTarget.value)} />
      <button type="button" className="music-icon-button" aria-label={`Обновить · ${labels[provider]}`}
        title="Обновить список" disabled={Boolean(active) || state.catalogPending || list.pending} onClick={retry}>
        <Icon name="refresh" size={18} />
      </button>
    </div>
    <p className="music-library__notice" role="status">{active ? "Ждём Станцию…"
      : result ? <>{result.message} <strong>{result.record.title}</strong></>
      : errorText || (list.omitted ? "Показаны последние загруженные позиции." : list.next ? "Список загружен частично" : "")}</p>
    <div className="music-tracks" ref={listNode} tabIndex={0} role="region" aria-label={`Треки · ${labels[provider]}`}
      onScroll={event => {
        const node = event.currentTarget;
        library.scroll(node.scrollTop);
        if (!list.query && node.scrollTop > 0 && node.scrollHeight - node.scrollTop - node.clientHeight < MUSIC_ROW_HEIGHT * 4
            && list.next && !list.error) void library.tracks(true);
      }}>
      {visible.length ? <div role="list" className="music-tracks__list">
        <div aria-hidden="true" style={{ height: from * MUSIC_ROW_HEIGHT }} />
        {visible.map(track => {
          const selected = Boolean(current && (provider === "yandex" ? current === track.trackId
            : matched?.key === track.key && current === matched.stationId));
          return <div className="music-track" role="listitem" key={track.key} data-playing={selected}>
            <Artwork url={track.cover} />
            <div className="music-track__meta">
              <strong title={track.title}>{track.title}</strong>
              <span>{[track.artist, track.album, duration(track.duration)].filter(Boolean).join(" · ")}</span>
            </div>
            <button type="button" className="music-icon-button" disabled={!track.playable || !state.canPlay || locked || Boolean(active)}
              title={selected ? "Играет на Станции" : "Включить на Станции"}
              aria-label={`Включить на Станции · ${track.title}`} aria-busy={active === track.key}
              onClick={() => void play(track)}><Icon name={selected ? "signal" : "play"} size={18} /></button>
          </div>;
        })}
        <div aria-hidden="true" style={{ height: Math.max(0, filtered.length - to) * MUSIC_ROW_HEIGHT }} />
      </div> : <p className="music-tracks__empty">{emptyText}</p>}
    </div>
    <footer className="music-library__footer">
      <span>{list.observedAt ? `Загружено: ${list.items.length}` : ""}</span>
      {list.next && <button type="button" className="music-load" disabled={list.pending || Boolean(active)}
        onClick={() => void library.tracks(true)}>{list.pending ? "Загружаем…" : "Загрузить ещё"}</button>}
    </footer>
    {choose && <Sheet title="Выберите запись в Яндекс Музыке" description={choose.original.title} onClose={() => setChoose(null)}>
      <div className="music-options">
        {choose.options.map(option => <button type="button" key={option.key} onClick={() => void play(choose.original, option.key)}>
          <strong>{option.title}</strong><span>{[option.artist, option.album, duration(option.duration)].filter(Boolean).join(" · ")}</span>
        </button>)}
      </div>
    </Sheet>}
  </section>;
});

export function MusicPage({ playback }: { playback?: StationPlayback | null }) {
  const { copy } = useInterfaceCopy();
  const displayedTrack = playback?.status === "playing" ? playback.trackId : undefined;
  return <main className="music-page" data-testid="route-music">
    <PageHeader title={copy("page.music.title")} description={copy("page.music.subtitle")} variant="compact" />
    <StationMiniPlayer playback={playback} />
    <div className="music-page__libraries"><LibraryPanel provider="yandex" current={displayedTrack} /><LibraryPanel provider="youtube" current={displayedTrack} /></div>
  </main>;
}
