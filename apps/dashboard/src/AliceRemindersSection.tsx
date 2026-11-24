import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { StationReminderList } from "@artem/contracts";
import { DEFAULT_PLANNING_TIME_ZONE } from "./calendarRange";
import { useInteractionLock } from "./InteractionLock";
import { PlanningSheet } from "./PlanningRoutePrimitives";
import { RouteHeader } from "./ShellPrimitives";

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
  loading: "Загружаем напоминания…",
  fresh: "",
  partial: "Яндекс вернул неполный список",
  stale: "Нет свежих данных",
  auth_required: "Нужно восстановить вход в Яндекс"
};
const writeErrors: Record<string, string> = {
  time_must_be_future: "Выберите время в будущем.",
  invalid_time: "Проверьте дату и время.",
  auth_required: "Нужно восстановить вход в Яндекс.",
  incomplete_source: "Яндекс вернул неполный список. Дождитесь следующего обновления.",
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

function ReminderEditor({ item, onClose, onSave }: {
  item: Reminder | null;
  onClose: () => void;
  onSave: (title: string, dueLocal: string) => Promise<void>;
}) {
  const initial = fields(item ? new Date(item.dueAt) : new Date(Date.now() + 30 * 60_000));
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
    if (pending.current) return;
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
        <button type="submit" className="planning-primary-button" disabled={saving || unconfirmed || !title.trim()}>
          {saving ? "Проверяем в Алисе…" : "Сохранить"}
        </button>
      </form>
    </PlanningSheet>
  );
}

export function AliceRemindersSection({ fallback }: { fallback: ReactNode }) {
  const [list, setList] = useState<StationReminderList | null>();
  const [readFailed, setReadFailed] = useState(false);
  const [editor, setEditor] = useState<Reminder | "new" | null>(null);
  const [notice, setNotice] = useState("");
  const { guardMutation } = useInteractionLock();
  const readEpoch = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function read() {
      const epoch = readEpoch.current;
      try {
        const response = await fetch("/api/v1/station/reminders", {
          cache: "no-store",
          signal: controller.signal
        });
        if (response.status === 404) {
          if (!controller.signal.aborted && epoch === readEpoch.current) setList(null);
          return;
        }
        if (!response.ok) throw new Error("Could not read Alice reminders");
        const result: StationReminderList | null = await response.json();
        if (!controller.signal.aborted && epoch === readEpoch.current) {
          setList(result);
          setReadFailed(false);
        }
      } catch {
        if (!controller.signal.aborted && epoch === readEpoch.current) {
          setReadFailed(true);
          setList((previous) => previous && { ...previous, status: "stale", canCreate: false, canReschedule: false });
        }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(read, 10_000);
      }
    }

    void read();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  async function save(title: string, dueLocal: string) {
    if (!editor || !guardMutation()) throw new Error("Панель заблокирована.");
    const editing = editor !== "new";
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
      setNotice(editing ? "Время обновилось в Алисе." : "Напоминание добавлено в Алису.");
      setEditor(null);
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) throw new Error(writeErrors.unconfirmed);
      throw error;
    } finally {
      readEpoch.current += 1;
    }
  }

  if (list === null) return fallback;
  return (
    <div className="planning-route-page" data-testid="route-reminders">
      <RouteHeader title="Напоминания" description="" />
      <section className="planning-card planning-alice-reminders" aria-labelledby="alice-reminders-title"
        data-testid="alice-reminders" data-status={list?.status}>
        <div className="planning-alice-reminders-heading">
          <h2 id="alice-reminders-title">Напоминания Алисы</h2>
          {list?.canCreate && (
            <button className="planning-primary-button" type="button" onClick={() => setEditor("new")}>Добавить</button>
          )}
        </div>
        <p className="planning-route-note" role="status">
          {list ? statusText[list.status] : readFailed ? "Не удалось связаться с панелью" : statusText.loading}
          {list?.observedAt && <>
            {list.status !== "fresh" && " · "}Проверено <time dateTime={list.observedAt}>{dateTime.format(new Date(list.observedAt))}</time>
          </>}
        </p>
        {notice && <p role="status">{notice}</p>}
        {list?.status === "fresh" && list.items.length === 0 && <p>Активных напоминаний Алисы нет.</p>}
        {Boolean(list?.items.length) && (
          <ul className="planning-route-list">
            {list?.items.map((item) => (
              <li key={item.id} className="planning-route-row reminder-route-row">
                <div className="planning-route-row__main">
                  <span className="planning-route-row__eyebrow">
                    <time dateTime={item.dueAt}>{dateTime.format(new Date(item.dueAt))}</time> · МСК
                    {item.repeats && " · Повторяется"}
                  </span>
                  <strong>{item.title}</strong>
                </div>
                {list.canReschedule && item.version && (
                  <button type="button" className="planning-secondary-button" onClick={() => setEditor(item)}>Перенести</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {editor && <ReminderEditor item={editor === "new" ? null : editor} onClose={() => setEditor(null)} onSave={save} />}
    </div>
  );
}
