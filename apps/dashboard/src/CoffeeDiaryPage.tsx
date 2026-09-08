import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import type {
  CoffeeDiaryBean,
  CoffeeDiaryCollection,
  CoffeeDiaryExtraction,
  CoffeeDiaryPreferredDrink,
  CoffeeDiaryUploadSession
} from "@artem/contracts";
import { Sheet } from "./Sheet";
import { DialogFrame } from "./DialogFrame";
import { RouteHeader } from "./ShellPrimitives";
import { useInterfaceCopy } from "./interfaceCopy";
import { useActionConfirmation } from "./ActionConfirmations";
import { useInteractionLock } from "./InteractionLock";
import { NumericKeypad } from "./NumericKeypad";
import { normalizeNumericInput, numericInputValue } from "./coffeeDiaryNumeric";
import { coffeeDiaryApiMessage } from "./coffeeDiaryMessages";
import { createCoffeeDiaryCreateAttempt, type CoffeeDiaryCreateAttempt } from "./coffeeDiaryCreateAttempt";
import {
  CoffeeDiaryApiError,
  cancelCoffeeDiaryPhotoUploadSession,
  coffeeDiaryPendingPhotoContentUrl,
  coffeeDiaryPhotoContentUrl,
  createCoffeeDiaryBeanPhotoUploadSession,
  createCoffeeDiaryPhotoUploadSession,
  createCoffeeDiaryBean,
  createCoffeeDiaryExtraction,
  discardCoffeeDiaryPendingPhoto,
  deleteCoffeeDiaryBean,
  deleteCoffeeDiaryExtraction,
  getCoffeeDiary,
  getCoffeeDiaryBean,
  getCoffeeDiaryExport,
  getCoffeeDiaryPhotoUploadSession,
  downloadCoffeeDiaryCsv,
  downloadCoffeeDiaryZip,
  patchCoffeeDiaryBean,
  patchCoffeeDiaryFavorite
} from "./coffeeDiaryApi";
import {
  bestCoffeeDiaryExtraction,
  coffeeDiaryShotSummary,
  preferredDrinkLabel
} from "./coffeeDiaryPresentation";
import "./coffeeDiary.css";

type BeanDraft = {
  name: string;
  grindDescription: string;
  preferredDrink: CoffeeDiaryPreferredDrink | "";
  notes: string;
  roaster: string;
  roastDate: string;
  roastLevel: string;
  roastNotes: string;
  origin: string;
  processing: string;
};

const preferredDrinkOptions: Array<{ value: CoffeeDiaryPreferredDrink | ""; label: string }> = [
  { value: "", label: "Не указано" },
  { value: "espresso", label: "Эспрессо" },
  { value: "milk", label: "Молочный напиток" },
  { value: "universal", label: "Универсально" }
];

function beanToDraft(bean?: CoffeeDiaryBean): BeanDraft {
  return {
    name: bean?.name ?? "",
    grindDescription: bean?.grindDescription ?? "",
    preferredDrink: bean?.preferredDrink ?? "",
    notes: bean?.notes ?? "",
    roaster: bean?.roaster ?? "",
    roastDate: bean?.roastDate ?? "",
    roastLevel: bean?.roastLevel ?? "",
    roastNotes: bean?.roastNotes ?? "",
    origin: bean?.origin ?? "",
    processing: bean?.processing ?? ""
  };
}

