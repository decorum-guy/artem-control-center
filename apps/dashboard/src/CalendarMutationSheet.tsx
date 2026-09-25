import { useEffect, useRef, useState } from "react";
import type { PlanningCalendarEvent } from "@artem/contracts";
import { addCalendarDays, DEFAULT_PLANNING_TIME_ZONE } from "./calendarRange";
import {
  calendarDurationPresets, calendarEditorFromParsedBody, calendarEditorWithDuration,
  calendarEditorWithStart, calendarEventBodyFromEditor, initialCalendarEventEditorState,
  type CalendarEditorDestination
} from "./calendarEventEditor";
import { CalendarTimePicker } from "./CalendarTimePicker";
import { PlanningSheet } from "./PlanningRoutePrimitives";
import { previewPlanningEvent } from "./planningReadClient";
import { calendarEventPreviewSaveState } from "./calendarEventPreviewPolicy";
import { eventMutationBodyFromPreview, proposedEventEndLabel, type EventMutationBody, type EventMutationSheetMode } from "./eventMutationBody";

function readableCalendarDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  try { if (addCalendarDays(value, 0) !== value) return value; } catch { return value; }
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
}

function DateControl({ label, value, onChange, testId }: { label: string; value: string; onChange: (value: string) => void; testId: string }) {
  return <div className="calendar-editor__date-control" data-testid={testId}>
    <span>{label}</span>
    <div className="calendar-editor__date-row">
      <button type="button" aria-label={`${label}: предыдущий день`} disabled={!value} onClick={() => onChange(addCalendarDays(value, -1))}>‹</button>
      <input type="date" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
      <button type="button" aria-label={`${label}: следующий день`} disabled={!value} onClick={() => onChange(addCalendarDays(value, 1))}>›</button>
    </div>
  </div>;
}

