import { useEffect, useState } from "react";
import { useInteractionLock } from "../../InteractionLock";
import { libraries } from "../music/musicLibraryStore";

interface Connection {
  active: boolean;
  canConnect: boolean;
  libraryStatus: string;
  state: string;
}

const endpoint = "/api/v1/music/youtube/connection";
const labels: Record<string, string> = {
  opening: "Открываем YouTube Music на Samsung…",
  sign_in: "Войди в Google или выбери нужный канал в открытом окне.",
  recovering: "Восстанавливаем доступ к библиотеке…",
  verifying: "Проверяем канал и читаем каталог…",
  connected: "Канал проверен. Библиотека подключена.",
  auth_required: "Нужно войти в Google.",
  wrong_channel: "Выбери тот же канал, который настроен для сохранения песен.",
  unavailable: "Не удалось проверить доступ. Предыдущее подключение сохранено.",
  timed_out: "Время подключения истекло.",
  cancelled: "Подключение отменено."
};

export function YouTubeConnectionSettings() {
  const [connection, setConnection] = useState<Connection>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const { guardMutation } = useInteractionLock();

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function update() {
      let active = false;
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        if (response.status === 404) return;
        if (response.ok && !controller.signal.aborted) {
          const next = await response.json() as Connection;
          active = next.active;
          setConnection(next);
        }
      } catch {
        // Keep the most recent projection while the local API recovers.
      }
      if (!controller.signal.aborted) timer = window.setTimeout(update, active ? 800 : 4_000);
    }
    void update();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (connection?.state === "connected" && !connection.active) void libraries.youtube.sync();
  }, [connection?.state, connection?.active]);

  async function act(action: "connect" | "cancel") {
    if (pending || (action === "connect" && !guardMutation())) return;
    setPending(true);
    setError(false);
    try {
      const response = await fetch(`${endpoint}/${action}`, {
        method: "POST",
        headers: { "X-Panel-Intent": "youtube-connect" },
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) throw new Error();
      setConnection(await response.json() as Connection);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  if (!connection) return null;
  const ready = connection.libraryStatus === "ready";
  const connectLabel = connection.libraryStatus === "not_configured" || (!ready && connection.state === "idle")
    ? "Подключить YouTube Music" : "Переподключить";
  const message = connection.state === "connected" && connection.libraryStatus === "auth_required"
    ? labels.auth_required : labels[connection.state] ?? (ready ? "Библиотека подключена." : "Подключение библиотеки");
  return <div data-testid="youtube-browser-connection">
    <p role="status">{message}</p>
    <button className="planning-secondary-button" type="button" disabled={pending || (!connection.active && !connection.canConnect)}
      onClick={() => void act(connection.active ? "cancel" : "connect")}>
      {connection.active ? "Отменить" : connectLabel}
    </button>
    {error && <p role="alert">Не удалось выполнить действие.</p>}
  </div>;
}