function localDateTimeValue(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function toUtcTimestamp(localValue: string): string | null {
  const parsed = new Date(localValue);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function gramsValue(value: string): number | null {
  return numericInputValue(normalizeNumericInput(value, true, 8, 1));
}

function secondsValue(value: string): number | null {
  const normalized = normalizeNumericInput(value, false, 4);
  const parsed = numericInputValue(normalized);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function ratingValue(value: string): number | null {
  const normalized = normalizeNumericInput(value, false, 2);
  const parsed = numericInputValue(normalized);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function isRevisionConflict(reason: unknown): boolean {
  return reason instanceof CoffeeDiaryApiError && reason.code === "revision_conflict";
}

function uploadSessionTimeCopy(seconds: number): string {
  if (seconds <= 0) return "Ссылка истекла";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `Ссылка действует ещё ${minutes}:${String(remainder).padStart(2, "0")}`;
}

function uploadSessionErrorCopy(reason: unknown): string {
  const code = reason instanceof CoffeeDiaryApiError ? reason.code : "";
  if (code === "coffee_diary_upload_token_expired") return "Срок действия QR-ссылки истёк.";
  if (code === "coffee_diary_upload_token_cancelled") return "QR-ссылка отменена.";
  if (code === "coffee_diary_upload_token_consumed") return "Фото уже принято.";
  if (code === "coffee_diary_upload_sessions_full") return "Слишком много активных QR-ссылок. Повторите позже.";
  if (code === "coffee_diary_upload_origin_required" || code === "coffee_diary_upload_origin_invalid" || code === "coffee_diary_upload_ingress_invalid") {
    return "Загрузка фото с телефона недоступна: требуется настроить безопасный адрес.";
  }
  return "Не удалось создать QR-ссылку. Повторите попытку.";
}

function PhotoUploadDialog({
  session,
  onClose,
  onSessionUpdate,
  onUploaded
}: {
  session: CoffeeDiaryUploadSession;
  onClose: () => void;
  onSessionUpdate: (session: CoffeeDiaryUploadSession) => void;
  onUploaded: (session: CoffeeDiaryUploadSession) => void;
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const handledRef = useRef(false);
  const onSessionUpdateRef = useRef(onSessionUpdate);
  const onUploadedRef = useRef(onUploaded);
  const { sessionId, state } = session;
  onSessionUpdateRef.current = onSessionUpdate;
  onUploadedRef.current = onUploaded;

  useEffect(() => {
    let cancelled = false;
    if (!session.uploadUrl) return () => { cancelled = true; };
    void QRCode.toDataURL(session.uploadUrl, { errorCorrectionLevel: "M", margin: 2, width: 280 })
      .then((url) => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { if (!cancelled) setQrDataUrl(null); });
    return () => { cancelled = true; };
  }, [session.uploadUrl]);

  useEffect(() => {
    if (!["created", "uploading"].includes(state)) return;
    const timer = window.setInterval(() => {
      void getCoffeeDiaryPhotoUploadSession(sessionId).then((next) => {
        onSessionUpdateRef.current(next);
        if (!handledRef.current && ((next.state === "consumed" && next.photoId) || (next.state === "uploaded" && next.pendingAttachmentId))) {
          handledRef.current = true;
          onUploadedRef.current(next);
        }
      }).catch(() => setPollError("Не удалось обновить статус. Ожидаем соединение…"));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [sessionId, state]);

  const terminal = session.state === "expired" || session.state === "cancelled" || session.state === "consumed" || session.state === "uploaded";
  return (
    <DialogFrame
      testId="coffee-diary-photo-upload-dialog"
      className="coffee-diary-photo-upload-dialog"
      eyebrow="Фото кофе"
      title="Отсканируйте QR-код"
      description="Откройте ссылку на iPhone и выберите фотографию."
      onClose={onClose}
      footer={<div className="coffee-diary-sheet-actions"><button type="button" className="coffee-diary-secondary-button" onClick={onClose}>{terminal ? "Закрыть" : "Отмена"}</button></div>}
    >
      <div className="coffee-diary-qr-body">
        {qrDataUrl ? <img className="coffee-diary-qr" src={qrDataUrl} alt="QR-код для загрузки фото" data-testid="coffee-diary-qr" /> : <div className="coffee-diary-qr-placeholder">Готовим QR-код…</div>}
        <p className="coffee-diary-qr-expiry" data-testid="coffee-diary-upload-expiry">{uploadSessionTimeCopy(session.remainingSeconds)}</p>
        {session.state === "created" && <p className="coffee-diary-qr-state">Ожидаем фотографию с iPhone.</p>}
        {session.state === "uploading" && <p className="coffee-diary-qr-state">Фото загружается…</p>}
        {session.state === "uploaded" && <p className="coffee-diary-qr-state" role="status">Фото получено. Сохраняем его в дневник…</p>}
        {session.state === "consumed" && <p className="coffee-diary-qr-state" role="status">Фото прикреплено к кофе.</p>}
        {session.state === "expired" && <p className="coffee-diary-form__error" role="alert">Срок действия QR-ссылки истёк.</p>}
        {session.state === "cancelled" && <p className="coffee-diary-form__error" role="alert">QR-ссылка отменена.</p>}
        {pollError && <p className="coffee-diary-muted">{pollError}</p>}
      </div>
    </DialogFrame>
  );
}

function NumericField({ label, value, testId, active, onOpen }: { label: string; value: string; testId: string; active: boolean; onOpen: () => void }) {
  return (
    <div className="coffee-diary-form__field">
      <span>{label}</span>
      <button type="button" className={`coffee-diary-numeric-trigger${active ? " is-active" : ""}`} data-testid={`${testId}-trigger`} aria-pressed={active} onClick={onOpen}>{value || "Введите число"}</button>
    </div>
  );
}

function CoffeeMetrics({ extraction }: { extraction: Pick<CoffeeDiaryExtraction, "doseGrams" | "extractionSeconds" | "yieldGrams"> }) {
  return <dl className="coffee-diary-metrics" data-testid="coffee-diary-metrics">
    <div><dt>Вход</dt><dd>{extraction.doseGrams.toFixed(1)} г</dd></div>
    <div><dt>Время</dt><dd>{extraction.extractionSeconds} с</dd></div>
    <div><dt>Выход</dt><dd>{extraction.yieldGrams.toFixed(1)} г</dd></div>
  </dl>;
}

function PhotoViewerDialog({ beanName, photoId, onClose }: { beanName: string; photoId: string; onClose: () => void }) {
  return <DialogFrame testId="coffee-diary-photo-viewer" className="coffee-diary-photo-viewer" eyebrow={beanName} title="Фото упаковки" description="Увеличенный снимок для чтения информации на упаковке." onClose={onClose}>
    <img src={coffeeDiaryPhotoContentUrl(photoId)} alt={`Упаковка кофе ${beanName}`} />
  </DialogFrame>;
}

type NumericEditor = "dose" | "seconds" | "yield";

function BeanSheet({ bean, onClose, onSaved, onConflict }: { bean?: CoffeeDiaryBean; onClose: () => void; onSaved: (bean: CoffeeDiaryBean) => void; onConflict: () => Promise<void> }) {
  const { guardMutation } = useInteractionLock();
  const createAttemptRef = useRef<CoffeeDiaryCreateAttempt | null>(null);
  const [draft, setDraft] = useState(() => beanToDraft(bean));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingPhotoIds, setPendingPhotoIds] = useState<string[]>([]);
  const [photoSession, setPhotoSession] = useState<CoffeeDiaryUploadSession | null>(null);
  const [photoSessionBusy, setPhotoSessionBusy] = useState(false);
  const photoSessionBusyRef = useRef(false);

  async function openStagedPhotoUpload() {
    if (!guardMutation() || photoSessionBusyRef.current) return;
    photoSessionBusyRef.current = true;
    setPhotoSessionBusy(true);
    setError(null);
    try {
      setPhotoSession(await createCoffeeDiaryBeanPhotoUploadSession());
    } catch (reason) {
      setError(uploadSessionErrorCopy(reason));
    } finally {
      photoSessionBusyRef.current = false;
      setPhotoSessionBusy(false);
    }
  }

  async function closeSheet() {
    if (photoSession?.state === "created") {
      try { await cancelCoffeeDiaryPhotoUploadSession(photoSession.sessionId); } catch { /* cleanup is best effort */ }
    }
    await Promise.all(pendingPhotoIds.map((pendingId) => discardCoffeeDiaryPendingPhoto(pendingId).catch(() => undefined)));
    setPhotoSession(null);
    onClose();
  }

  async function closePhotoDialog() {
    if (photoSession?.state === "created") {
      try { await cancelCoffeeDiaryPhotoUploadSession(photoSession.sessionId); } catch { /* cleanup is best effort */ }
    }
    setPhotoSession(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!guardMutation()) return;
    if (!draft.name.trim()) { setError("Заполните название кофе."); return; }
    const payload = {
      name: draft.name,
      grindDescription: draft.grindDescription || null,
      preferredDrink: draft.preferredDrink || null,
      notes: draft.notes || null,
      roaster: draft.roaster || null,
      roastDate: draft.roastDate || null,
      roastLevel: draft.roastLevel || null,
      roastNotes: draft.roastNotes || null,
      origin: draft.origin || null,
      processing: draft.processing || null,
      ...(pendingPhotoIds.length ? { pendingPhotoAttachmentIds: pendingPhotoIds } : {})
    };
    const createAttempt = bean ? null : (createAttemptRef.current ??= createCoffeeDiaryCreateAttempt()).begin(payload);
    if (!bean && !createAttempt) return;
    setError(null);
    setSaving(true);
    try {
      const saved = bean
        ? await patchCoffeeDiaryBean(bean.id, bean.version, payload)
        : await createCoffeeDiaryBean(payload, createAttempt!.key);
      if (!bean) createAttemptRef.current?.complete();
      setPendingPhotoIds([]);
      setPhotoSession(null);
      setSaving(false);
      onSaved(saved);
      onClose();
    } catch (reason) {
      if (!bean) createAttemptRef.current?.release();
      setSaving(false);
      if (isRevisionConflict(reason)) { await onConflict(); return; }
      setError(coffeeDiaryApiMessage(reason));
    }
  }

  return (
    <Sheet testId="coffee-diary-bean-sheet" eyebrow="Кофе" title={bean ? "Изменить кофе" : "Добавить кофе"} description="Сохраните зерно, помол и лучший способ его раскрыть." onClose={() => void closeSheet()} footer={<div className="coffee-diary-sheet-actions"><button type="button" className="coffee-diary-secondary-button" onClick={() => void closeSheet()}>Отмена</button><button type="submit" form="coffee-diary-bean-form" className="coffee-diary-primary-button" disabled={saving}>{saving ? "Сохраняем…" : "Сохранить"}</button></div>}>
      <form id="coffee-diary-bean-form" className="coffee-diary-form" onSubmit={(event) => void submit(event)}>
        <div className="coffee-diary-form__grid coffee-diary-bean-core">
          <label className="coffee-diary-form__field"><span>Название</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} data-testid="coffee-diary-input-name" /></label>
          <label className="coffee-diary-form__field"><span>Помол / описание помола</span><input value={draft.grindDescription} onChange={(event) => setDraft({ ...draft, grindDescription: event.target.value })} data-testid="coffee-diary-input-grind" placeholder="Например, чуть мельче среднего" /></label>
          <label className="coffee-diary-form__field"><span>Лучше подходит для</span><select value={draft.preferredDrink} onChange={(event) => setDraft({ ...draft, preferredDrink: event.target.value as BeanDraft["preferredDrink"] })} data-testid="coffee-diary-input-preferred-drink">{preferredDrinkOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="coffee-diary-form__field coffee-diary-form__field--wide"><span>Общий комментарий</span><textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} rows={3} data-testid="coffee-diary-input-notes" placeholder="Например, шоколад и ягоды" /></label>
        </div>
        {!bean && <section className="coffee-diary-photo-staging" aria-label="Фото упаковки">
          <div className="coffee-diary-photo-staging__header"><div><strong>Фото упаковки</strong><p>Сначала добавьте лицевую сторону, затем оборотную. Их можно заменить после сохранения.</p></div><button type="button" className="coffee-diary-secondary-button" onClick={() => void openStagedPhotoUpload()} disabled={photoSessionBusy || photoSession !== null}>{photoSessionBusy ? "Готовим…" : `Добавить: ${pendingPhotoIds.length === 0 ? "лицевая сторона" : pendingPhotoIds.length === 1 ? "оборотная сторона" : "ещё фото"}`}</button></div>
          {pendingPhotoIds.length > 0 && <div className="coffee-diary-staged-previews" data-testid="coffee-diary-staged-previews">{pendingPhotoIds.map((pendingId, index) => <figure key={pendingId}><img src={coffeeDiaryPendingPhotoContentUrl(pendingId)} alt={`Предпросмотр: ${index === 0 ? "лицевая сторона" : index === 1 ? "оборотная сторона" : "дополнительное фото"}`} /><figcaption>{index === 0 ? "Лицевая сторона" : index === 1 ? "Оборотная сторона" : "Дополнительное фото"}</figcaption></figure>)}</div>}
        </section>}
        <details className="coffee-diary-secondary-fields">
          <summary>Дополнительные сведения</summary>
          <div className="coffee-diary-form__grid">
            <label className="coffee-diary-form__field"><span>Обжарщик</span><input value={draft.roaster} onChange={(event) => setDraft({ ...draft, roaster: event.target.value })} /></label>
            <label className="coffee-diary-form__field"><span>Дата обжарки</span><input type="date" value={draft.roastDate} onChange={(event) => setDraft({ ...draft, roastDate: event.target.value })} /></label>
            <label className="coffee-diary-form__field"><span>Уровень обжарки</span><input value={draft.roastLevel} onChange={(event) => setDraft({ ...draft, roastLevel: event.target.value })} /></label>
            <label className="coffee-diary-form__field"><span>Происхождение</span><input value={draft.origin} onChange={(event) => setDraft({ ...draft, origin: event.target.value })} /></label>
            <label className="coffee-diary-form__field"><span>Обработка</span><input value={draft.processing} onChange={(event) => setDraft({ ...draft, processing: event.target.value })} /></label>
            <label className="coffee-diary-form__field coffee-diary-form__field--wide"><span>Заметки об обжарке</span><textarea value={draft.roastNotes} onChange={(event) => setDraft({ ...draft, roastNotes: event.target.value })} rows={2} /></label>
          </div>
        </details>
        {error && <p className="coffee-diary-form__error" role="alert">{error}</p>}
      </form>
      {photoSession && <PhotoUploadDialog session={photoSession} onClose={() => void closePhotoDialog()} onSessionUpdate={(next) => setPhotoSession((current) => current ? { ...next, uploadUrl: next.uploadUrl ?? current.uploadUrl } : next)} onUploaded={(next) => { if (next.pendingAttachmentId) setPendingPhotoIds((current) => current.includes(next.pendingAttachmentId!) ? current : [...current, next.pendingAttachmentId!]); setPhotoSession(null); }} />}
    </Sheet>
  );
}

function ExtractionSheet({ bean, onClose, onSaved }: { bean: CoffeeDiaryBean; onClose: () => void; onSaved: (extraction: CoffeeDiaryExtraction) => void }) {
  const { guardMutation } = useInteractionLock();
  const createAttemptRef = useRef<CoffeeDiaryCreateAttempt | null>(null);
  const [dose, setDose] = useState("");
  const [seconds, setSeconds] = useState("");
  const [yieldAmount, setYieldAmount] = useState("");
  const [brewedAt, setBrewedAt] = useState(localDateTimeValue);
  const [rating, setRating] = useState("");
  const [notes, setNotes] = useState("");
  const [makeFavorite, setMakeFavorite] = useState(false);
  const [activeNumericEditor, setActiveNumericEditor] = useState<NumericEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!guardMutation()) return;
    const brewedAtUtc = toUtcTimestamp(brewedAt);
    const doseGrams = gramsValue(dose);
    const extractionSeconds = secondsValue(seconds);
    const yieldGrams = gramsValue(yieldAmount);
    const parsedRating = rating ? ratingValue(rating) : null;
    if (!brewedAtUtc || doseGrams === null || extractionSeconds === null || yieldGrams === null || (rating && (parsedRating === null || parsedRating < 1 || parsedRating > 10))) {
      setError("Проверьте дату, положительные значения дозы, времени и выхода, а также оценку от 1 до 10.");
      return;
    }
    const payload = { brewedAt: brewedAtUtc, doseGrams, extractionSeconds, yieldGrams, notes: notes || null, rating: parsedRating, makeFavorite };
    const createAttempt = (createAttemptRef.current ??= createCoffeeDiaryCreateAttempt()).begin(payload, bean.id);
    if (!createAttempt) return;
    setError(null);
    setSaving(true);
    try {
      const saved = await createCoffeeDiaryExtraction(bean.id, payload, createAttempt.key);
      createAttemptRef.current?.complete();
      setSaving(false);
      onSaved(saved);
      onClose();
    } catch (reason) {
      createAttemptRef.current?.release();
      setSaving(false);
      setError(coffeeDiaryApiMessage(reason));
    }
  }

  return (
    <Sheet testId="coffee-diary-extraction-sheet" eyebrow={bean.name} title="Добавить приготовление" description="Запишите фактический шот и при желании сохраните его лучшим рецептом." onClose={onClose} footer={<div className="coffee-diary-sheet-actions"><button type="button" className="coffee-diary-secondary-button" onClick={onClose}>Отмена</button><button type="submit" form="coffee-diary-extraction-form" className="coffee-diary-primary-button" disabled={saving}>{saving ? "Сохраняем…" : "Сохранить"}</button></div>}>
      <form id="coffee-diary-extraction-form" className="coffee-diary-form" onSubmit={(event) => void submit(event)}>
        <label className="coffee-diary-form__field"><span>Когда приготовлено</span><input type="datetime-local" value={brewedAt} onChange={(event) => setBrewedAt(event.target.value)} /></label>
        <div className="coffee-diary-form__grid">
          <NumericField label="Доза, г" value={dose} testId="coffee-diary-dose" active={activeNumericEditor === "dose"} onOpen={() => setActiveNumericEditor("dose")} />
          <NumericField label="Время пролива, с" value={seconds} testId="coffee-diary-seconds" active={activeNumericEditor === "seconds"} onOpen={() => setActiveNumericEditor("seconds")} />
          <NumericField label="Выход напитка, г" value={yieldAmount} testId="coffee-diary-yield" active={activeNumericEditor === "yield"} onOpen={() => setActiveNumericEditor("yield")} />
          <fieldset className="coffee-diary-rating-picker" data-testid="coffee-diary-rating-picker"><legend>Оценка <span>необязательно</span></legend><div>{Array.from({ length: 10 }, (_, index) => String(index + 1)).map((option) => <button key={option} type="button" className={rating === option ? "is-selected" : ""} aria-pressed={rating === option} onClick={() => setRating(option)}>{option}</button>)}<button type="button" className={`coffee-diary-rating-clear${!rating ? " is-selected" : ""}`} aria-pressed={!rating} onClick={() => setRating("")}>Без оценки</button></div></fieldset>
        </div>
        <label className="coffee-diary-form__field"><span>Комментарий</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} data-testid="coffee-diary-input-extraction-notes" placeholder="Что получилось?" /></label>
        <label className="coffee-diary-checkbox"><input type="checkbox" checked={makeFavorite} onChange={(event) => setMakeFavorite(event.target.checked)} data-testid="coffee-diary-make-favorite" /> Сделать лучшим рецептом</label>
        {error && <p className="coffee-diary-form__error" role="alert">{error}</p>}
      </form>
      {activeNumericEditor && <DialogFrame testId={`coffee-diary-${activeNumericEditor}-keypad`} className="coffee-diary-numeric-dialog" eyebrow="Приготовление" title={activeNumericEditor === "dose" ? "Доза, г" : activeNumericEditor === "seconds" ? "Время пролива, с" : "Выход напитка, г"} description="Введите значение и нажмите «Готово». Очистка не блокирует закрытие." onClose={() => setActiveNumericEditor(null)}>
        <NumericKeypad value={activeNumericEditor === "dose" ? dose : activeNumericEditor === "seconds" ? seconds : yieldAmount} onChange={activeNumericEditor === "dose" ? setDose : activeNumericEditor === "seconds" ? setSeconds : setYieldAmount} onDone={() => setActiveNumericEditor(null)} decimal={activeNumericEditor !== "seconds"} maxLength={activeNumericEditor === "seconds" ? 4 : 8} maxDecimalPlaces={activeNumericEditor === "seconds" ? 0 : 1} label="Числовой ввод" testId={`coffee-diary-${activeNumericEditor}-keypad-buttons`} />
      </DialogFrame>}
    </Sheet>
  );
}

export function CoffeeDiaryPage() {
  const { copy } = useInterfaceCopy();
  const { confirmAction } = useActionConfirmation();
  const { guardMutation } = useInteractionLock();
  const [collection, setCollection] = useState<CoffeeDiaryCollection | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<{ bean: CoffeeDiaryBean; extractions: CoffeeDiaryExtraction[] } | null>(null);
  const [sheet, setSheet] = useState<"add-bean" | "edit-bean" | "add-extraction" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [favoriteSavingId, setFavoriteSavingId] = useState<string | null>(null);
  const [photoSession, setPhotoSession] = useState<CoffeeDiaryUploadSession | null>(null);
  const [photoSessionBusy, setPhotoSessionBusy] = useState(false);
  const photoSessionBusyRef = useRef(false);

  const selectedBean = useMemo(() => collection?.beans.find((bean) => bean.id === selectedId) ?? null, [collection, selectedId]);
  const favorite = selectedBean && selectedDetail ? bestCoffeeDiaryExtraction(selectedBean, selectedDetail.extractions) : null;
  const selectedPhotos = useMemo(() => selectedBean
    ? selectedBean.photoIds.map((photoId) => collection?.photos.find((photo) => photo.id === photoId && photo.deletedAt === null)).filter((photo): photo is NonNullable<typeof photo> => Boolean(photo))
    : [], [collection?.photos, selectedBean]);
  const [viewedPhotoId, setViewedPhotoId] = useState<string | null>(null);

  async function reload(): Promise<boolean> {
    setLoading(true);
    try {
      const next = await getCoffeeDiary();
      setCollection(next);
      setSelectedId((current) => current && next.beans.some((bean) => bean.id === current) ? current : next.beans[0]?.id ?? null);
      setError(null);
      return true;
    } catch (reason) { setError(coffeeDiaryApiMessage(reason)); }
    finally { setLoading(false); }
    return false;
  }

  async function reconcileConflict() {
    setSheet(null);
    if (await reload()) setError("Данные изменились. Показана актуальная версия.");
  }

  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    if (!selectedId) { setSelectedDetail(null); return; }
    void getCoffeeDiaryBean(selectedId).then(setSelectedDetail).catch((reason) => setError(coffeeDiaryApiMessage(reason)));
  }, [selectedId, collection?.revision]);

  async function deleteBean() {
    if (!selectedBean || !guardMutation()) return;
    const confirmation = await confirmAction("coffee-diary.bean.delete", { target: selectedBean.name });
    if (!confirmation.confirmed || !guardMutation()) return;
    try { await deleteCoffeeDiaryBean(selectedBean.id, selectedBean.version); await reload(); }
    catch (reason) {
      if (isRevisionConflict(reason)) { await reconcileConflict(); return; }
      setError(coffeeDiaryApiMessage(reason));
    }
  }

  async function deleteExtraction(extraction: CoffeeDiaryExtraction) {
    if (!guardMutation()) return;
    const confirmation = await confirmAction("coffee-diary.extraction.delete", { target: coffeeDiaryShotSummary(extraction) });
    if (!confirmation.confirmed || !guardMutation()) return;
    try { await deleteCoffeeDiaryExtraction(extraction.id, extraction.version); await reload(); }
    catch (reason) {
      if (isRevisionConflict(reason)) { await reconcileConflict(); return; }
      setError(coffeeDiaryApiMessage(reason));
    }
  }

  async function chooseFavorite(extractionId: string | null) {
    if (!selectedBean || !guardMutation()) return;
    setFavoriteSavingId(extractionId ?? "clear");
    try {
      await patchCoffeeDiaryFavorite(selectedBean.id, selectedBean.version, extractionId);
      await reload();
    } catch (reason) {
      if (isRevisionConflict(reason)) { await reconcileConflict(); return; }
      setError(coffeeDiaryApiMessage(reason));
    } finally { setFavoriteSavingId(null); }
  }

  async function openExistingPhotoUpload(replacePhotoId?: string) {
    if (!selectedBean || !guardMutation() || photoSessionBusyRef.current) return;
    photoSessionBusyRef.current = true;
    setPhotoSessionBusy(true);
    setError(null);
    try {
      setPhotoSession(await createCoffeeDiaryPhotoUploadSession(selectedBean.id, replacePhotoId));
    } catch (reason) {
      setError(uploadSessionErrorCopy(reason));
    } finally {
      photoSessionBusyRef.current = false;
      setPhotoSessionBusy(false);
    }
  }

  async function closeExistingPhotoUpload() {
    if (photoSession?.state === "created") {
      try { await cancelCoffeeDiaryPhotoUploadSession(photoSession.sessionId); } catch { /* cleanup is best effort */ }
    }
    setPhotoSession(null);
  }

  async function exportDiary() {
    try {
      const exported = await getCoffeeDiaryExport();
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "coffee-diary.json";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (reason) { setError(coffeeDiaryApiMessage(reason)); }
  }

  return (
    <div className="coffee-diary-page" data-testid="route-coffee-diary">
      <div className="coffee-diary-page__header">
        <RouteHeader eyebrow="Личная коллекция" title={copy("page.coffeeDiary.title")} description={copy("page.coffeeDiary.subtitle")} />
        <div className="coffee-diary-page__actions"><button type="button" className="coffee-diary-secondary-button" onClick={() => void exportDiary()} data-testid="coffee-diary-export">Экспорт JSON</button><button type="button" className="coffee-diary-secondary-button" onClick={downloadCoffeeDiaryCsv} data-testid="coffee-diary-export-csv">Экспорт CSV</button><button type="button" className="coffee-diary-secondary-button" onClick={downloadCoffeeDiaryZip} data-testid="coffee-diary-export-zip">Экспорт ZIP</button><button type="button" className="coffee-diary-primary-button" onClick={() => setSheet("add-bean")} data-testid="coffee-diary-add-bean">Добавить кофе</button></div>
      </div>
      {error && <p className="coffee-diary-notice" role="alert">{error}</p>}
      {loading && <p className="coffee-diary-state">Загружаем дневник…</p>}
      {!loading && collection && collection.beans.length === 0 && <section className="coffee-diary-empty" data-testid="coffee-diary-empty"><div className="coffee-diary-empty__cup">☕</div><h2>Кофе пока не добавлен</h2><p>Добавьте зерно, чтобы сохранить помол и первый лучший рецепт.</p><button type="button" className="coffee-diary-primary-button" onClick={() => setSheet("add-bean")}>Добавить кофе</button></section>}
      {!loading && collection && collection.beans.length > 0 && <div className="coffee-diary-layout">
        <section className="coffee-diary-bean-list" aria-label="Зёрна">
          <div className="coffee-diary-section-heading"><div><p className="section-kicker">Коллекция</p><h2>Зёрна</h2></div><span>{collection.beanCount}</span></div>
          <div className="coffee-diary-bean-list__items">{collection.beans.map((bean) => <button key={bean.id} type="button" className={`coffee-diary-bean-card${bean.id === selectedId ? " is-selected" : ""}`} onClick={() => setSelectedId(bean.id)}><strong>{bean.name}</strong><span>{[preferredDrinkLabel(bean.preferredDrink), bean.grindDescription].filter((value) => value && value !== "Не указано").join(" · ") || "Описание не заполнено"}</span></button>)}</div>
        </section>
        {selectedBean && <section className="coffee-diary-detail" data-testid="coffee-diary-detail"><div className="coffee-diary-detail__header"><div><p className="section-kicker">Зерно</p><h2>{selectedBean.name}</h2><p>{preferredDrinkLabel(selectedBean.preferredDrink)}{selectedBean.grindDescription ? ` · ${selectedBean.grindDescription}` : ""}</p></div><div className="coffee-diary-detail__actions"><button type="button" className="coffee-diary-secondary-button" onClick={() => setSheet("edit-bean")}>Изменить</button><button type="button" className="coffee-diary-danger-button" onClick={() => void deleteBean()}>Удалить</button></div></div>
          <div className="coffee-diary-detail__summary"><dl className="coffee-diary-metadata"><div><dt>Помол</dt><dd>{selectedBean.grindDescription || "—"}</dd></div><div><dt>Обжарщик</dt><dd>{selectedBean.roaster || "—"}</dd></div><div><dt>Происхождение</dt><dd>{selectedBean.origin || "—"}</dd></div></dl>{selectedBean.notes && <p className="coffee-diary-long-text">{selectedBean.notes}</p>}</div>
          <section className="coffee-diary-package-photos" aria-label="Фото упаковки" data-testid="coffee-diary-photos"><div className="coffee-diary-section-heading"><div><p className="section-kicker">Упаковка</p><h3>Фото для заказа</h3></div></div><div className="coffee-diary-package-photos__slots">{["Лицевая сторона", "Оборотная сторона"].map((label, index) => { const photo = selectedPhotos[index]; const frontMissing = index === 1 && selectedPhotos[0] === undefined; return <div className="coffee-diary-package-photo" key={label} data-testid={`coffee-diary-package-slot-${index}`}>{photo ? <><button type="button" className="coffee-diary-package-photo__image" onClick={() => setViewedPhotoId(photo.id)} aria-label={`${label}: открыть увеличенное фото`}><img src={coffeeDiaryPhotoContentUrl(photo.id)} alt={`${label} упаковки ${selectedBean.name}`} /></button><button type="button" className="coffee-diary-package-photo__replace" disabled={photoSessionBusy} onClick={() => void openExistingPhotoUpload(photo.id)}>{photoSessionBusy ? "Готовим QR…" : "Заменить"}</button></> : frontMissing ? <button type="button" className="coffee-diary-package-photo__empty" disabled aria-describedby="coffee-diary-back-needs-front">Сначала добавьте лицевую сторону</button> : <button type="button" className="coffee-diary-package-photo__empty" disabled={photoSessionBusy} onClick={() => void openExistingPhotoUpload()}>{photoSessionBusy ? "Готовим QR…" : "Добавить фото"}</button>}<strong>{label}</strong>{frontMissing && <span id="coffee-diary-back-needs-front" className="coffee-diary-package-photo__hint">Оборотная сторона станет доступна после лицевой.</span>}</div>; })}</div>{selectedPhotos.slice(2).length > 0 && <details className="coffee-diary-extra-photos"><summary>Другие фото упаковки</summary><div>{selectedPhotos.slice(2).map((photo) => <button type="button" key={photo.id} onClick={() => setViewedPhotoId(photo.id)}><img src={coffeeDiaryPhotoContentUrl(photo.id)} alt={`Дополнительное фото упаковки ${selectedBean.name}`} /></button>)}</div></details>}</section>
          {favorite && <section className="coffee-diary-best" data-testid="coffee-diary-best-recipe"><div className="coffee-diary-section-heading"><div><p className="section-kicker">Лучший рецепт</p><h3>{coffeeDiaryShotSummary(favorite)}</h3></div><span className="coffee-diary-status-badge">Лучший</span></div><CoffeeMetrics extraction={favorite} /></section>}
          <section className="coffee-diary-history" data-testid="coffee-diary-history"><div className="coffee-diary-section-heading"><div><p className="section-kicker">История</p><h3>Приготовления</h3></div><button type="button" className="coffee-diary-primary-button" data-testid="coffee-diary-add-extraction" onClick={() => setSheet("add-extraction")}>Добавить</button></div>{selectedDetail?.extractions.length ? <div className="coffee-diary-history__items">{selectedDetail.extractions.map((extraction) => { const isFavorite = selectedBean.favoriteExtractionId === extraction.id; return <article className={`coffee-diary-extraction${isFavorite ? " is-favorite" : ""}`} data-testid="coffee-diary-extraction" key={extraction.id}><div className="coffee-diary-extraction__header"><div><time dateTime={extraction.brewedAt}>{new Date(extraction.brewedAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}</time><CoffeeMetrics extraction={extraction} /></div><div className="coffee-diary-extraction__tools">{isFavorite && <span className="coffee-diary-status-badge" data-testid="coffee-diary-favorite-marker">Лучший</span>}{extraction.rating !== null && <span className="coffee-diary-rating">Оценка {extraction.rating}/10</span>}<button type="button" className="coffee-diary-secondary-action" disabled={favoriteSavingId !== null} onClick={() => void chooseFavorite(isFavorite ? null : extraction.id)}>{isFavorite ? "Снять лучший" : "Сделать лучшим"}</button><button type="button" className="coffee-diary-delete-action" onClick={() => void deleteExtraction(extraction)}>Удалить</button></div></div>{extraction.notes && <p>{extraction.notes}</p>}</article>; })}</div> : <p className="coffee-diary-muted">Приготовлений пока нет.</p>}</section>
        </section>}
      </div>}
      {sheet === "add-bean" && <BeanSheet onClose={() => setSheet(null)} onSaved={(bean) => { setSheet(null); setSelectedId(bean.id); void reload(); }} onConflict={reconcileConflict} />}
      {sheet === "edit-bean" && selectedBean && <BeanSheet bean={selectedBean} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); void reload(); }} onConflict={reconcileConflict} />}
      {sheet === "add-extraction" && selectedBean && <ExtractionSheet bean={selectedBean} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); void reload(); }} />}
      {photoSession && <PhotoUploadDialog session={photoSession} onClose={() => void closeExistingPhotoUpload()} onSessionUpdate={(next) => setPhotoSession((current) => current ? { ...next, uploadUrl: next.uploadUrl ?? current.uploadUrl } : next)} onUploaded={(next) => { setPhotoSession(next); void reload(); }} />}
      {viewedPhotoId && selectedBean && <PhotoViewerDialog beanName={selectedBean.name} photoId={viewedPhotoId} onClose={() => setViewedPhotoId(null)} />}
    </div>
  );
}
