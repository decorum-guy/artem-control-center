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

function NumericField({ label, value, onChange, decimal, testId }: { label: string; value: string; onChange: (value: string) => void; decimal: boolean; testId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="coffee-diary-form__field">
      <span>{label}</span>
      <button type="button" className="coffee-diary-numeric-trigger" data-testid={`${testId}-trigger`} onClick={() => setOpen(true)}>{value || "Введите число"}</button>
      {open && <NumericKeypad value={value} onChange={onChange} onDone={() => setOpen(false)} decimal={decimal} maxLength={decimal ? 8 : 4} maxDecimalPlaces={decimal ? 1 : 0} label={label} testId={`${testId}-keypad`} />}
    </div>
  );
}

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
        {!bean && <section className="coffee-diary-photo-staging" aria-label="Фотография кофе">
          <div className="coffee-diary-photo-staging__header"><div><strong>Фотография</strong><p>Можно прикрепить фото до сохранения кофе.</p></div><button type="button" className="coffee-diary-secondary-button" onClick={() => void openStagedPhotoUpload()} disabled={photoSessionBusy || photoSession !== null}>{photoSessionBusy ? "Готовим…" : "Прикрепить фото"}</button></div>
          {pendingPhotoIds.length > 0 && <div className="coffee-diary-staged-previews" data-testid="coffee-diary-staged-previews">{pendingPhotoIds.map((pendingId) => <img key={pendingId} src={coffeeDiaryPendingPhotoContentUrl(pendingId)} alt="Предпросмотр фотографии кофе" />)}</div>}
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
          <NumericField label="Доза, г" value={dose} onChange={setDose} decimal testId="coffee-diary-dose" />
          <NumericField label="Время пролива, с" value={seconds} onChange={setSeconds} decimal={false} testId="coffee-diary-seconds" />
          <NumericField label="Выход напитка, г" value={yieldAmount} onChange={setYieldAmount} decimal testId="coffee-diary-yield" />
          <NumericField label="Оценка (1–10, необязательно)" value={rating} onChange={setRating} decimal={false} testId="coffee-diary-rating" />
        </div>
        <label className="coffee-diary-form__field"><span>Комментарий</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} data-testid="coffee-diary-input-extraction-notes" placeholder="Что получилось?" /></label>
        <label className="coffee-diary-checkbox"><input type="checkbox" checked={makeFavorite} onChange={(event) => setMakeFavorite(event.target.checked)} data-testid="coffee-diary-make-favorite" /> Сделать лучшим рецептом</label>
        {error && <p className="coffee-diary-form__error" role="alert">{error}</p>}
      </form>
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

  async function openExistingPhotoUpload() {
    if (!selectedBean || !guardMutation() || photoSessionBusyRef.current) return;
    photoSessionBusyRef.current = true;
    setPhotoSessionBusy(true);
    setError(null);
    try {
      setPhotoSession(await createCoffeeDiaryPhotoUploadSession(selectedBean.id));
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
        {selectedBean && <section className="coffee-diary-detail" data-testid="coffee-diary-detail"><div className="coffee-diary-detail__header"><div><p className="section-kicker">Зерно</p><h2>{selectedBean.name}</h2><p>{preferredDrinkLabel(selectedBean.preferredDrink)}{selectedBean.grindDescription ? ` · ${selectedBean.grindDescription}` : ""}</p></div><div className="coffee-diary-detail__actions"><button type="button" className="coffee-diary-secondary-button" onClick={() => void openExistingPhotoUpload()} disabled={photoSessionBusy}>{photoSessionBusy ? "Готовим QR…" : "Прикрепить фото"}</button><button type="button" className="coffee-diary-secondary-button" onClick={() => setSheet("edit-bean")}>Изменить</button><button type="button" className="coffee-diary-danger-button" onClick={() => void deleteBean()}>Удалить</button></div></div>
          <dl className="coffee-diary-metadata"><div><dt>Помол</dt><dd>{selectedBean.grindDescription || "—"}</dd></div><div><dt>Лучше подходит для</dt><dd>{preferredDrinkLabel(selectedBean.preferredDrink)}</dd></div><div><dt>Фотографии</dt><dd>{selectedBean.photoIds.length}</dd></div><div><dt>Обжарщик</dt><dd>{selectedBean.roaster || "—"}</dd></div><div><dt>Происхождение</dt><dd>{selectedBean.origin || "—"}</dd></div><div><dt>Обработка</dt><dd>{selectedBean.processing || "—"}</dd></div></dl>
          {selectedBean.notes && <p className="coffee-diary-long-text">{selectedBean.notes}</p>}
          <section className="coffee-diary-photos" aria-label="Фотографии кофе" data-testid="coffee-diary-photos"><div className="coffee-diary-section-heading"><div><p className="section-kicker">Архив</p><h3>Фотографии</h3></div><span>{selectedBean.photoIds.length}</span></div>{collection?.photos.filter((photo) => photo.beanId === selectedBean.id && photo.deletedAt === null).length ? <div className="coffee-diary-photo-grid">{collection?.photos.filter((photo) => photo.beanId === selectedBean.id && photo.deletedAt === null).map((photo) => <img key={photo.id} src={coffeeDiaryPhotoContentUrl(photo.id)} alt={`Фото кофе ${selectedBean.name}`} />)}</div> : <p className="coffee-diary-muted">Фотографий пока нет.</p>}</section>
          <section className="coffee-diary-best" data-testid="coffee-diary-best-recipe"><div className="coffee-diary-section-heading"><div><p className="section-kicker">Избранное</p><h3>Лучший рецепт</h3></div>{favorite && <span>Лучший</span>}</div>{favorite ? <strong>{coffeeDiaryShotSummary(favorite)}</strong> : <p>Лучший рецепт не выбран</p>}</section>
          <section className="coffee-diary-history" data-testid="coffee-diary-history"><div className="coffee-diary-section-heading"><div><p className="section-kicker">История</p><h3>Приготовления</h3></div><button type="button" className="coffee-diary-primary-button" onClick={() => setSheet("add-extraction")}>Добавить</button></div>{selectedDetail?.extractions.length ? <div className="coffee-diary-history__items">{selectedDetail.extractions.map((extraction) => { const isFavorite = selectedBean.favoriteExtractionId === extraction.id; return <article className={`coffee-diary-extraction${isFavorite ? " is-favorite" : ""}`} data-testid="coffee-diary-extraction" key={extraction.id}><div className="coffee-diary-extraction__header"><div><strong>{coffeeDiaryShotSummary(extraction)}</strong><time dateTime={extraction.brewedAt}>{new Date(extraction.brewedAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}</time></div><div className="coffee-diary-extraction__tools">{isFavorite && <span className="coffee-diary-rating" data-testid="coffee-diary-favorite-marker">Лучший</span>}{extraction.rating !== null && <span className="coffee-diary-rating">Оценка {extraction.rating}/10</span>}<button type="button" className="coffee-diary-link-button" disabled={favoriteSavingId !== null} onClick={() => void chooseFavorite(isFavorite ? null : extraction.id)}>{isFavorite ? "Снять лучший" : "Сделать лучшим"}</button><button type="button" className="coffee-diary-link-button" onClick={() => void deleteExtraction(extraction)}>Удалить</button></div></div>{extraction.notes && <p>{extraction.notes}</p>}</article>; })}</div> : <p className="coffee-diary-muted">Приготовлений пока нет.</p>}</section>
        </section>}
      </div>}
      {sheet === "add-bean" && <BeanSheet onClose={() => setSheet(null)} onSaved={(bean) => { setSheet(null); setSelectedId(bean.id); void reload(); }} onConflict={reconcileConflict} />}
      {sheet === "edit-bean" && selectedBean && <BeanSheet bean={selectedBean} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); void reload(); }} onConflict={reconcileConflict} />}
      {sheet === "add-extraction" && selectedBean && <ExtractionSheet bean={selectedBean} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); void reload(); }} />}
      {photoSession && <PhotoUploadDialog session={photoSession} onClose={() => void closeExistingPhotoUpload()} onSessionUpdate={(next) => setPhotoSession((current) => current ? { ...next, uploadUrl: next.uploadUrl ?? current.uploadUrl } : next)} onUploaded={(next) => { setPhotoSession(next); void reload(); }} />}
    </div>
  );
}
