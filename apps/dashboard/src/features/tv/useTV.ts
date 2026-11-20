import { useCallback, useEffect, useRef, useState } from "react";

export type NavigationKey = "up" | "down" | "left" | "right" | "ok" | "back" | "home";
export type Action = NavigationKey | "screen-on" | "screen-off" | "volume-up" | "volume-down" |
  "volume-set" | "mute" | "open-app" | "open-link" | "saved" | "navigate" | "vpn-connect";
type Command = { action: Action; app?: string; url?: string; id?: string; keys?: NavigationKey[]; volume?: number };
type Link = "connecting" | "online" | "samsung-unreachable" | "tv-unreachable" | "unknown";
type Maintenance = "unknown" | "pending" | "verified" | "failed" | "not-needed";
type App = { id: string; label: string; links: boolean };
type Saved = { id: string; label: string };
type Controls = { navigationBatch?: boolean; connectHapp?: boolean; volumeRange?: { min: number; max: number } };
export type TvStatus = {
  availability: "online" | "offline" | "connecting";
  connection?: "adb-unreachable" | "unverified";
  screen?: "on" | "off" | "sleeping" | "unknown";
  volume?: number | null;
  minVolume?: number;
  maxVolume?: number;
  muted?: boolean | null;
  vpn?: boolean | null;
  controls?: { navigationBatch?: boolean; connectHapp?: boolean };
  apps?: App[];
  saved?: Saved[];
  maintenance?: { guard?: Maintenance; policy?: Maintenance; happ?: Maintenance };
};
type Notice = { text: string; kind: "command" | "link"; error?: boolean };
type Draft = { catalogue: { apps?: App[]; saved?: Saved[] }; url: string; selection: string; controls?: Controls };
const emptyDraft: Draft = { catalogue: {}, url: "", selection: "" };

function readDraft(key: string): Draft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as Draft | null;
    if (saved?.catalogue && typeof saved.url === "string" && typeof saved.selection === "string") return saved;
  } catch {
    // Private browsing and webviews can disable storage.
  }
  return emptyDraft;
}

const audioAction = (action: Action) => ["volume-up", "volume-down", "volume-set", "mute"].includes(action);
const navigationLimit = 8;
const navigationFreshness = 1400;

function audioChanged(action: Action, before: TvStatus | null, observed: TvStatus) {
  if (action === "mute") {
    return typeof before?.muted === "boolean" && typeof observed.muted === "boolean" && observed.muted !== before.muted;
  }
  return typeof before?.volume === "number" && typeof observed.volume === "number" &&
    (action === "volume-up" ? observed.volume > before.volume : observed.volume < before.volume);
}

