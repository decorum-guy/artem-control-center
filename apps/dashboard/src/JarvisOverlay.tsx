import { useEffect, useRef, useState, type FormEvent } from "react";
import { useInteractionLock } from "./InteractionLock";
import { Icon } from "./icons";
import { sendJarvisTurn, type JarvisNavigation } from "./jarvisApi";

const MAX_MESSAGES = 24;
const MAX_TEXT = 512;

type Message = { role: "owner" | "jarvis"; text: string };
type OverlayState = "idle" | "processing" | "ready" | "error";

export function JarvisOverlay({ onNavigate }: { onNavigate: (route: JarvisNavigation) => void }) {
  const { locked } = useInteractionLock();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState<OverlayState>("idle");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || locked) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, locked]);

  useEffect(() => {
    if (locked) {
      setOpen(false);
      setState("idle");
    }
  }, [locked]);

  function append(message: Message): void {
    setMessages((current) => [...current, message].slice(-MAX_MESSAGES));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const value = text.trim();
    if (!value || value.length > MAX_TEXT || locked || state === "processing") return;
    append({ role: "owner", text: value });
    setText("");
    setState("processing");
    try {
      const result = await sendJarvisTurn(value);
      append({ role: "jarvis", text: result.responseText });
      if (result.navigation) onNavigate(result.navigation);
      setState("ready");
    } catch {
      append({ role: "jarvis", text: "Jarvis сейчас недоступен. Повторите попытку позже." });
      setState("error");
    }
  }

  return (
    <div className="jarvis-root" data-testid="jarvis-root">
      <button
        type="button"
        className="jarvis-launcher"
        data-testid="jarvis-launcher"
        aria-label="Открыть Jarvis"
        aria-expanded={open}
        disabled={locked}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">J</span><span>Jarvis</span>
      </button>
      {open && (
        <section className="jarvis-panel" data-testid="jarvis-panel" aria-label="Диалог с Jarvis">
          <header className="jarvis-panel__header">
            <div><p>JARVIS · TEXT</p><h2>Jarvis</h2></div>
            <div className="jarvis-panel__header-actions">
              <span className={`jarvis-state jarvis-state--${state}`} data-testid="jarvis-state">{
                state === "processing" ? "Обрабатываю" : state === "error" ? "Ошибка" : state === "ready" ? "Готово" : "Ожидаю"
              }</span>
              <button type="button" className="jarvis-icon-button" aria-label="Закрыть Jarvis" onClick={() => setOpen(false)}><Icon name="close" /></button>
            </div>
          </header>
          <div className="jarvis-panel__messages" aria-live="polite" data-testid="jarvis-messages">
            {!messages.length && <p className="jarvis-empty">Спросите о времени, погоде, планах или попросите открыть раздел.</p>}
            {messages.map((message, index) => <p key={`${index}:${message.role}`} className={`jarvis-message jarvis-message--${message.role}`}>{message.text}</p>)}
          </div>
          <form className="jarvis-panel__form" onSubmit={(event) => void submit(event)}>
            <label className="sr-only" htmlFor="jarvis-text">Сообщение Jarvis</label>
            <input id="jarvis-text" ref={inputRef} value={text} maxLength={MAX_TEXT} disabled={state === "processing" || locked} onChange={(event) => setText(event.target.value)} placeholder="Напишите Jarvis…" autoComplete="off" />
            <button type="submit" disabled={!text.trim() || state === "processing" || locked}>Отправить</button>
          </form>
        </section>
      )}
    </div>
  );
}
