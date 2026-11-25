import { useEffect, useRef, useState } from "react";
import { useInteractionLock } from "../../InteractionLock";
import { YouTubeConnectionSettings } from "./YouTubeConnectionSettings";

interface MusicOption {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
}

interface MusicProjection {
  connection: string;
  channel: string | null;
  destination: string;
  canChoose: boolean;
  busyEvents: number;
  operation: { id: string; status: string; title: string | null; options: MusicOption[] } | null;
}

const connectionLabels: Record<string, string> = {
  not_configured: "Подключение не настроено",
  auth_required: "Нужен вход в Google",
  unavailable: "YouTube Music сейчас недоступна",
  connected: "Профиль подключён"
};

const resultLabels: Record<string, string> = {
  working: "Проверяем песню…",
  choose_source: "Какая песня играла, когда ты произнёс команду?",
  choose_version: "Какую запись сохранить?",
  no_match: "Подходящая запись не найдена.",
  no_track: "На Мини 2 нет подтверждённого играющего трека.",
  already_in_music: "Уже есть в понравившейся музыке.",
  in_music: "Песня появилась в понравившейся музыке.",
  youtube_like: "Лайк подтверждён в YouTube. Появление в понравившейся музыке пока не подтверждено.",
  unconfirmed: "Результат записи не подтверждён.",
  auth_required: "Подключи нужный канал Google.",
  unavailable: "Не удалось связаться с Music.",
  blocked: "Сохранение недоступно в текущем профиле."
};

const endpoint = "/api/v1/station/music-save";

export function MusicSaveSettings() {
  const [state, setState] = useState<MusicProjection>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { guardMutation } = useInteractionLock();
  const details = useRef<HTMLDetailsElement>(null);
  const operationId = state?.operation?.id;

  useEffect(() => {
    if (operationId && details.current) details.current.open = true;
  }, [operationId]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function update() {
      try {
        const response = await fetch(endpoint, { signal: controller.signal, cache: "no-store" });
        if (response.status === 404) return;
        if (response.ok) {
          const projection = await response.json() as MusicProjection | null;
          if (projection === null || controller.signal.aborted) return;
          setState(projection);
        }
      } catch {
        // The last known operation remains visible.
      }
      if (!controller.signal.aborted) timer = window.setTimeout(update, 4_000);
    }
    void update();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  async function act(path: "verify" | "choose", option?: string) {
    if (pending || !guardMutation()) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`${endpoint}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Panel-Intent": "music-save" },
        body: option ? JSON.stringify({
          operationId: state?.operation?.id, stage: state?.operation?.status, choiceId: option
        }) : undefined
      });
      if (!response.ok) throw new Error("Music request was declined");
      setState(await response.json() as MusicProjection);
    } catch {
      setError("Действие недоступно или время выбора истекло.");
    } finally {
      setPending(false);
    }
  }

  if (!state) return <YouTubeConnectionSettings />;
  const result = state.operation;
  return <details className="station-retention-settings" data-testid="music-save-settings" ref={details}>
    <summary>YouTube Music</summary>
    <YouTubeConnectionSettings />
    <p>{connectionLabels[state.connection]}{state.channel && ` · ${state.channel}`}</p>
    <p>Сохранение в «{state.destination}» по фразе «Алиса, панель, сохрани трек».</p>
    {state.connection !== "connected" &&
      <button className="planning-secondary-button" type="button" disabled={pending} onClick={() => void act("verify")}>
        Проверить подключение
      </button>}
    {result && <>
      <p role="status">{result.title && `${result.title} · `}{resultLabels[result.status]}</p>
      {result.options.length > 0 && <ul className="music-save-options">
        {result.options.map((option) => <li key={option.id}>
          <button className="planning-secondary-button" type="button" disabled={pending || !state.canChoose}
            onClick={() => void act("choose", option.id)}>
            <strong>{option.title}</strong>
            <span>{[option.artist, option.album, option.duration ? `${Math.floor(option.duration / 60)}:${String(option.duration % 60).padStart(2, "0")}` : null].filter(Boolean).join(" · ")}</span>
          </button>
        </li>)}
      </ul>}
      {state.busyEvents > 0 && <p>Пока панель сохраняла песню или ждала выбора, были пропущены повторные команды.</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
