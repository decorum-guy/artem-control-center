import { useId, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Icon } from "../../icons";
import { StatusText, WorkZone } from "../../ShellPrimitives";
import { Sheet } from "../../Sheet";
import { Button, Select } from "../../ui/Controls";
import { useTV, type Action } from "./useTV";
import "./tv.css";

type Controller = ReturnType<typeof useTV>;

function deviceLabel({ link, state }: Controller) {
  if (link === "connecting") return "Подключение";
  if (link === "samsung-unreachable") return "Нет связи с Samsung";
  if (link === "tv-unreachable") return "Samsung доступен, ТВ не отвечает";
  if (link === "unknown") return "Статус ТВ неизвестен";
  if (state?.screen === "on") return "Экран включён";
  if (state?.screen === "off") return "Экран погашен";
  if (state?.screen === "sleeping") return "ТВ в режиме ожидания";
  return "Состояние экрана неизвестно";
}

function Feedback({ text, error = false }: { text?: string; error?: boolean }) {
  return <p className="tv-message" data-error={error || undefined} role="status">{text}</p>;
}

function Commands({ controller, compact = false, showFeedback = true }: { controller: Controller; compact?: boolean; showFeedback?: boolean }) {
  const { state, link, pending, notice, remoteStatus, send } = controller;
  const screen = state?.screen;
  const screenAction = screen === "on" ? "screen-off" : screen === "off" ? "screen-on" : null;
  const audioPending = pending === "volume-up" || pending === "volume-down" || pending === "mute";
  const act = (action: Action) => () => { void send({ action }); };
  return <>
    <div className="tv-device-row">
      <StatusText label={deviceLabel(controller)}
        tone={link === "samsung-unreachable" || link === "tv-unreachable" ? "unavailable" : state?.screen === "on" ? "success" : "neutral"} />
      <Button icon="power" variant="primary" disabled={!remoteStatus || !screenAction}
        aria-disabled={pending !== null || undefined} onClick={screenAction ? act(screenAction) : undefined}>
        {screenAction === "screen-off" ? "Погасить экран" : screenAction === "screen-on" ? "Включить экран" : "Экран"}
      </Button>
    </div>
    <Feedback text={showFeedback && notice?.kind === "command" ? notice.text : undefined} error={notice?.error} />
    <div className="tv-audio" role="group" aria-label="Громкость" aria-busy={audioPending || undefined}>
      <span>Громкость</span>
      <div className="cc-stepper tv-volume">
        <Button icon="minus" aria-label="Тише" disabled={!remoteStatus} aria-disabled={pending !== null || undefined} onClick={act("volume-down")} />
        <output aria-label="Подтверждённая громкость" data-pending={audioPending || undefined}>{audioPending ? "…" : state?.volume ?? "—"}</output>
        <Button icon="plus" aria-label="Громче" disabled={!remoteStatus} aria-disabled={pending !== null || undefined} onClick={act("volume-up")} />
      </div>
      <Button className="tv-mute" icon={state?.muted === true ? "volume-muted" : "volume"}
        aria-label={state?.muted === true ? "Включить звук" : state?.muted === false ? "Выключить звук" : "Переключить звук"}
        disabled={!remoteStatus} aria-disabled={pending !== null || undefined} onClick={act("mute")} />
    </div>
    {!compact && !state?.maintenance && <p className="tv-maintenance">Happ и фильтр ADB · нет данных</p>}
    {!compact && state?.maintenance && <div className="tv-maintenance">
      {state.maintenance.guard !== undefined && <span>Фильтр ADB · {state.maintenance.guard === "verified" ? "проверен" : state.maintenance.guard === "failed" ? "проверка не прошла" : "нет подтверждения"}</span>}
      {state.maintenance.happ !== undefined && <span>Happ · {state.maintenance.happ === "verified" ? "VPN подтверждён" : state.maintenance.happ === "failed" ? "ошибка восстановления" : state.maintenance.happ === "pending" ? "восстановление" : "нет подтверждения"}</span>}
      {state.maintenance.policy === "failed" && <span>Исключение KGZN · проверка не прошла</span>}
    </div>}
  </>;
}

const keys: Partial<Record<string, Action>> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "ok", Backspace: "back", Home: "home"
};
const directions = [
  ["up", "Вверх", "chevron-up"], ["left", "Влево", "chevron-left"],
  ["right", "Вправо", "chevron-right"], ["down", "Вниз", "chevron-down"]
] as const;

