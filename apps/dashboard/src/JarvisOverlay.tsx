import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { useInteractionLock } from "./InteractionLock";
import { Icon } from "./icons";
import { sendJarvisTurn, type JarvisNavigation } from "./jarvisApi";
import {
  getJarvisVoiceState, syncJarvisVoiceInteractionLock,
  type JarvisVoiceSnapshot, type JarvisVoiceState
} from "./jarvisVoiceApi";

const MAX_MESSAGES = 24;
const MAX_TEXT = 512;
const IDLE_POLL_MS = 650;
const ACTIVE_POLL_MS = 140;

type Message = { role: "owner" | "jarvis"; text: string };
type OverlayState = "idle" | "processing" | "listening" | "transcribing" | "submitting" | "speaking" | "ready" | "error";

const VOICE_HUD_STATES = new Set<JarvisVoiceState>([
  "wake_detected", "listening", "transcribing", "submitting", "speaking", "ready", "error"
]);

function voiceHudLabel(state: JarvisVoiceState): string {
  if (state === "wake_detected" || state === "listening") return "Слушаю";
  if (state === "transcribing") return "Распознаю";
  if (state === "submitting") return "Обрабатываю";
  if (state === "speaking") return "Говорю";
  if (state === "ready") return "Готово";
  if (state === "error") return "Ошибка";
  return "Ожидаю";
}

export function JarvisOverlay({ onNavigate }: { onNavigate: (route: JarvisNavigation) => void }) {
  const { locked } = useInteractionLock();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState<OverlayState>("idle");
  const [voiceSnapshot, setVoiceSnapshot] = useState<JarvisVoiceSnapshot | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const voiceSequence = useRef(-1);
  const voiceCancelPending = useRef(false);
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
      setVoiceSnapshot(null);
    }
  }, [locked]);

  useEffect(() => {
    // This best-effort boolean is mirrored to the Panel Agent, where the
    // loopback voice turn is rejected while locked. It carries no command.
    void syncJarvisVoiceInteractionLock(locked).catch(() => undefined);
  }, [locked]);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: number | null = null;

    const apply = (voice: JarvisVoiceSnapshot | null) => {
      if (!voice || disposed || voice.sequence <= voiceSequence.current || locked) return;
      voiceSequence.current = voice.sequence;
      if (voiceCancelPending.current) {
        if (voice.state === "idle" || voice.state === "cooldown") {
          voiceCancelPending.current = false;
          setVoiceSnapshot(null);
          setState("idle");
          void syncJarvisVoiceInteractionLock(false).catch(() => undefined);
        }
        return;
      }
      setVoiceSnapshot(voice);

      if (voice.state === "wake_detected" || voice.state === "listening") { setState("listening"); return; }
      if (voice.state === "transcribing") { setState("transcribing"); return; }
      if (voice.state === "submitting") { setState("submitting"); return; }
      if (voice.state === "speaking") { setState("speaking"); return; }
      if (voice.state === "ready") {
        if (voice.recognizedText) append({ role: "owner", text: voice.recognizedText });
        if (voice.responseText) append({ role: "jarvis", text: voice.responseText });
        if (voice.navigation) onNavigateRef.current(voice.navigation);
        setState("ready");
        return;
      }
      if (voice.state === "error") { setState("error"); return; }
      if (voice.state === "idle" || voice.state === "cooldown" || voice.state === "disabled") setState("idle");
    };

    const schedule = (delay: number) => {
      if (!disposed) timer = window.setTimeout(poll, delay);
    };

    const poll = () => {
      controller?.abort();
      controller = new AbortController();
      void getJarvisVoiceState(controller.signal)
        .then((voice) => {
          apply(voice);
          schedule(voice && VOICE_HUD_STATES.has(voice.state) ? ACTIVE_POLL_MS : IDLE_POLL_MS);
        })
        .catch(() => schedule(IDLE_POLL_MS));
    };

    poll();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [locked]);

  function cancelVoiceInteraction(): void {
    if (!voiceSnapshot || !["wake_detected", "listening", "transcribing", "submitting"].includes(voiceSnapshot.state)) return;
    voiceCancelPending.current = true;
    setVoiceSnapshot(null);
    setState("idle");
    void syncJarvisVoiceInteractionLock(true).catch(() => {
      voiceCancelPending.current = false;
      void syncJarvisVoiceInteractionLock(false).catch(() => undefined);
    });
  }

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

  const voiceHudVisible = !locked && !!voiceSnapshot && VOICE_HUD_STATES.has(voiceSnapshot.state);
  const listening = voiceSnapshot?.state === "wake_detected" || voiceSnapshot?.state === "listening";
  const level = listening ? (voiceSnapshot?.inputLevel ?? 0) : 0;
  const launcherStyle = {
    "--jarvis-level": String(level),
    "--jarvis-scale": String(1 + level * 0.045),
    "--jarvis-glow-alpha": String(0.35 + level * 0.6),
    "--jarvis-glow-blur": `${18 + level * 24}px`,
  } as CSSProperties;

  return (
    <div className="jarvis-root" data-testid="jarvis-root">
      {voiceHudVisible && !open && voiceSnapshot && (
        <section className="jarvis-voice-hud" data-testid="jarvis-voice-hud" aria-live="polite" aria-label="Состояние голоса Jarvis">
          <div className="jarvis-voice-hud__topline">
            <div className="jarvis-voice-hud__status">
              <span className={`jarvis-voice-hud__dot jarvis-voice-hud__dot--${voiceSnapshot.state}`} aria-hidden="true" />
              <strong>{voiceHudLabel(voiceSnapshot.state)}</strong>
            </div>
            {["wake_detected", "listening", "transcribing", "submitting"].includes(voiceSnapshot.state) && (
              <button
                type="button"
                className="jarvis-voice-hud__cancel"
                data-testid="jarvis-voice-cancel"
                aria-label="Отменить голосовой запрос"
                onClick={cancelVoiceInteraction}
              >
                <Icon name="close" />
              </button>
            )}
          </div>
          {voiceSnapshot.recognizedText ? (
            <p className="jarvis-voice-hud__transcript" data-testid="jarvis-voice-transcript">{voiceSnapshot.recognizedText}</p>
          ) : (
            <p className="jarvis-voice-hud__hint">
              {listening ? "Говорите — микрофон активен" : voiceSnapshot.state === "transcribing" ? "Преобразую речь в текст…" : "Секунду…"}
            </p>
          )}
          {(voiceSnapshot.state === "speaking" || voiceSnapshot.state === "ready") && voiceSnapshot.responseText && (
            <p className="jarvis-voice-hud__response">{voiceSnapshot.responseText}</p>
          )}
        </section>
      )}

      <button
        type="button"
        className={[
          "jarvis-launcher",
          voiceHudVisible ? "jarvis-launcher--voice-active" : "",
          listening ? "jarvis-launcher--listening" : "",
          voiceSnapshot?.state === "speaking" ? "jarvis-launcher--speaking" : "",
        ].filter(Boolean).join(" ")}
        style={launcherStyle}
        data-testid="jarvis-launcher"
        data-voice-state={voiceSnapshot?.state ?? "none"}
        data-input-level={level.toFixed(3)}
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
                state === "processing" || state === "submitting" ? "Обрабатываю" : state === "listening" ? "Слушаю" : state === "transcribing" ? "Распознаю" : state === "speaking" ? "Говорю" : state === "error" ? "Ошибка" : state === "ready" ? "Готово" : "Ожидаю"
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