export function useTV(base: string, enabled = true) {
  const draftKey = "tv-remote-draft-v1:" + base;
  const [initial] = useState(() => readDraft(draftKey));
  const [link, setLink] = useState<Link>("connecting");
  const [state, setState] = useState<TvStatus | null>(null);
  const [catalogue, setCatalogue] = useState(initial.catalogue);
  const [controls, setControls] = useState<Controls>(initial.controls ?? {});
  const [authorized, setAuthorized] = useState(true);
  const [pending, setPending] = useState<Action | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [url, setUrl] = useState(initial.url);
  const [selection, setSelection] = useState(initial.selection);
  const active = useRef(false);
  const audioRead = useRef(false);
  const epoch = useRef(0);
  const read = useRef<AbortController | null>(null);
  const navigation = useRef({ keys: [] as NavigationKey[], firstTap: 0, timer: 0, running: false });

  const clearNavigation = useCallback(() => {
    const batch = navigation.current;
    window.clearTimeout(batch.timer);
    batch.timer = 0;
    batch.keys = [];
  }, []);

  useEffect(() => {
    try {
      if (authorized) sessionStorage.setItem(draftKey, JSON.stringify({ catalogue, url, selection, controls }));
      else sessionStorage.removeItem(draftKey);
    } catch {
      // The open page still retains its draft without storage.
    }
  }, [authorized, catalogue, controls, draftKey, selection, url]);

  const loseStatus = useCallback((next: Link) => {
    epoch.current++;
    clearNavigation();
    setNotice(null);
    setState(null);
    setLink(next);
  }, [clearNavigation]);

  const refresh = useCallback(async (): Promise<TvStatus | undefined> => {
    if (!enabled || document.visibilityState === "hidden") return;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 4200);
    let received = false;
    try {
      const response = await fetch(base + "/status", { cache: "no-store", signal: controller.signal });
      received = true;
      if (read.current !== controller) return;
      if (response.status === 401) {
        setAuthorized(false);
        setCatalogue({});
        setControls({});
        setUrl("");
        setSelection("");
        loseStatus("unknown");
        return;
      }
      if (!response.ok) {
        loseStatus("unknown");
        return;
      }
      const status: TvStatus = await response.json();
      if (read.current !== controller) return;
      setAuthorized(true);
      if (Array.isArray(status.apps) || Array.isArray(status.saved)) {
        setCatalogue((previous) => ({
          apps: Array.isArray(status.apps) ? status.apps : previous.apps,
          saved: Array.isArray(status.saved) ? status.saved : previous.saved
        }));
      }
      if (status.availability === "online") {
        const min = status.minVolume;
        const max = status.maxVolume;
        if (status.controls) {
          setControls((previous) => ({ ...status.controls,
            volumeRange: typeof min === "number" && typeof max === "number" && min < max ?
              { min, max } : previous.volumeRange }));
        } else {
          setControls({});
        }
        setState(status);
        setLink("online");
        return status;
      }
      loseStatus(status.connection === "adb-unreachable" ? "tv-unreachable" :
        status.availability === "connecting" && status.connection !== "unverified" ? "connecting" : "unknown");
    } catch (error) {
      if (read.current === controller) loseStatus(
        (!received && (error instanceof TypeError || controller.signal.aborted)) || !navigator.onLine ?
          "samsung-unreachable" : "unknown"
      );
    } finally {
      window.clearTimeout(timer);
    }
  }, [base, enabled, loseStatus]);

  useEffect(() => {
    const reset = () => {
      read.current?.abort();
      read.current = null;
      loseStatus("connecting");
      void refresh();
    };
    const wentOffline = () => {
      read.current?.abort();
      read.current = null;
      loseStatus("samsung-unreachable");
    };
    void refresh();
    const interval = window.setInterval(() => { if (!audioRead.current) void refresh(); }, 5000);
    document.addEventListener("visibilitychange", reset);
    window.addEventListener("pageshow", reset);
    window.addEventListener("online", reset);
    window.addEventListener("offline", wentOffline);
    return () => {
      epoch.current++;
      clearNavigation();
      window.clearInterval(interval);
      read.current?.abort();
      read.current = null;
      document.removeEventListener("visibilitychange", reset);
      window.removeEventListener("pageshow", reset);
      window.removeEventListener("online", reset);
      window.removeEventListener("offline", wentOffline);
    };
  }, [refresh, loseStatus, clearNavigation]);

  const changeSession = (signedIn: boolean) => {
    read.current?.abort();
    read.current = null;
    setAuthorized(signedIn);
    loseStatus(signedIn ? "connecting" : "unknown");
    if (!signedIn) {
      setCatalogue({});
      setControls({});
      setUrl("");
      setSelection("");
    }
  };

  const send = async (command: Command) => {
    if (!enabled || active.current || link !== "online") return;
    active.current = true;
    setPending(command.action);
    const attempt = epoch.current;
    const feedback = (text: string, error = false, kind: Notice["kind"] = "command") => {
      if (epoch.current === attempt) setNotice({ text, kind, error });
    };
    if (command.action !== "navigate") feedback("Отправка…");
    try {
      const response = await fetch(base + "/command", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Panel-TV": "1" },
        body: JSON.stringify(command), signal: AbortSignal.timeout(40000), cache: "no-store"
      });
      if (epoch.current !== attempt) return;
      if (response.status === 401) setAuthorized(false);
      if (response.status === 401 || response.status === 403) {
        feedback("Управление недоступно для этой сессии.", true);
        return;
      }
      const result = await response.json();
      if (epoch.current !== attempt) return;
      if (result.outcome === "confirmed" && audioAction(command.action) &&
          Number.isFinite(result.audio?.volume) && typeof result.audio?.muted === "boolean") {
        read.current?.abort();
        read.current = null;
        setState((previous) => previous && { ...previous, volume: result.audio.volume, muted: result.audio.muted });
        feedback("Звук подтверждён.");
      } else if (result.outcome === "confirmed" && (result.screen === "on" || result.screen === "off")) {
        setState((previous) => previous && { ...previous, screen: result.screen });
        feedback(result.screen === "on" ? "Экран включён." : "Экран погашен.");
      } else if (result.outcome === "sent" && audioAction(command.action)) {
        // The previous executor reports only dispatch and serves a periodic snapshot.
        // Reread status, without resending the key, until it proves the requested change.
        audioRead.current = true;
        feedback("Проверяем звук…");
        for (let check = 0; check < 7 && epoch.current === attempt; check++) {
          if (check) await new Promise((done) => window.setTimeout(done, 900));
          if (epoch.current !== attempt) return;
          const observed = await refresh();
          if (observed && audioChanged(command.action, state, observed)) {
            feedback("Звук подтверждён.");
            return;
          }
        }
        feedback("Изменение звука не подтверждено.", true);
      } else if (result.outcome === "sent" && command.action === "navigate") {
        setNotice((previous) => previous?.kind === "link" ? previous : null);
        return true;
      } else if (result.outcome === "sent") {
        feedback("Команда передана ТВ.");
      } else if (result.outcome === "vpn-connected" || result.outcome === "vpn-already-connected") {
        setState((previous) => previous && { ...previous, vpn: true,
          maintenance: result.outcome === "vpn-connected" ? { ...previous.maintenance, happ: "verified" } : previous.maintenance });
        feedback(result.outcome === "vpn-connected" ? "VPN Happ подключён." : "VPN уже подключён.");
      } else if (result.outcome === "app-open") {
        feedback(result.playbackConfirmed ? "Воспроизведение подтверждено." :
          result.linkRequested ? "Приложение открыто. Воспроизведение не подтверждено." : "Приложение открыто.");
      } else if (result.outcome === "busy") {
        feedback("ТВ занят. Команда не отправлена.", true);
      } else if (result.outcome === "invalid" || response.status === 422 || response.status === 400) {
        feedback("Проверьте ссылку и выбранное приложение.", true, command.action === "open-link" ? "link" : "command");
      } else if (result.outcome === "offline") {
        loseStatus(result.connection === "adb-unreachable" ? "tv-unreachable" : "unknown");
      } else {
        feedback("Результат команды не подтверждён.", true);
      }
    } catch {
      feedback("Результат команды не подтверждён.", true);
    } finally {
      audioRead.current = false;
      active.current = false;
      setPending(null);
    }
  };

  const navigate = (key: NavigationKey) => {
    if (!state?.controls?.navigationBatch) {
      void send({ action: key });
      return;
    }
    const batch = navigation.current;
    if (!enabled || link !== "online" || document.visibilityState === "hidden" ||
        (active.current && !batch.running)) return;
    if (performance.now() - batch.firstTap > navigationFreshness) clearNavigation();
    if (batch.keys.length >= navigationLimit) return;
    if (!batch.keys.length) batch.firstTap = performance.now();
    batch.keys.push(key);

    const attempt = epoch.current;
    const flush = async () => {
      batch.timer = 0;
      if (!batch.keys.length) return;
      if (epoch.current !== attempt || active.current || document.visibilityState === "hidden" ||
          performance.now() - batch.firstTap > navigationFreshness) {
        clearNavigation();
        return;
      }
      const keys = batch.keys;
      batch.keys = [];
      batch.running = true;
      const sent = await send({ action: "navigate", keys });
      batch.running = false;
      if (!sent || attempt !== epoch.current) clearNavigation();
      else if (batch.keys.length) batch.timer = window.setTimeout(() => { void flush(); }, 0);
    };
    if (!batch.running && !batch.timer) batch.timer = window.setTimeout(() => { void flush(); }, 140);
  };

  const selected = catalogue.apps?.find((app) => app.id === selection && app.links)?.id ??
    catalogue.apps?.find((app) => app.links)?.id ?? "";
  return { state, link, catalogue, controls, authorized, pending, notice, remoteStatus: link === "online" && enabled,
    send, navigate, refresh, changeSession, url, setUrl, selected, setSelection };
}
