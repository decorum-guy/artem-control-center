import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { Icon } from "../../icons";
import { StatusText, WorkZone } from "../../ShellPrimitives";
import { Sheet } from "../../Sheet";
import "./tv.css";

type Action = "screen-on" | "screen-off" | "up" | "down" | "left" | "right" | "ok" |
  "back" | "home" | "volume-up" | "volume-down" | "mute" | "open-app" | "open-link" | "saved";
type Command = { action: Action; app?: string; url?: string; id?: string };
export type TvStatus = {
  availability: "online" | "offline" | "connecting";
  screen?: "on" | "off" | "sleeping" | "unknown";
  vpn?: boolean | null;
  volume?: number | null;
  muted?: boolean | null;
  apps?: { id: string; label: string; links: boolean }[];
  saved?: { id: string; label: string }[];
};
const connecting: TvStatus = { availability: "connecting" };
const offline: TvStatus = { availability: "offline" };

function useTV(base: string, enabled = true) {
  const [state, setState] = useState<TvStatus>(connecting);
  const [authorized, setAuthorized] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const active = useRef(false);
  const read = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!enabled || document.visibilityState === "hidden") return;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 4200);
    try {
      const response = await fetch(base + "/status", { cache: "no-store", signal: controller.signal });
      if (read.current !== controller) return;
      if (response.status === 401) {
        setAuthorized(false);
        setState(offline);
      } else if (!response.ok) {
        setState(offline);
      } else {
        const status: TvStatus = await response.json();
        if (read.current === controller) {
          setAuthorized(true);
          setState(status);
        }
      }
    } catch {
      if (read.current === controller) setState(offline);
    } finally {
      window.clearTimeout(timer);
    }
  }, [base, enabled]);

  useEffect(() => {
    const reset = () => {
      read.current?.abort();
      read.current = null;
      setState(connecting);
      void refresh();
    };
    const wentOffline = () => {
      read.current?.abort();
      read.current = null;
      setState(offline);
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 5000);
    document.addEventListener("visibilitychange", reset);
    window.addEventListener("pageshow", reset);
    window.addEventListener("online", reset);
    window.addEventListener("offline", wentOffline);
    return () => {
      window.clearInterval(interval);
      read.current?.abort();
      read.current = null;
      document.removeEventListener("visibilitychange", reset);
      window.removeEventListener("pageshow", reset);
      window.removeEventListener("online", reset);
      window.removeEventListener("offline", wentOffline);
    };
  }, [refresh]);

  const send = async (command: Command) => {
    if (!enabled || active.current || state.availability !== "online") return;
    active.current = true;
    setBusy(true);
    setNotice("Отправка…");
    try {
      const response = await fetch(base + "/command", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Panel-TV": "1" },
        body: JSON.stringify(command), signal: AbortSignal.timeout(40000), cache: "no-store"
      });
      if (response.status === 401) setAuthorized(false);
      const result = await response.json();
      if (result.outcome === "confirmed") {
        setState((previous) => ({ ...previous, screen: result.screen }));
        setNotice(result.screen === "on" ? "Экран включён" : "Экран погашен");
      } else if (result.outcome === "sent") {
        setNotice("Команда передана ТВ");
      } else if (result.outcome === "app-open") {
        setNotice(result.linkRequested ? "Приложение открыто. Ссылка передана, воспроизведение не подтверждено." : "Приложение открыто");
      } else if (result.outcome === "busy") {
        setNotice("ТВ занят. Команда не отправлена.");
      } else if (result.outcome === "invalid" || response.status === 422) {
        setNotice("Проверьте ссылку и выбранное приложение.");
      } else if (result.outcome === "offline") {
        setState(offline);
        setNotice("ТВ недоступен. Команда не отправлена.");
      } else if (response.status === 403 || response.status === 401) {
        setNotice("Управление недоступно для этой сессии.");
      } else {
        setNotice("Результат команды не подтверждён.");
      }
    } catch {
      setNotice("Результат команды не подтверждён.");
    } finally {
      active.current = false;
      setBusy(false);
    }
  };

  return { state, authorized, busy, notice, send, refresh };
}
type Controller = ReturnType<typeof useTV>;

function deviceLabel(state: TvStatus) {
  if (state.availability === "connecting") return "Подключение";
  if (state.availability === "offline") return "Нет связи с ТВ";
  if (state.screen === "on") return "Экран включён";
  if (state.screen === "off") return "Экран погашен";
  if (state.screen === "sleeping") return "ТВ в режиме ожидания";
  return "Состояние экрана неизвестно";
}

