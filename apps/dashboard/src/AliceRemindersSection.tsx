import { useEffect, useRef, useState, type FormEvent } from "react";
import type { StationReminderList } from "@artem/contracts";
import { DEFAULT_PLANNING_TIME_ZONE } from "./calendarRange";
import { useNoticeCenter } from "./NoticeCenter";
import { useInteractionLock } from "./InteractionLock";
import { PlanningSheet } from "./PlanningRoutePrimitives";
import { RouteHeader } from "./ShellPrimitives";
import { pageTitleField, useInterfaceCopy } from "./interfaceCopy";
import { useOwnerWarningDwell } from "./planningWarningDwell";

const dateTime = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: DEFAULT_PLANNING_TIME_ZONE
});
const formTime = new Intl.DateTimeFormat("en-GB", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  hourCycle: "h23", timeZone: DEFAULT_PLANNING_TIME_ZONE
});
const presets = [
  [30, "Через 30 минут"],
  [60, "Через час"],
  [120, "Через 2 часа"],
  [180, "Через 3 часа"]
] as const;
const statusText: Record<StationReminderList["status"], string> = {
  not_configured: "Источник Алисы не настроен",
  loading: "Загружаем напоминания…",
  fresh: "",
  partial: "Яндекс вернул неполный список",
  stale: "Нет свежих данных",
  auth_required: "Нужно восстановить вход в Яндекс"
};
const syncText = {
  connection: "Не удалось обновить список",
  partial: statusText.partial,
  stale: statusText.stale
};
const writeErrors: Record<string, string> = {
  time_must_be_future: "Выберите время в будущем.",
  invalid_time: "Проверьте дату и время.",
  auth_required: "Нужно восстановить вход в Яндекс.",
  voice_target_required: "Выберите колонку для озвучивания в настройках подключения.",
  incomplete_source: "Сохранение недоступно, пока Яндекс не вернёт полный список.",
  source_unavailable: "Яндекс недоступен. Повторите после восстановления связи.",
  reminder_changed: "Запись уже изменилась. Закройте окно и откройте её снова.",
  busy: "Сейчас сохраняется другое напоминание. Повторите чуть позже.",
  already_submitted: "Запрос уже был отправлен. Сверьтесь со списком.",
  unconfirmed: "Яндекс не подтвердил результат. Сверьтесь со списком перед повторной попыткой."
};
type Reminder = StationReminderList["items"][number];

