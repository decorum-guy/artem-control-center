import { useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Icon } from "../../icons";
import { StatusText, WorkZone } from "../../ShellPrimitives";
import { Sheet } from "../../Sheet";
import { Button, Select, Slider } from "../../ui/Controls";
import { useTV, type Action, type NavigationKey } from "./useTV";
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

function Feedback({ text, detail, error = false }: { text?: string; detail?: string; error?: boolean }) {
  return <p className="tv-message" data-error={error || undefined} role="status" title={[text, detail].filter(Boolean).join(" ") || undefined}>
    {text && <span>{text}</span>}{text && detail && " "}{detail && <span>{detail}</span>}
  </p>;
}

function HappButton({ controller }: { controller: Controller }) {
  if (!controller.controls.connectHapp) return null;
  return <Button icon="shield" aria-label="Подключить VPN через Happ"
    onClick={() => { void controller.send({ action: "vpn-connect" }); }}
    disabled={!controller.remoteStatus} aria-disabled={controller.pending !== null || undefined}>Happ</Button>;
}

function Commands({ controller, compact = false, showFeedback = true }: { controller: Controller; compact?: boolean; showFeedback?: boolean }) {
  const { state, controls, link, pending, notice, navigationNotice, remoteStatus, send } = controller;
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const screen = state?.screen;
  const screenAction = screen === "on" ? "screen-off" : screen === "off" ? "screen-on" : null;
  const audioPending = pending === "volume-up" || pending === "volume-down" || pending === "volume-set" || pending === "mute";
  const volume = state?.volume ?? null;
  const range = controls.volumeRange;
  const act = (action: Action) => () => { void send({ action }); };
  const screenStatus = <StatusText label={deviceLabel(controller)} showIndicator={!compact}
    tone={link === "samsung-unreachable" || link === "tv-unreachable" ? "unavailable" : screen === "on" ? "success" : "neutral"} />;
  const tunnel = state?.vpn;
  const vpnLabel = tunnel === true ? "VPN включён" : tunnel === false ? "VPN выключен" : "Статус VPN неизвестен";
  const vpnStatus = <StatusText label={vpnLabel} showIndicator={false} tone={tunnel === true ? "success" : "neutral"} />;
  const maintenance = state?.maintenance;
  const feedback = <Feedback text={showFeedback && notice?.kind === "command" ? notice.text : undefined}
    detail={showFeedback ? navigationNotice : undefined} error={notice?.error || Boolean(navigationNotice)} />;
  return <>
    <div className="tv-device-row">
      {compact ? <div className="tv-widget-info">
        <header className="tv-widget-title"><Icon name="television" /><h2>Телевизор</h2></header>
        <div className="tv-widget-statuses">
          {screenStatus}
          {vpnStatus}
        </div>
        {feedback}
      </div> : screenStatus}
      <Button icon="power" variant="primary" disabled={!remoteStatus || !screenAction}
        aria-disabled={pending !== null || undefined} onClick={screenAction ? act(screenAction) : undefined}>
        {screenAction === "screen-off" ? "Погасить экран" : screenAction === "screen-on" ? "Включить экран" : "Экран"}
      </Button>
    </div>
    {!compact && feedback}
    <div className="tv-audio" role="group" aria-label="Громкость" aria-busy={audioPending || undefined}>
      {range ? <Slider label="Громкость" min={range.min} max={range.max} value={remoteStatus ? volumeDraft ?? volume ?? range.min : range.min}
        displayValue={remoteStatus && volume !== null ? String(volumeDraft ?? volume) + (pending === "volume-set" ? "…" : "") : "—"}
        disabled={!remoteStatus || volume === null || pending !== null} onChange={setVolumeDraft} onCancel={() => setVolumeDraft(null)}
        onCommit={(value) => {
          void send({ action: "volume-set", volume: value }).finally(() => setVolumeDraft(null));
        }} /> : <>
      <span>Громкость</span>
      <div className="cc-stepper tv-volume">
        <Button icon="minus" aria-label="Тише" disabled={!remoteStatus} aria-disabled={pending !== null || undefined} onClick={act("volume-down")} />
        <output aria-label="Подтверждённая громкость" data-pending={audioPending || undefined}>{audioPending ? "…" : state?.volume ?? "—"}</output>
        <Button icon="plus" aria-label="Громче" disabled={!remoteStatus} aria-disabled={pending !== null || undefined} onClick={act("volume-up")} />
      </div>
      </>}
      <Button className="tv-mute" icon={state?.muted === true ? "volume-muted" : "volume"}
        aria-label={state?.muted === true ? "Включить звук" : state?.muted === false ? "Выключить звук" : "Переключить звук"}
        disabled={!remoteStatus} aria-disabled={pending !== null || undefined} onClick={act("mute")} />
    </div>
    {!compact && <div className="tv-maintenance">
      {vpnStatus}
      <span>Фильтр ADB · {maintenance?.guard === "verified" ? "проверен" : maintenance?.guard === "failed" ? "проверка не прошла" : "нет данных"}</span>
      {tunnel !== true && maintenance?.happ === "pending" && <span>Happ подключает VPN</span>}
      {tunnel !== true && maintenance?.happ === "failed" && <span>Happ не смог включить VPN</span>}
      {maintenance?.policy === "failed" && <span>Исключение KGZN · проверка не прошла</span>}
    </div>}
  </>;
}