export function CalendarMutationSheet({ mode, event, selectedDate, destinations, onClose, onSubmit, conflict, onReload }: {
  mode: EventMutationSheetMode;
  event: PlanningCalendarEvent | null;
  selectedDate: string;
  destinations: readonly CalendarEditorDestination[];
  onClose: () => void;
  onSubmit: (body: EventMutationBody, destination: CalendarEditorDestination) => Promise<void>;
  conflict: boolean;
  onReload: () => Promise<void>;
}) {
  const [form, setForm] = useState(() => initialCalendarEventEditorState(selectedDate, destinations.find((destination) => destination.writable)?.id ?? destinations[0]?.id ?? "", event));
  const [activeTime, setActiveTime] = useState<"start" | "end">("start");
  const [saving, setSaving] = useState(false);
  const [phraseOpen, setPhraseOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewPlanningEvent>> | null>(null);
  const [parsing, setParsing] = useState(false);
  const [proposalAccepted, setProposalAccepted] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const destination = destinations.find((item) => item.id === form.destinationId) ?? destinations[0];
  const validation = calendarEventBodyFromEditor(form);
  const previewSaveState = calendarEventPreviewSaveState(preview, proposalAccepted);
  const fields = preview?.candidate?.fields ?? {};

  useEffect(() => {
    if (!phraseOpen || !phrase.trim()) { setPreview(null); setParsing(false); return undefined; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setParsing(true);
      void previewPlanningEvent(phrase.trim(), new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), DEFAULT_PLANNING_TIME_ZONE, controller.signal)
        .then(setPreview).catch(() => setPreview(null)).finally(() => setParsing(false));
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [phrase, phraseOpen]);

  async function save(): Promise<void> {
    if (!validation.body || !destination?.writable || saving || conflict) return;
    setSaving(true);
    try { await onSubmit(validation.body, destination); } finally { setSaving(false); }
  }

  function applyPhrase(): void {
    if (!previewSaveState.canSave) return;
    const body = eventMutationBodyFromPreview("create", fields, proposalAccepted);
    setForm((current) => calendarEditorFromParsedBody(current, body));
    setPhraseOpen(false);
  }

  function showTime(which: "start" | "end"): void {
    setActiveTime(which);
    window.requestAnimationFrame(() => pickerRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" }));
  }

  return <PlanningSheet
    title={mode === "create" ? "Новое событие" : "Изменить событие"}
    eyebrow="Календарь"
    onClose={onClose}
    initialFocusRef={titleRef}
    testId="planning-calendar-mutation"
    footer={<div className="calendar-editor__footer">
      <button type="button" className="planning-secondary-button" onClick={onClose}>Отмена</button>
      <button type="button" className="planning-primary-button" disabled={!validation.body || !destination?.writable || saving || conflict} onClick={() => void save()}>{saving ? "Сохраняем…" : "Сохранить"}</button>
    </div>}
  >
    <div className="calendar-editor">
      <div className="calendar-editor__destination">
        <span className="calendar-editor__field-label">Календарь</span>
        {destinations.length > 1 ? <select aria-label="Календарь" disabled={mode === "edit"} value={form.destinationId} onChange={(change) => setForm({ ...form, destinationId: change.target.value })}>
          {destinations.map((item) => <option value={item.id} disabled={!item.writable} key={item.id}>{item.label}</option>)}
        </select> : <div className="calendar-editor__destination-value" data-testid="calendar-editor-destination">
          <span className="calendar-editor__destination-dot" style={{ backgroundColor: destination?.color }} aria-hidden="true" />
          <strong>{destination?.label ?? "Календарь недоступен"}</strong>
          <span>{destination?.providerKind === "local" ? "Локальная запись" : destination?.writable ? "Доступен для записи" : "Только просмотр"}</span>
        </div>}
      </div>
      <label className="calendar-editor__field">
        <span className="calendar-editor__field-label">Название</span>
        <input ref={titleRef} value={form.title} maxLength={500} onChange={(change) => setForm({ ...form, title: change.target.value })} placeholder="Название события" data-testid="calendar-editor-title" />
      </label>
      <button type="button" className="calendar-editor__all-day" role="switch" aria-checked={form.allDay} onClick={() => setForm({ ...form, allDay: !form.allDay, durationMinutes: form.allDay ? null : form.durationMinutes })}>
        <span>Весь день</span><span className="calendar-editor__switch-track" aria-hidden="true"><span /></span>
      </button>
      <div className="calendar-editor__dates">
        <DateControl label="Дата начала" value={form.startDate} onChange={(value) => setForm((current) => calendarEditorWithStart(current, { startDate: value }))} testId="calendar-editor-start-date" />
        <DateControl label={form.allDay ? "Последний день" : "Дата конца"} value={form.endDate} onChange={(value) => setForm({ ...form, endDate: value, durationMinutes: null })} testId="calendar-editor-end-date" />
      </div>
      {form.allDay ? <p className="calendar-editor__span" data-testid="calendar-editor-all-day-span">Весь день: {form.startDate === form.endDate ? readableCalendarDate(form.startDate) : `${readableCalendarDate(form.startDate)} — ${readableCalendarDate(form.endDate)}`} включительно</p> : <>
        <div className="calendar-editor__time-summary" role="group" aria-label="Время события">
          <button type="button" aria-pressed={activeTime === "start"} onClick={() => showTime("start")}>Начало <strong>{form.startTime}</strong></button>
          <span aria-hidden="true">→</span>
          <button type="button" aria-pressed={activeTime === "end"} onClick={() => showTime("end")}>Конец <strong>{form.endTime}</strong></button>
        </div>
        <div ref={pickerRef}><CalendarTimePicker
          label={activeTime === "start" ? "Начало" : "Конец"}
          value={activeTime === "start" ? form.startTime : form.endTime}
          onChange={(value) => setForm((current) => activeTime === "start"
            ? calendarEditorWithStart(current, { startTime: value })
            : { ...current, endTime: value, durationMinutes: null })}
        /></div>
        <div className="calendar-editor__presets" role="group" aria-label="Длительность">
          <span className="calendar-editor__field-label">Длительность</span>
          {calendarDurationPresets.map((minutes) => <button type="button" key={minutes} aria-pressed={form.durationMinutes === minutes} onClick={() => setForm((current) => calendarEditorWithDuration(current, minutes))}>{minutes < 60 ? `${minutes} мин` : `${minutes / 60} ${minutes === 60 ? "час" : "часа"}`}</button>)}
        </div>
      </>}
      <label className="calendar-editor__field"><span className="calendar-editor__field-label">Место <small>необязательно</small></span><input value={form.location} maxLength={1000} onChange={(change) => setForm({ ...form, location: change.target.value })} /></label>
      <label className="calendar-editor__field"><span className="calendar-editor__field-label">Заметки <small>необязательно</small></span><textarea value={form.notes} maxLength={4000} rows={2} onChange={(change) => setForm({ ...form, notes: change.target.value })} /></label>
      <p className="calendar-editor__timezone">Часовой пояс: {form.timezone}</p>
      {validation.error && form.title.trim() && <p className="calendar-editor__error" role="status">{validation.error}</p>}
      {conflict && <div className="calendar-editor__conflict" role="alert"><strong>Событие изменилось</strong><p>Перечитайте актуальную запись перед сохранением.</p><button type="button" className="planning-secondary-button" onClick={() => void onReload()}>Перечитать событие</button></div>}
      {mode === "create" && <details className="calendar-editor__phrase" open={phraseOpen} onToggle={(event) => setPhraseOpen(event.currentTarget.open)}>
        <summary>Ввести фразой</summary>
        <div className="calendar-editor__phrase-body">
          <label className="calendar-editor__field"><span className="calendar-editor__field-label">Фраза</span><textarea id="planning-calendar-free-text" value={phrase} rows={2} onChange={(change) => { setPhrase(change.target.value); setProposalAccepted(false); }} placeholder="Например: завтра в 18:30–19:30 встреча" /></label>
          {parsing && <p>Проверяем формулировку…</p>}
          {preview && <section className="planning-mutation-preview" data-testid="planning-calendar-preview" aria-live="polite">
            <p className="planning-mutation-preview__eyebrow">Расшифровка</p>
            <p className="planning-mutation-preview__restatement">{preview.candidate?.normalized_paraphrase ?? "Предложение пока не сформировано."}</p>
            {previewSaveState.isCanonicalStartOnlyProposal && <div className="planning-mutation-preview__ambiguities" data-testid="planning-calendar-proposal"><strong>Предлагаемый конец: {proposedEventEndLabel(fields) ?? "60 минут"}</strong><button type="button" className="planning-secondary-button" aria-pressed={proposalAccepted} onClick={() => setProposalAccepted((value) => !value)}>{proposalAccepted ? "60 минут приняты" : "Принять 60 минут"}</button></div>}
            {preview.ambiguities.length > 0 && <div className="planning-mutation-preview__ambiguities" data-testid="planning-calendar-ambiguities"><strong>Нужно уточнить</strong>{preview.ambiguities.map((ambiguity) => <p key={`${ambiguity.field}-${ambiguity.reason}`}>{ambiguity.reason}</p>)}</div>}
            {preview.error_code && <p className="planning-mutation-form__error">Формулировка не подтверждена.</p>}
          </section>}
          <button type="button" className="planning-secondary-button" disabled={!previewSaveState.canSave || parsing} onClick={applyPhrase}>Перенести в поля</button>
        </div>
      </details>}
    </div>
  </PlanningSheet>;
}