function fields(date: Date) {
  const parts = Object.fromEntries(formTime.formatToParts(date).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function ReminderEditor({ item, writable, onClose, onSave }: {
  item: Reminder | null;
  writable: boolean;
  onClose: () => void;
  onSave: (title: string, dueLocal: string) => Promise<void>;
}) {
  const initial = fields(item?.dueAt ? new Date(item.dueAt) : new Date(Date.now() + 30 * 60_000));
  const [title, setTitle] = useState(item?.title ?? "");
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const pending = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !writable) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(title, `${date}T${time}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : writeErrors.unconfirmed);
      if (!(reason instanceof Error) || reason.message === writeErrors.unconfirmed) setUnconfirmed(true);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <PlanningSheet title={item ? "Перенести напоминание" : "Добавить напоминание"} eyebrow="Алиса"
      onClose={() => { if (!pending.current) onClose(); }} testId="alice-reminder-editor">
      <form className="planning-alice-reminders-form" onSubmit={(event) => void submit(event)}>
        {item ? <p>{item.title}</p> : (
          <label>О чём напомнить
            <input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
        )}
        {!item && (
          <div className="planning-alice-reminders-presets" role="group" aria-label="Быстрый выбор времени">
            {presets.map(([minutes, label]) => (
              <button key={minutes} type="button" className="planning-secondary-button"
                aria-pressed={selectedPreset === minutes} onClick={() => {
                  const next = fields(new Date(Date.now() + minutes * 60_000));
                  setDate(next.date);
                  setTime(next.time);
                  setSelectedPreset(minutes);
                }}>{label}</button>
            ))}
          </div>
        )}
        <div className="planning-alice-reminders-time">
          <label>Дата
            <input type="date" required min={fields(new Date()).date} value={date}
              onChange={(event) => { setDate(event.target.value); setSelectedPreset(null); }} />
          </label>
          <label>Время (МСК)
            <input type="time" required value={time}
              onChange={(event) => { setTime(event.target.value); setSelectedPreset(null); }} />
          </label>
        </div>
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="planning-primary-button" aria-disabled={!writable || undefined}
          disabled={saving || unconfirmed || !title.trim()}>
          {saving ? "Проверяем в Алисе…" : "Сохранить"}
        </button>
      </form>
    </PlanningSheet>
  );
}

export function AliceRemindersSection() {
  const [list, setList] = useState<StationReminderList>();
  const [readFailed, setReadFailed] = useState(false);
  const [editor, setEditor] = useState<Reminder | "new" | null>(null);
  const { showNotice } = useNoticeCenter();
  const { guardMutation } = useInteractionLock();
  const { copy } = useInterfaceCopy();
  const readEpoch = useRef(0);
  const status = list?.status ?? "loading";
  const confirmed = Boolean(list?.observedAt);
  const syncProblem = readFailed ? "connection" : status === "stale" || status === "partial" ? status : null;
  const delayedProblem = useOwnerWarningDwell(confirmed ? syncProblem : null);
  const visibleProblem = confirmed ? delayedProblem : syncProblem;
  const label = visibleProblem
    ? visibleProblem === "connection" && !confirmed ? "Не удалось связаться с панелью" : syncText[visibleProblem]
    : status === "fresh" && list?.voiceTargetConfigured === false
      ? "Колонка для озвучивания не настроена"
      : syncProblem && confirmed ? "" : statusText[status];
  const writable = status === "fresh" && !readFailed;
  const showEmpty = list?.items.length === 0 && (status === "fresh" || confirmed);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let inFlight = false;
    async function read() {
      if (inFlight) return;
      inFlight = true;
      window.clearTimeout(timer);
      const epoch = readEpoch.current;
      try {
        const response = await fetch("/api/v1/station/reminders", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)])
        });
        if (!response.ok && response.status !== 404) throw new Error("Could not read Alice reminders");
        const result: StationReminderList | null = response.status === 404 ? null : await response.json();
        if (!controller.signal.aborted && epoch === readEpoch.current) {
          const next = result ?? { status: "not_configured", observedAt: null, items: [] } as const;
          if (!Object.hasOwn(statusText, next.status) || !Array.isArray(next.items)) {
            throw new Error("Unexpected Alice reminder projection");
          }
          setList((previous) => {
            // The agent retains a checked list on source failure. Keep its
            // controls mounted for focus, with writes blocked while degraded.
            if ((next.status === "partial" || next.status === "stale")
              && next.observedAt && next.observedAt === previous?.observedAt) {
              return { ...next, canCreate: previous.canCreate, canReschedule: previous.canReschedule };
            }
            return next;
          });
          if (next.status === "auth_required" || next.status === "not_configured") setEditor(null);
          setReadFailed(false);
        }
      } catch {
        if (!controller.signal.aborted && epoch === readEpoch.current) {
          setReadFailed(true);
        }
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) timer = window.setTimeout(read, 10_000);
      }
    }

    const onVisibilityChange = () => { if (!document.hidden) void read(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void read();
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  async function save(title: string, dueLocal: string) {
    if (!editor || !guardMutation()) throw new Error("Панель заблокирована.");
    const editing = editor !== "new";
    if (!writable || !(editing ? list?.canReschedule : list?.canCreate)) throw new Error(writeErrors.source_unavailable);
    const endpoint = "/api/v1/station/reminders";
    const base = { attemptId: crypto.randomUUID(), dueLocal };
    readEpoch.current += 1;
    try {
      const response = await fetch(editing ? `${endpoint}/${editor.id}` : endpoint, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", "X-Panel-Intent": "station-reminders" },
        body: JSON.stringify(editing ? { ...base, expectedVersion: editor.version } : { ...base, title })
      });
      const result = await response.json();
      if (!response.ok) {
        const detail = typeof result.detail === "string" ? result.detail : "";
        throw new Error(writeErrors[detail] ?? "Алиса не приняла изменение. Сверьтесь со списком.");
      }
      setList(result as StationReminderList);
      setReadFailed(false);
      showNotice({
        id: "station-reminders-saved",
        severity: "success",
        title: editing ? "Время обновилось в Алисе." : "Напоминание добавлено в Алису.",
        detail: "Изменение подтверждено повторным чтением."
      });
      setEditor(null);
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) throw new Error(writeErrors.unconfirmed);
      throw error;
    } finally {
      readEpoch.current += 1;
    }
  }

  return (
    <div className="planning-route-page" data-testid="route-reminders">
      <RouteHeader title={copy(pageTitleField("reminders"))} description="" />
      <section className="planning-card planning-alice-reminders" aria-labelledby="alice-reminders-title"
        data-testid="alice-reminders" data-status={readFailed ? "transport_error" : status}>
        <div className="planning-alice-reminders-heading">
          <h2 id="alice-reminders-title">Напоминания Алисы</h2>
          {list?.canCreate && (
            <button className="planning-primary-button" type="button" aria-disabled={!writable || undefined}
              onClick={() => { if (writable) setEditor("new"); }}>Добавить</button>
          )}
        </div>
        <div className="planning-route-note planning-alice-reminders-sync">
          <span role="status" aria-atomic="true">{label}</span>
          {list?.observedAt && (
            <span>Проверено <time dateTime={list.observedAt}>{dateTime.format(new Date(list.observedAt))}</time></span>
          )}
        </div>
        {showEmpty && <p data-testid="alice-reminders-empty">
          {writable ? "Активных напоминаний Алисы нет." : "В последнем списке напоминаний не было."}
        </p>}
        {Boolean(list?.items.length) && (
          <ul className="planning-route-list">
            {list?.items.map((item) => (
              <li key={item.id} className="planning-route-row reminder-route-row">
                <div className="planning-route-row__main">
                  <span className="planning-route-row__eyebrow">
                    {item.dueAt ? <><time dateTime={item.dueAt}>{dateTime.format(new Date(item.dueAt))}</time> · МСК</> : "Ближайшее время неизвестно"}
                    {item.repeats && " · Повторяется"}
                  </span>
                  <strong>{item.title}</strong>
                </div>
                {list.canReschedule && item.version && item.dueAt && (
                  <button type="button" className="planning-secondary-button" aria-disabled={!writable || undefined}
                    onClick={() => { if (writable) setEditor(item); }}>Перенести</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {editor && <ReminderEditor item={editor === "new" ? null : editor}
        writable={writable && Boolean(editor === "new" ? list?.canCreate : list?.canReschedule)}
        onClose={() => setEditor(null)} onSave={save} />}
    </div>
  );
}