const keys: Partial<Record<string, NavigationKey>> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "ok", Backspace: "back", Home: "home"
};
const directions = [
  ["up", "Вверх", "chevron-up"], ["left", "Влево", "chevron-left"],
  ["right", "Вправо", "chevron-right"], ["down", "Вниз", "chevron-down"]
] as const;
const maxLinkLength = 2048;

function isWebLink(value: string) {
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function FullRemote({ controller, nativeLinkTargets = false, clipboardPaste = false }:
    { controller: Controller; nativeLinkTargets?: boolean; clipboardPaste?: boolean }) {
  const { catalogue, pending, send, navigate, notice, url, setUrl, selected, setSelection, remoteStatus, link } = controller;
  const input = useId();
  const linkInput = useRef<HTMLInputElement>(null);
  const [formError, setFormError] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [pasting, setPasting] = useState(false);
  const targets = catalogue.apps?.filter((app) => app.links).map((app) => ({ value: app.id, label: app.label })) ?? [];
  const busy = pending !== null;
  const navigationBusy = busy && pending !== "navigate";
  const key = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target) || event.defaultPrevented || event.repeat || event.altKey || event.metaKey || event.ctrlKey ||
        target.closest("input, select, textarea, [contenteditable], [aria-haspopup], [role=option], [role=slider]") ||
        (event.key === "Enter" && target.closest("button"))) return;
    const action = keys[event.key];
    if (action && remoteStatus) {
      event.preventDefault();
      navigate(action);
    }
  };
  const transmit = (event: FormEvent) => {
    event.preventDefault();
    if (!remoteStatus || busy || !url.trim() || !selected) return;
    setPasteError("");
    if (!isWebLink(url.trim())) {
      setFormError("Введите ссылку HTTP или HTTPS без учётных данных.");
      return;
    }
    setFormError("");
    void send({ action: "open-link", app: selected, url: url.trim() });
  };
  const paste = async () => {
    const field = linkInput.current;
    if (!field) return;
    const fallback = "Удерживайте поле ссылки и выберите «Вставить».";
    const clipboard = navigator.clipboard;
    if (!clipboard?.readText) {
      setPasteError(fallback);
      return;
    }
    const previous = field.value;
    setPasteError("");
    setPasting(true);
    try {
      const copied = await clipboard.readText();
      if (linkInput.current !== field || field.value !== previous) return;
      const value = copied.trim();
      if (value.length > maxLinkLength || !isWebLink(value)) {
        setPasteError("Скопируйте ссылку HTTP или HTTPS без учётных данных, длиной до 2048 символов.");
        return;
      }
      setUrl(value);
      setFormError("");
    } catch {
      if (linkInput.current === field && field.value === previous) {
        setPasteError(fallback);
      }
    } finally {
      setPasting(false);
    }
  };
  const linkMessage = pasteError || formError || (notice?.kind === "link" ? notice.text : undefined);
  const changeTarget = (app: string) => { setSelection(app); setFormError(""); };
  return <section className="tv-full" tabIndex={0} aria-label="Управление телевизором" onKeyDown={key}
    onClickCapture={(event) => {
      // WebKit may leave focus on the page after a pointer activates a native button.
      const button = (event.target as Element).closest<HTMLButtonElement>("button:not([aria-haspopup])");
      if (button && event.currentTarget.contains(button)) button.focus({ preventScroll: true });
    }}>
    <Commands controller={controller} />
    <div className="tv-dpad" role="group" aria-label="Навигация">
      {directions.map(([action, title, icon]) => <Button key={action} className={`tv-key-${action}`} icon={icon}
        aria-label={title} onClick={() => navigate(action)} disabled={!remoteStatus} aria-disabled={navigationBusy || undefined} />)}
      <Button className="tv-key-ok" onClick={() => navigate("ok")}
        disabled={!remoteStatus} aria-disabled={navigationBusy || undefined}>OK</Button>
    </div>
    <div className="tv-actions">
      <Button icon="chevron-left" onClick={() => navigate("back")} disabled={!remoteStatus} aria-disabled={navigationBusy || undefined}>Назад</Button>
      <Button icon="home" onClick={() => navigate("home")} disabled={!remoteStatus} aria-disabled={navigationBusy || undefined}>Домой</Button>
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
      <HappButton controller={controller} />
    </div>
    <form className="tv-link" onSubmit={transmit} noValidate>
      <label htmlFor={input}>Ссылка на телевизор</label>
      <div className="tv-link-input">
        <input ref={linkInput} id={input} type="url" name="url" value={url}
          onChange={(event) => { setUrl(event.target.value); setFormError(""); setPasteError(""); }}
          placeholder="https://" maxLength={maxLinkLength} autoCapitalize="off" autoCorrect="off" aria-invalid={Boolean(formError) || undefined} />
        {clipboardPaste && <Button className="tv-icon-button" icon="clipboard" aria-label="Вставить ссылку"
          title="Вставить ссылку" disabled={pasting} onClick={() => { void paste(); }} />}
      </div>
      <div className="tv-link-actions">
        {nativeLinkTargets ? <label className="tv-native-choice">
          <span>Открыть в приложении</span>
          <select value={selected} disabled={!targets.length} onChange={(event) => changeTarget(event.target.value)}>
            {!targets.length && <option value="">—</option>}
            {targets.map((target) => <option key={target.value} value={target.value}>{target.label}</option>)}
          </select>
          <Icon name="chevron-down" size={16} />
        </label> : <Select compact label="Открыть в приложении" value={selected} options={targets} onChange={changeTarget} />}
        <Button type="submit" disabled={!remoteStatus || !url.trim() || !selected} aria-disabled={busy || undefined}>Отправить</Button>
      </div>
      <Feedback text={linkMessage} error={Boolean(formError || pasteError) || notice?.error} />
    </form>
  </section>;
}

export function TelevisionWidget({ interactive }: { interactive: boolean }) {
  const controller = useTV("/api/tv", interactive);
  const [open, setOpen] = useState(false);
  const shortcuts = controller.catalogue.apps?.filter((app) => app.id === "youtube" || app.id === "browser") ?? [];
  return <WorkZone className="overview-v2-real-widget tv-widget" data-testid="television-widget">
    <Commands controller={controller} compact showFeedback={!open} />
    <div className="tv-widget-actions">
      {shortcuts.map((app) => <Button key={app.id} aria-label={app.label}
        onClick={() => { void controller.send({ action: "open-app", app: app.id }); }}
        disabled={!controller.remoteStatus} aria-disabled={controller.pending !== null || undefined}>{app.id === "browser" ? "Яндекс" : app.label}</Button>)}
      <HappButton controller={controller} />
      <Button className="tv-open" onClick={() => setOpen(true)} disabled={!interactive}>Полный пульт <Icon name="chevron-right" /></Button>
    </div>
    {open && interactive && <Sheet title="Пульт телевизора" onClose={() => setOpen(false)} className="tv-sheet">
      <FullRemote controller={controller} />
    </Sheet>}
  </WorkZone>;
}
