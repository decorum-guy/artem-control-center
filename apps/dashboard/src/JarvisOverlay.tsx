import { useEffect, useRef, useState, type FormEvent } from "react";
import { useInteractionLock } from "./InteractionLock";
import { Icon } from "./icons";
import { sendJarvisTurn, type JarvisNavigation } from "./jarvisApi";
import { getJarvisVoiceState, syncJarvisVoiceInteractionLock, type JarvisVoiceSnapshot } from "./jarvisVoiceApi";

const MAX_MESSAGES = 24;
const MAX_TEXT = 512;

type Message = { role: "owner" | "jarvis"; text: string };
type OverlayState = "idle" | "processing" | "listening" | "transcribing" | "submitting" | "ready" | "error";

export function JarvisOverlay({ onNavigate }: { onNavigate: (route: JarvisNavigation) => void }) {
  const { locked } = useInteractionLock();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState<OverlayState>("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const voiceSequence = useRef(-1);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

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

  useEffect(() => {
    // This best-effort boolean is mirrored to the Panel Agent, where the
    // loopback voice turn is rejected while locked.  It carries no command.
    void syncJarvisVoiceInteractionLock(locked).catch(() => undefined);
  }, [locked]);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    const apply = (voice: JarvisVoiceSnapshot | null) => {
      if (!voice || disposed || voice.sequence <= voiceSequence.current || locked) return;
      voiceSequence.current = voice.sequence;
      if (voice.state === "wake_detected" || voice.state === "listening") { setOpen(true); setState("listening"); return; }
      if (voice.state === "transcribing") { setOpen(true); setState("transcribing"); return; }
      if (voice.state === "submitting") { setOpen(true); setState("submitting"); return; }
      if (voice.state === "ready") {
        setOpen(true);
        if (voice.recognizedText) append({ role: "owner", text: voice.recognizedText });
        if (voice.responseText) append({ role: "jarvis", text: voice.responseText });
        if (voice.navigation) onNavigateRef.current(voice.navigation);
        setState("ready");
        return;
      }
      if (voice.state === "error") { setOpen(true); setState("error"); }
    };
    const poll = () => {
      controller?.abort(); controller = new AbortController();
      void getJarvisVoiceState(controller.signal).then(apply).catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 750);
    return () => { disposed = true; controller?.abort(); window.clearInterval(timer); };
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
                state === "processing" || state === "submitting" ? "Обрабатываю" : state === "listening" ? "Слушаю" : state === "transcribing" ? "Распознаю" : state === "error" ? "Ошибка" : state === "ready" ? "Готово" : "Ожидаю"
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