export function FullRemote({ controller }: { controller: Controller }) {
  const { catalogue, pending, send, notice, url, setUrl, selected, setSelection, remoteStatus, link } = controller;
  const input = useId();
  const [formError, setFormError] = useState("");
  const targets = catalogue.apps?.filter((app) => app.links).map((app) => ({ value: app.id, label: app.label })) ?? [];
  const busy = pending !== null;
  const key = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target) || event.repeat || event.altKey || event.metaKey || event.ctrlKey ||
        target.closest("input, select, textarea, [contenteditable], [aria-haspopup], [role=option]") ||
        (event.key === "Enter" && target.closest("button"))) return;
    const action = keys[event.key];
    if (action && remoteStatus) {
      event.preventDefault();
      if (!busy) void send({ action });
    }
  };
  const transmit = (event: FormEvent) => {
    event.preventDefault();
    if (!remoteStatus || busy || !url.trim() || !selected) return;
    try {
      const parsed = new URL(url.trim());
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    } catch {
      setFormError("Введите ссылку HTTP или HTTPS без учётных данных.");
      return;
    }
    setFormError("");
    void send({ action: "open-link", app: selected, url: url.trim() });
  };
  const linkMessage = formError || (notice?.kind === "link" ? notice.text : undefined);
  return <section className="tv-full" tabIndex={0} aria-label="Управление телевизором" onKeyDown={key}
    onClickCapture={(event) => {
      // WebKit may leave focus on the page after a pointer activates a native button.
      const button = (event.target as Element).closest<HTMLButtonElement>("button:not([aria-haspopup])");
      if (button && event.currentTarget.contains(button)) button.focus({ preventScroll: true });
    }}>
    <Commands controller={controller} />
    <div className="tv-dpad" role="group" aria-label="Навигация">
      {directions.map(([action, title, icon]) => <Button key={action} className={`tv-key-${action}`} icon={icon}
        aria-label={title} onClick={() => { void send({ action }); }} disabled={!remoteStatus} aria-disabled={busy || undefined} />)}
      <Button className="tv-key-ok" onClick={() => { void send({ action: "ok" }); }}
        disabled={!remoteStatus} aria-disabled={busy || undefined}>OK</Button>
    </div>
    <div className="tv-actions">
      <Button icon="chevron-left" onClick={() => { void send({ action: "back" }); }} disabled={!remoteStatus} aria-disabled={busy || undefined}>Назад</Button>
      <Button icon="home" onClick={() => { void send({ action: "home" }); }} disabled={!remoteStatus} aria-disabled={busy || undefined}>Домой</Button>
    </div>
    <div className="tv-catalog" role="group" aria-label="Приложения">
      {catalogue.apps === undefined && <p className="tv-catalog-status">
        {link === "connecting" || link === "online" ? "Ожидаем каталог приложений" : "Каталог приложений недоступен"}
      </p>}
      {catalogue.apps?.length === 0 && <p className="tv-catalog-status">В каталоге нет приложений</p>}
      {catalogue.apps?.map((app) => <Button key={app.id} onClick={() => { void send({ action: "open-app", app: app.id }); }}
        disabled={!remoteStatus} aria-disabled={busy || undefined}>{app.label}</Button>)}
      {catalogue.saved?.map((item) => <Button key={item.id} onClick={() => { void send({ action: "saved", id: item.id }); }}
        disabled={!remoteStatus} aria-disabled={busy || undefined}>{item.label}</Button>)}
    </div>
    <form className="tv-link" onSubmit={transmit} noValidate>
      <label htmlFor={input}>Ссылка на телевизор</label>
      <input id={input} type="url" name="url" value={url} onChange={(event) => { setUrl(event.target.value); setFormError(""); }}
        placeholder="https://" maxLength={2048} autoCapitalize="off" autoCorrect="off" aria-invalid={Boolean(formError) || undefined} />
      <div className="tv-link-actions">
        <Select compact label="Открыть в приложении" value={selected} options={targets}
          onChange={(app) => { setSelection(app); setFormError(""); }} />
        <Button type="submit" disabled={!remoteStatus || !url.trim() || !selected} aria-disabled={busy || undefined}>Отправить</Button>
      </div>
      <Feedback text={linkMessage} error={Boolean(formError) || notice?.error} />
    </form>
  </section>;
}

export function TelevisionWidget({ interactive }: { interactive: boolean }) {
  const controller = useTV("/api/tv", interactive);
  const [open, setOpen] = useState(false);
  const youtube = controller.catalogue.apps?.find((app) => app.id === "youtube");
  return <WorkZone className="overview-v2-real-widget tv-widget" data-testid="television-widget">
    <header className="tv-widget-title"><Icon name="television" /><h2>Телевизор</h2></header>
    <Commands controller={controller} compact showFeedback={!open} />
    <div className="tv-widget-actions">
      {youtube && <Button onClick={() => { void controller.send({ action: "open-app", app: youtube.id }); }}
        disabled={!controller.remoteStatus} aria-disabled={controller.pending !== null || undefined}>{youtube.label}</Button>}
      <Button className="tv-open" onClick={() => setOpen(true)} disabled={!interactive}>Полный пульт <Icon name="chevron-right" /></Button>
    </div>
    {open && interactive && <Sheet title="Пульт телевизора" onClose={() => setOpen(false)} className="tv-sheet">
      <FullRemote controller={controller} />
    </Sheet>}
  </WorkZone>;
}
