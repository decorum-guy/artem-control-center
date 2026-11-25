import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ServiceSnapshot, StationPlayback } from "@artem/contracts";
import { useInteractionLock } from "../../InteractionLock";
import { useInterfaceCopy } from "../../interfaceCopy";
import { Icon, type IconName } from "../../icons";
import { Sheet } from "../../Sheet";
import { YouTubeConnectionSettings } from "../settings/YouTubeConnectionSettings";
import { PageHeader } from "../../ui/PageHeader";
import { executeStationAction, fetchStationAvailability, type StationActionAvailability, type StationActionId } from "../../stationActionsApi";
import { useCommandSeries } from "../../useCommandSeries";
import { filterTracks, MUSIC_ROW_HEIGHT, playlistPlaybackAction, readPlaylistPlayback, useMusicLibrary, type PlaylistPlayback, type PlaylistSearchResult, type Provider, type Recording } from "./musicLibraryStore";
import { musicSaveEndpoint, resultLabels, submitMusicSave, type MusicProjection } from "./musicSaveApi";
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

const StationMiniPlayer = memo(function StationMiniPlayer({ playback: snapshotPlayback }: { playback?: StationPlayback | null }) {
  const { locked, guardMutation } = useInteractionLock();
  const [available, setAvailable] = useState<StationActionAvailability | null>(null);
  const [message, setMessage] = useState("");
  const [musicSave, setMusicSave] = useState<MusicProjection>();
  const [actionPending, setActionPending] = useState(false);
  const actionGate = useRef(false);
  const manualOperation = useRef<string | undefined>(undefined);
  const [now, setNow] = useState(Date.now);
  const [station, setStation] = useState<StationPlayback | null>(null);
  const stationTime = Date.parse(station?.observedAt ?? "");
  const snapshotTime = Date.parse(snapshotPlayback?.observedAt ?? "");
  const playback = station && !(snapshotTime > stationTime) ? station : snapshotPlayback;
  const observed = Date.parse(playback?.observedAt ?? "");
  const fresh = playback?.status !== "stale" && playback?.status !== "auth_required" && now - observed < 35_000;
  const trackId = fresh && playback?.trackId && /^[0-9]{1,20}$/.test(playback.trackId) ? playback.trackId : null;
  const volume = fresh && typeof playback?.volume === "number" ? Math.round(playback.volume * 100) : null;
  const operation = musicSave?.operation;
  const result = operation && operation.id === manualOperation.current ? operation : null;

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function poll() {
      setNow(Date.now());
      try {
        const response = await fetch(musicSaveEndpoint, { cache: "no-store", signal: controller.signal });
        if (response.ok && !actionGate.current) {
          const data = await response.json() as MusicProjection | null;
          if (!controller.signal.aborted && !actionGate.current) setMusicSave(data ?? undefined);
        }
      } catch {
        // Keep the latest operation during transient polling errors.
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(poll, 3000);
      }
    }
    async function readStation() {
      try {
        const response = await fetch("/api/v1/station-playback", { cache: "no-store", signal: controller.signal });
        if (response.ok) {
          const state = await response.json() as StationPlayback | null;
          if (!controller.signal.aborted) setStation(state);
        }
      } catch {
        // Freshness is checked against the last observed frame.
      }
    }
    void poll();
    void readStation();
    const stationTimer = window.setInterval(() => { if (!document.hidden) void readStation(); }, 8_000);
    return () => { controller.abort(); window.clearTimeout(timer); window.clearInterval(stationTimer); };
  }, []);

  async function like(provider: Provider, choiceId?: string) {
    if (actionGate.current || (!choiceId && !trackId) || !guardMutation()) return;
    actionGate.current = true;
    setActionPending(true);
    setMessage("");
    try {
      if (provider === "youtube") {
        const projection = choiceId && result ? await submitMusicSave("choose", {
          operationId: result.id, stage: result.status, choiceId
        }) : await submitMusicSave("start", { trackId });
        manualOperation.current = projection.operation?.id;
        setMusicSave(projection);
      } else {
        const response = await fetch("/api/v1/music/yandex/like-current", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Panel-Intent": "music-library" },
          body: JSON.stringify({ trackId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail);
        const detail = data.status === "liked" ? "Лайк в Яндекс Музыке подтверждён"
          : data.status === "already_liked" ? "Трек уже в «Мне нравится»"
          : data.status === "blocked" ? "Лайк недоступен в этом профиле"
          : "Результат лайка в Яндекс Музыке не подтверждён";
        setMessage(`${playback?.title ?? "Трек"} · ${detail}`);
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setMessage(code === "track_changed" ? "Трек сменился или его состояние устарело."
        : code === "music_busy" || code === "busy" ? "Дождитесь результата предыдущего действия."
        : code === "source_unavailable" ? "Источник временно недоступен."
        : "Результат действия не подтверждён.");
    } finally {
      actionGate.current = false;
      setActionPending(false);
    }
  }
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
      <span className="music-mini__status"><i aria-hidden="true" /> Яндекс Станция · {playbackLabel}{volume !== null && ` · Громкость ${volume}%`}</span>
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
      <button type="button" className="music-load" aria-label="Лайк в Яндекс Музыке"
        title={trackId ? "Лайк в Яндекс Музыке" : "Нет свежих данных о треке"}
        disabled={locked || actionPending || !trackId || !available?.actions["media.alice.like"]?.allowed}
        onClick={() => void like("yandex")}>♥ Яндекс</button>
      <button type="button" className="music-load" aria-label="Сохранить в YouTube"
        title={trackId ? "Сохранить в YouTube" : "Нет свежих данных о треке"}
        disabled={locked || actionPending || !trackId || !musicSave?.canStart ||
          operation?.status === "working" || operation?.status.startsWith("choose_")}
        onClick={() => void like("youtube")}>♥ YouTube</button>
    </div>
    {(!trackId && live) && <small className="music-mini__feedback">Лайки доступны при свежих данных о треке.</small>}
    {(message || result) && <div className="music-mini__feedback">
      <p role="status">{message || [result?.title, result && resultLabels[result.status]].filter(Boolean).join(" · ")}</p>
      {result?.status === "choose_version" && <ul className="music-save-options">
        {result.options.map(option => <li key={option.id}>
          <button type="button" className="music-load" disabled={locked || actionPending || !musicSave?.canChoose}
            onClick={() => void like("youtube", option.id)}>
            {[option.title, option.artist, option.album, option.duration ? duration(option.duration) : null].filter(Boolean).join(" · ")}
          </button>
        </li>)}
      </ul>}
    </div>}
  </section>;
});

function duration(value: number | null) {
  return value ? `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}` : "";
}

const playlistOutcomes: Record<string, string> = {
  ...outcomes,
  playing: "Плейлист играет на Станции.",
  working: "Готовим запись для Станции…",
  complete: "Плейлист закончился.",
  stopped: "Очередь плейлиста остановлена.",
  choose: "Выберите версию этой позиции в Яндекс Музыке.",
  no_match: "Для этой позиции нет подтверждённой версии в Яндекс Музыке.",
  limit: "Достигнут предел очереди.",
};

const LibraryPanel = memo(function LibraryPanel({ provider, current, playlist, onPlaylist }: {
  provider: Provider;
  current?: string | null;
  playlist: PlaylistPlayback | null;
  onPlaylist: (next: PlaylistPlayback) => void;
}) {
  const [library, state] = useMusicLibrary(provider);
  const { locked, guardMutation } = useInteractionLock();
  const list = library.getList(state.selected);
  const listNode = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(360);
  const [active, setActive] = useState<string | null>(null);
  const gate = useRef(false);
  const [result, setResult] = useState<{ message: string; record: Recording } | null>(null);
  const [choose, setChoose] = useState<{ original: Recording; options: Recording[] } | null>(null);
  const [playlistPending, setPlaylistPending] = useState(false);
  const [playlistError, setPlaylistError] = useState("");
  const presence = useRef(true);
  const activePlaylist = playlist?.provider === provider && playlist.source === state.selected ? playlist : null;
  const scanRequest = useRef<{ id: string; controller: AbortController | null } | null>(null);
  const [scan, setScan] = useState<PlaylistSearchResult | null>(null);
  const [scanScroll, setScanScroll] = useState(0);

  useEffect(() => {
    setScan(null);
    setScanScroll(0);
    return () => {
      if (scanRequest.current) {
        scanRequest.current.controller?.abort();
        library.cancelSearch(scanRequest.current.id);
        scanRequest.current = null;
      }
    };
  }, [library, state.selected, state.generation, state.sessionRevision, list.query]);

  function stopSearch() {
    if (scanRequest.current) {
      scanRequest.current.controller?.abort();
      library.cancelSearch(scanRequest.current.id);
      scanRequest.current = null;
    }
    setScan(null);
    setScanScroll(0);
  }

  async function searchPlaylist(restart = false) {
    if (!list.query.trim() || !state.selected || scanRequest.current?.controller) return;
    if (restart) stopSearch();
    const id = scanRequest.current?.id ?? crypto.randomUUID().replaceAll("-", "");
    const controller = new AbortController();
    scanRequest.current = { id, controller };
    setScan(before => ({ searchId: id, items: before?.searchId === id ? before.items : [],
      checked: before?.searchId === id ? before.checked : 0, status: "working" }));
    try {
      const next = await library.searchPage(id, controller.signal);
      if (scanRequest.current?.controller === controller && next.searchId === id) setScan(next);
    } catch (error) {
      if (scanRequest.current?.controller === controller) {
        const code = error instanceof Error ? error.message : "";
        setScan(before => before && { ...before, status: code === "busy" ? "busy"
          : code === "account_changed" ? "playlist_changed" : "source_unavailable" });
      }
    } finally {
      if (scanRequest.current?.controller === controller) scanRequest.current = { id, controller: null };
    }
  }

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
  }, [state.selected, state.generation, state.sessionRevision]);

  useLayoutEffect(() => {
    const node = listNode.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.clientHeight));
    observer.observe(node);
    setHeight(node.clientHeight);
    return () => observer.disconnect();
  }, [state.selected]);

  const quickMatches = useMemo(() => filterTracks(list.items, list.query), [list.items, list.query]);
  const showingScan = scan !== null && (scan.checked > 0 || scan.status === "complete");
  const filtered = showingScan ? scan.items : quickMatches;
  const scrollPosition = showingScan ? scanScroll : list.scroll;
  useLayoutEffect(() => {
    if (listNode.current && Math.abs(listNode.current.scrollTop - scrollPosition) >= 1) listNode.current.scrollTop = scrollPosition;
  }, [state.selected, scrollPosition, filtered.length]);

  const from = Math.max(0, Math.floor(scrollPosition / MUSIC_ROW_HEIGHT) - 4);
  const to = Math.min(filtered.length, from + Math.ceil(height / MUSIC_ROW_HEIGHT) + 9);
  const visible = filtered.slice(from, to);

  async function play(record: Recording, choice?: string) {
    if (gate.current || !guardMutation()) return;
    gate.current = true;
    const { generation, selected, sessionRevision } = library.read();
    setActive(record.key);
    setChoose(null);
    setResult(null);
    const currentSelection = () => {
      const current = library.read();
      return presence.current && current.generation === generation && current.selected === selected
        && current.sessionRevision === sessionRevision;
    };
    try {
      const response = await library.play(record, choice);
      if (!currentSelection()) return;
      if (response.status === "choose" && response.options?.length) {
        setChoose({ original: record, options: response.options });
      } else {
        setResult({ message: outcomes[response.status] ?? "Запуск не подтверждён.", record });
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

  async function playPlaylist(action?: "skip" | "stop" | "choose", choice?: string) {
    if (gate.current || !state.selected || !guardMutation()) return;
    if (action && !activePlaylist?.id) return;
    gate.current = true;
    setPlaylistPending(true);
    setPlaylistError("");
    setResult(null);
    try {
      const next = action && activePlaylist?.id
        ? await playlistPlaybackAction(activePlaylist.id, action, choice)
        : await library.playPlaylist();
      onPlaylist({ provider, source: state.selected, ...next });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setPlaylistError(playlistOutcomes[code] ?? playlistOutcomes.unconfirmed);
    } finally {
      gate.current = false;
      if (presence.current) setPlaylistPending(false);
    }
  }

  const errors = state.catalogError || list.error || (["auth_required", "not_configured", "unavailable"].includes(state.status) ? state.status : null);
  const errorText = state.catalogError && state.playlists.length ? "Каталог не обновился. Показан предыдущий каталог."
    : errors ? libraryErrors[errors] ?? libraryErrors.source_unavailable : "";
  const emptyText = scan?.status === "complete" ? "Во всём плейлисте совпадений нет."
    : showingScan ? "В проверенных позициях совпадений пока нет."
    : state.catalogPending || list.pending ? "Загрузка…"
    : errors && !list.observedAt ? "Данные пока недоступны."
    : state.selected ? list.query ? "Среди загруженных записей совпадений нет." : "В списке пока нет записей."
    : "Выберите плейлист.";
  const subtitle = provider === "youtube" ? "На Станции играет версия из Яндекс Музыки" : "";
  const retry = () => {
    if (state.selected) void library.tracks(false, true);
    else void library.catalog(false, true);
  };

  return <section className="music-library" data-provider={provider} aria-label={labels[provider]}>
    <header className="music-library__head">
      <span className="music-library__badge" aria-hidden="true"><Icon name={provider === "youtube" ? "play" : "music"} size={18} /></span>
      <div><h2>{labels[provider]}</h2>{subtitle && <p>{subtitle}</p>}</div>
      {state.selected && <button type="button" className="music-icon-button music-play-playlist"
        aria-label={`Проиграть плейлист на Станции · ${labels[provider]}`} title="Проиграть весь плейлист на Станции"
        disabled={locked || !state.canPlay || Boolean(active) || playlistPending || activePlaylist?.status === "working"}
        aria-busy={playlistPending} onClick={() => void playPlaylist()}>
        <Icon name="play" size={18} />
      </button>}
      <button type="button" className="music-icon-button music-catalog-refresh"
        aria-label={`Обновить плейлисты · ${labels[provider]}`} title="Обновить каталог плейлистов"
        aria-busy={state.catalogRefreshing} disabled={Boolean(active) || !state.generation || state.catalogRefreshing}
        onClick={() => void library.catalog(false, true)}><Icon name="refresh" size={18} /></button>
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
      <button type="button" className="music-icon-button" aria-label={`Обновить треки · ${labels[provider]}`}
        title="Обновить треки" disabled={Boolean(active) || !state.selected || list.pending} onClick={retry}>
        <Icon name="refresh" size={18} />
      </button>
    </div>
    {(activePlaylist || playlistError) && <div className="music-playlist-feedback">
      <p role="status">{playlistError || [
        activePlaylist?.position ? `Позиция ${activePlaylist.position}` : null,
        activePlaylist?.title,
        activePlaylist && playlistOutcomes[activePlaylist.status]
      ].filter(Boolean).join(" · ")}</p>
      {activePlaylist?.options?.map(option => <button key={option.key} type="button" className="music-load"
        disabled={locked || playlistPending} onClick={() => void playPlaylist("choose", option.key)}>
        {[option.title, option.artist, option.album, duration(option.duration)].filter(Boolean).join(" · ")}
      </button>)}
      {activePlaylist?.id && ["choose", "no_match"].includes(activePlaylist.status)
        && <button type="button" className="music-load" disabled={locked || playlistPending}
          onClick={() => void playPlaylist("skip")}>Пропустить позицию</button>}
      {activePlaylist?.id && !["complete", "stopped", "working"].includes(activePlaylist.status)
        && <button type="button" className="music-load" disabled={locked || playlistPending}
          onClick={() => void playPlaylist("stop")}>Остановить очередь</button>}
    </div>}
    {list.query.trim() && state.selected && <div className="music-scan">
      {!scan && <button type="button" className="music-load" onClick={() => void searchPlaylist()}>Искать по всему плейлисту</button>}
      {scan && <>
        <span role="status">Проверено позиций: {scan.checked}. {({
          working: "Ищем…", more: "Можно продолжить поиск.", complete: "Плейлист проверен полностью.",
          limit: "Достигнут предел поиска. Уточните запрос.", auth_required: "Нужно восстановить доступ к источнику.",
          source_unavailable: "Источник временно недоступен.", busy: "Предыдущий запрос ещё завершается.",
          page_expired: "Продолжение устарело.", playlist_changed: "Плейлист изменился."
        })[scan.status]}</span>
        {["more", "auth_required", "source_unavailable", "busy"].includes(scan.status) &&
          <button type="button" className="music-load" onClick={() => void searchPlaylist()}>Продолжить поиск</button>}
        {["page_expired", "playlist_changed"].includes(scan.status) &&
          <button type="button" className="music-load" onClick={() => void searchPlaylist(true)}>Начать заново</button>}
        <button type="button" className="music-load" onClick={stopSearch}>{scan.status === "working" ? "Остановить" : "К загруженным трекам"}</button>
      </>}
    </div>}
    <p className="music-library__notice" role="status">{active ? "Ждём Станцию…"
      : result ? <>{result.message} <strong>{result.record.title}</strong></>
      : errorText || (state.catalogRemoved ? "Плейлист больше недоступен. Выберите другой."
        : list.movedToStart ? "Позиция устарела. Список открыт с начала." : list.changesAvailable ? "Есть изменения. Обновите список, когда закончите просмотр." : list.omitted ? "Показаны последние загруженные позиции." : list.next ? "Список загружен частично" : "")}</p>
    <div className="music-tracks" ref={listNode} tabIndex={0} role="region" aria-label={`Треки · ${labels[provider]}`}
      onScroll={event => {
        const node = event.currentTarget;
        if (showingScan) {
          setScanScroll(node.scrollTop);
          return;
        }
        if (list.observedAt) library.scroll(node.scrollTop, filtered[Math.floor(node.scrollTop / MUSIC_ROW_HEIGHT)]?.trackId);
        if (!list.query && node.scrollTop > 0 && node.scrollHeight - node.scrollTop - node.clientHeight < MUSIC_ROW_HEIGHT * 4
            && list.next && !list.error) void library.tracks(true);
      }}>
      {visible.length ? <div role="list" className="music-tracks__list">
        <div aria-hidden="true" style={{ height: from * MUSIC_ROW_HEIGHT }} />
        {visible.map(track => {
          const selected = Boolean(current && (provider === "yandex" ? current === track.trackId
            : track.trackId && current === state.matches[track.trackId]));
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
      {!scan && list.next && <button type="button" className="music-load" disabled={list.pending || Boolean(active)}
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

function MusicConnectionNotice({ services }: { services: readonly ServiceSnapshot[] }) {
  const library = services.find(service => service.id === "youtube-music-library" && service.health !== "healthy");
  const oauth = services.find(service => service.id === "youtube-music-oauth" && service.health !== "healthy");
  if (!library && !oauth) return null;
  const action = (library?.data as Record<string, unknown> | undefined)?.connection;
  const oauthStatus = (oauth?.data as Record<string, unknown> | undefined)?.connection;
  const showBrowserAction = action === "auth_required" || action === "wrong_channel" || action === "recovering";
  return <aside className="music-connection-notice" aria-label="Подключения YouTube Music">
    {library && <div>
      <p><strong>Библиотека YouTube Music</strong> · {library.summary}.
        {action === "proxy_unavailable" ? " Проверьте Happ, затем обновите каталог."
          : action === "unavailable" ? " Предыдущий каталог остаётся доступен. Попробуйте обновить его позже." : ""}</p>
      {showBrowserAction && <YouTubeConnectionSettings />}
    </div>}
    {oauth && <p><strong>Лайки YouTube</strong> · {oauth.summary}.
      {oauthStatus === "proxy_unavailable" ? " Проверьте Happ."
        : oauthStatus === "auth_required" || oauthStatus === "wrong_channel"
          ? " Требуется авторизация YouTube Data API для нужного канала."
          : ""} <a href="/settings">Настройки YouTube Music</a>
    </p>}
  </aside>;
}

export function MusicPage({ playback, services = [] }: { playback?: StationPlayback | null; services?: readonly ServiceSnapshot[] }) {
  const { copy } = useInterfaceCopy();
  const displayedTrack = playback?.status === "playing" ? playback.trackId : undefined;
  const [playlist, setPlaylist] = useState<PlaylistPlayback | null>(null);
  const playlistRevision = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function poll() {
      const revision = playlistRevision.current;
      try {
        const next = await readPlaylistPlayback(controller.signal);
        if (next?.id && !controller.signal.aborted && playlistRevision.current === revision) setPlaylist(next);
      } catch {
        // Keep the last known status if the local agent is temporarily unavailable.
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(poll, 2500);
      }
    }
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, []);
  function updatePlaylist(next: PlaylistPlayback) {
    playlistRevision.current += 1;
    setPlaylist(next);
  }
  return <section className="music-page" data-testid="route-music">
    <PageHeader title={copy("page.music.title")} description={copy("page.music.subtitle")} variant="compact" />
    <StationMiniPlayer playback={playback} />
    <MusicConnectionNotice services={services} />
    <div className="music-page__libraries"><LibraryPanel provider="yandex" current={displayedTrack} playlist={playlist} onPlaylist={updatePlaylist} /><LibraryPanel provider="youtube" current={displayedTrack} playlist={playlist} onPlaylist={updatePlaylist} /></div>
  </section>;
}