function Button({ children, title, click, disabled, pressed, className = "" }: {
  children: ReactNode; title?: string; click: () => void; disabled?: boolean;
  pressed?: boolean; className?: string;
}) {
  return <button type="button" className={`tv-button ${className}`} aria-label={title}
    aria-pressed={pressed} onClick={click} disabled={disabled}>{children}</button>;
}
function Commands({ controller, compact = false, disabled = false }: {
  controller: Controller; compact?: boolean; disabled?: boolean;
}) {
  const { state, busy, send } = controller;
  const blocked = disabled || busy || state.availability !== "online";
  const app = state.apps?.find((item) => item.id === "youtube");
  const cmd = (action: Action) => () => { void send({ action }); };
  return <>
    <div className="tv-device-row">
      <StatusText label={deviceLabel(state)} tone={state.screen === "on" ? "success" : state.availability === "offline" ? "unavailable" : "neutral"} />
      {compact ? <Button title={state.screen === "on" ? "Погасить экран" : "Включить экран"}
        click={cmd(state.screen === "on" ? "screen-off" : "screen-on")} disabled={blocked || !["on", "off"].includes(state.screen ?? "")}
        pressed={state.screen === "on"}><Icon name="power" /></Button> : null}
    </div>
    {!compact ? <div className="tv-row tv-row--screen">
      <Button click={cmd("screen-on")} disabled={blocked} pressed={state.screen === "on"}>Включить экран</Button>
      <Button click={cmd("screen-off")} disabled={blocked}>Погасить экран</Button>
    </div> : null}
    <div className="tv-row tv-volume" aria-label="Звук">
      <Button title="Тише" click={cmd("volume-down")} disabled={blocked}><Icon name="minus" /></Button>
      <Button title="Без звука" click={cmd("mute")} disabled={blocked} pressed={state.muted ?? undefined}><Icon name="volume" /></Button>
      <Button title="Громче" click={cmd("volume-up")} disabled={blocked}><Icon name="plus" /></Button>
      {compact ? <Button click={() => { void send({ action: "open-app", app: "youtube" }); }} disabled={blocked || !app}>YouTube</Button> :
        <output aria-label="Громкость">{state.volume ?? "—"}</output>}
    </div>
  </>;
}

const keys: Record<string, Action> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "ok", Backspace: "back", Home: "home"
};
export function FullRemote({ controller }: { controller: Controller }) {
  const { state, busy, send, notice } = controller;
  const [url, setUrl] = useState("");
  const [selected, selectApp] = useState("youtube");
  const apps = state.apps ?? [];
  const canSend = state.availability === "online" && !busy;
  const key = (event: KeyboardEvent<HTMLElement>) => {
    if (!canSend || event.repeat || event.altKey || event.metaKey || event.ctrlKey ||
        (event.target as HTMLElement).closest("input, select, textarea, button")) return;
    const action = keys[event.key];
    if (action) {
      event.preventDefault();
      void send({ action });
    }
  };
  const transmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSend && url.trim()) void send({ action: "open-link", app: selected, url: url.trim() });
  };
  return <section className="tv-full" tabIndex={0} aria-label="Управление телевизором" onKeyDown={key}>
    <Commands controller={controller} />
    <div className="tv-dpad" aria-label="Навигация">
      {([
        ["up", "Вверх", "⌃"], ["left", "Влево", "‹"], ["ok", "OK", "OK"],
        ["right", "Вправо", "›"], ["down", "Вниз", "⌄"]
      ] as const).map(([action, title, glyph]) => <Button key={action} className={`tv-key-${action}`}
        title={title} click={() => { void send({ action }); }} disabled={!canSend}>{glyph}</Button>)}
    </div>
    <div className="tv-row tv-row--screen">
      <Button click={() => { void send({ action: "back" }); }} disabled={!canSend}><Icon name="chevron-left" />Назад</Button>
      <Button click={() => { void send({ action: "home" }); }} disabled={!canSend}><Icon name="home" />Домой</Button>
    </div>
    {apps.length > 0 ? <div className="tv-catalog" aria-label="Приложения">
      {apps.map((app) => <Button key={app.id} click={() => { void send({ action: "open-app", app: app.id }); }}
        disabled={!canSend}>{app.label}</Button>)}
      {state.saved?.map((item) => <Button key={item.id} click={() => { void send({ action: "saved", id: item.id }); }}
        disabled={!canSend}>{item.label}</Button>)}
    </div> : null}
    <form className="tv-link" onSubmit={transmit}>
      <label htmlFor="tv-link-url">Ссылка на телевизор</label>
      <input id="tv-link-url" type="url" name="url" value={url} onChange={(event) => setUrl(event.target.value)}
        placeholder="https://" maxLength={2048} autoCapitalize="off" autoCorrect="off" />
      <div className="tv-row tv-row--screen">
        <select aria-label="Открыть в приложении" value={selected} onChange={(event) => selectApp(event.target.value)}>
          {apps.filter((app) => app.links).map((app) => <option key={app.id} value={app.id}>{app.label}</option>)}
        </select>
        <button type="submit" className="tv-button" disabled={!canSend || !url.trim() || !apps.some((app) => app.id === selected && app.links)}>Отправить</button>
      </div>
    </form>
    <p className="tv-message" role="status">{notice}</p>
  </section>;
}

export function TelevisionWidget({ interactive }: { interactive: boolean }) {
  const controller = useTV("/api/tv", interactive);
  const [open, setOpen] = useState(false);
  return <WorkZone className="overview-v2-real-widget tv-widget" data-testid="television-widget">
    <header className="tv-widget-title"><Icon name="system" /><h2>Телевизор</h2></header>
    <Commands controller={controller} compact disabled={!interactive} />
    <Button click={() => setOpen(true)} disabled={!interactive} className="tv-open">Полный пульт <Icon name="chevron-right" /></Button>
    {controller.notice && !open ? <p className="tv-message" role="status">{controller.notice}</p> : null}
    {open && interactive ? <Sheet title="Пульт телевизора" onClose={() => setOpen(false)} className="tv-sheet">
      <FullRemote controller={controller} />
    </Sheet> : null}
  </WorkZone>;
}
export { useTV };
