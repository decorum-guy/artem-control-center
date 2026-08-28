import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  CoffeeDiaryBean,
  CoffeeDiaryCollection,
  CoffeeDiaryExtraction,
  CoffeeDiaryRecipe
} from "@artem/contracts";
import { Sheet } from "./Sheet";
import { RouteHeader } from "./ShellPrimitives";
import { useInterfaceCopy } from "./interfaceCopy";
import { useActionConfirmation } from "./ActionConfirmations";
import { useInteractionLock } from "./InteractionLock";
import { NumericKeypad } from "./NumericKeypad";
import { normalizeNumericInput, numericInputValue } from "./coffeeDiaryNumeric";
import {
  createCoffeeDiaryBean,
  createCoffeeDiaryExtraction,
  deleteCoffeeDiaryBean,
  deleteCoffeeDiaryExtraction,
  getCoffeeDiary,
  getCoffeeDiaryBean,
  getCoffeeDiaryExport,
  patchCoffeeDiaryBean,
  type CoffeeDiaryApiError
} from "./coffeeDiaryApi";
import { coffeeDiaryRecipeLines } from "./coffeeDiaryPresentation";
import "./coffeeDiary.css";

type RecipeFieldDraft = { key: string; label: string; kind: "text" | "number"; value: string; unit: string };
type RecipeDraft = { method: string; fields: RecipeFieldDraft[] };
type BeanDraft = {
  name: string;
  roaster: string;
  roastDate: string;
  roastLevel: string;
  roastNotes: string;
  origin: string;
  processing: string;
  notes: string;
};

const defaultRecipe: RecipeDraft = {
  method: "Эспрессо",
  fields: [
    { key: "dose", label: "Кофе", kind: "number", value: "18", unit: "г" },
    { key: "yield", label: "Выход", kind: "number", value: "36", unit: "г" },
    { key: "time", label: "Время", kind: "number", value: "28", unit: "с" }
  ]
};

function recipeToDraft(recipe: CoffeeDiaryRecipe | null | undefined): RecipeDraft {
  if (!recipe) return structuredClone(defaultRecipe);
  return { method: recipe.method, fields: recipe.fields.map((field) => ({ ...field, value: String(field.value), unit: field.unit ?? "" })) };
}

function beanToDraft(bean?: CoffeeDiaryBean): BeanDraft {
  return {
    name: bean?.name ?? "",
    roaster: bean?.roaster ?? "",
    roastDate: bean?.roastDate ?? "",
    roastLevel: bean?.roastLevel ?? "",
    roastNotes: bean?.roastNotes ?? "",
    origin: bean?.origin ?? "",
    processing: bean?.processing ?? "",
    notes: bean?.notes ?? ""
  };
}

function recipeToPayload(recipe: RecipeDraft): CoffeeDiaryRecipe | null {
  const fields = recipe.fields.map((field) => {
    const value = field.kind === "number" ? numericInputValue(normalizeNumericInput(field.value)) : field.value.trim();
    if (value === null || value === "") return null;
    return { key: field.key.trim(), label: field.label.trim(), kind: field.kind, value, unit: field.unit.trim() || null };
  });
  if (!recipe.method.trim() || fields.some((field) => field === null)) return null;
  return { method: recipe.method.trim(), fields: fields as NonNullable<typeof fields[number]>[] };
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

function apiMessage(reason: unknown): string {
  const code = reason && typeof reason === "object" && "code" in reason ? String((reason as CoffeeDiaryApiError).code) : "";
  if (code === "revision_conflict") return "Данные изменились в другом окне. Загружено актуальное состояние.";
  if (code === "coffee_diary_write_disabled") return "Изменения недоступны в режиме только чтения.";
  if (code === "coffee_diary_store_unavailable" || code.startsWith("coffee_diary_store_")) return "Дневник временно недоступен: сохранённые данные не изменены.";
  if (code === "coffee_diary_idempotency_key_reused") return "Повторная команда с другим содержимым отклонена.";
  if (code === "coffee_diary_bean_not_found") return "Зерно не найдено в активном дневнике.";
  return "Не удалось сохранить дневник. Проверьте поля и повторите попытку.";
}

function RecipeEditor({ recipe, onChange, prefix }: { recipe: RecipeDraft; onChange: (recipe: RecipeDraft) => void; prefix: string }) {
  const [activeNumeric, setActiveNumeric] = useState<string | null>(null);
  const activeValue = activeNumeric?.startsWith("field:") ? recipe.fields[Number(activeNumeric.slice(6))]?.value ?? "" : "";
  function updateField(index: number, update: Partial<RecipeFieldDraft>) {
    onChange({ ...recipe, fields: recipe.fields.map((field, current) => current === index ? { ...field, ...update } : field) });
  }
  return (
    <fieldset className="coffee-diary-recipe" data-testid={`${prefix}-recipe`}>
      <legend>Рецепт по умолчанию</legend>
      <label className="coffee-diary-form__field coffee-diary-form__field--wide">
        <span>Метод</span>
        <input value={recipe.method} onChange={(event) => onChange({ ...recipe, method: event.target.value })} placeholder="Например, Эспрессо" />
      </label>
      <div className="coffee-diary-recipe__fields">
        {recipe.fields.map((field, index) => (
          <div className="coffee-diary-recipe__field" key={`${field.key}-${index}`}>
            <label><span>Ключ</span><input value={field.key} onChange={(event) => updateField(index, { key: event.target.value })} /></label>
            <label><span>Название</span><input value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} /></label>
            <label><span>Тип</span><select value={field.kind} onChange={(event) => updateField(index, { kind: event.target.value as RecipeFieldDraft["kind"], value: event.target.value === "number" ? "0" : "" })}><option value="number">Число</option><option value="text">Текст</option></select></label>
            {field.kind === "number" ? (
              <div className="coffee-diary-form__field"><span>Значение</span><button type="button" className="coffee-diary-numeric-trigger" data-testid={`${prefix}-numeric-${index}`} onClick={() => setActiveNumeric(`field:${index}`)}>{field.value || "Введите число"}</button></div>
            ) : (
              <label><span>Значение</span><input value={field.value} onChange={(event) => updateField(index, { value: event.target.value })} /></label>
            )}
            <label><span>Единица</span><input value={field.unit} onChange={(event) => updateField(index, { unit: event.target.value })} placeholder="г" /></label>
            <button type="button" className="coffee-diary-link-button" onClick={() => onChange({ ...recipe, fields: recipe.fields.filter((_, current) => current !== index) })}>Удалить поле</button>
          </div>
        ))}
      </div>
      <button type="button" className="coffee-diary-secondary-button" disabled={recipe.fields.length >= 24} onClick={() => onChange({ ...recipe, fields: [...recipe.fields, { key: `field${recipe.fields.length + 1}`, label: "Новое поле", kind: "number", value: "0", unit: "" }] })}>+ Добавить поле</button>
      {activeNumeric?.startsWith("field:") && <NumericKeypad value={activeValue} onChange={(value) => updateField(Number(activeNumeric.slice(6)), { value })} onDone={() => setActiveNumeric(null)} label="Числовое поле рецепта" testId={`${prefix}-numeric-keypad`} />}
    </fieldset>
  );
}

function BeanSheet({ bean, onClose, onSaved }: { bean?: CoffeeDiaryBean; onClose: () => void; onSaved: (bean: CoffeeDiaryBean) => void }) {
  const { guardMutation } = useInteractionLock();
  const [draft, setDraft] = useState(() => beanToDraft(bean));
  const [recipe, setRecipe] = useState(() => recipeToDraft(bean?.defaultRecipe));
  const [hasRecipe, setHasRecipe] = useState(() => bean ? bean.defaultRecipe !== null : true);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!guardMutation()) return;
    const preparedRecipe = hasRecipe ? recipeToPayload(recipe) : null;
    if (!draft.name.trim() || (hasRecipe && !preparedRecipe)) { setError("Заполните название и проверьте поля рецепта."); return; }
    const payload = { ...draft, roastDate: draft.roastDate || null, defaultRecipe: preparedRecipe };
    try {
      const saved = bean
        ? await patchCoffeeDiaryBean(bean.id, bean.version, payload)
        : await createCoffeeDiaryBean(payload, crypto.randomUUID());
      onSaved(saved);
      onClose();
    } catch (reason) { setError(apiMessage(reason)); }
  }
  return (
    <Sheet testId="coffee-diary-bean-sheet" eyebrow="Кофе" title={bean ? "Изменить кофе" : "Добавить кофе"} description="Сохраняются только явно заполненные сведения о зерне и рецепте." onClose={onClose} footer={<div className="coffee-diary-sheet-actions"><button type="button" className="coffee-diary-secondary-button" onClick={onClose}>Отмена</button><button type="submit" form="coffee-diary-bean-form" className="coffee-diary-primary-button">Сохранить</button></div>}>
      <form id="coffee-diary-bean-form" className="coffee-diary-form" onSubmit={(event) => void submit(event)}>
        <div className="coffee-diary-form__grid">
          {(["name", "roaster", "origin", "processing", "roastLevel", "roastDate"] as const).map((field) => (
            <label className="coffee-diary-form__field" key={field}>
              <span>{{ name: "Название", roaster: "Обжарщик", origin: "Происхождение", processing: "Обработка", roastLevel: "Обжарка", roastDate: "Дата обжарки" }[field]}</span>
              <input type={field === "roastDate" ? "date" : "text"} value={draft[field]} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} data-testid={`coffee-diary-input-${field}`} />
            </label>
          ))}
          <label className="coffee-diary-form__field coffee-diary-form__field--wide"><span>Заметки о зерне</span><textarea value={draft.roastNotes} onChange={(event) => setDraft({ ...draft, roastNotes: event.target.value })} rows={2} /></label>
          <label className="coffee-diary-form__field coffee-diary-form__field--wide"><span>Общие заметки</span><textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} rows={3} /></label>
        </div>
        <label className="coffee-diary-checkbox"><input type="checkbox" checked={hasRecipe} onChange={(event) => setHasRecipe(event.target.checked)} /> Сохранять предпочтительный рецепт</label>
        {hasRecipe && <RecipeEditor recipe={recipe} onChange={setRecipe} prefix="coffee-diary-bean" />}
        {error && <p className="coffee-diary-form__error" role="alert">{error}</p>}
      </form>
    </Sheet>
  );
}

function ExtractionSheet({ bean, onClose, onSaved }: { bean: CoffeeDiaryBean; onClose: () => void; onSaved: (extraction: CoffeeDiaryExtraction) => void }) {
  const { guardMutation } = useInteractionLock();
  const [recipe, setRecipe] = useState(() => recipeToDraft(bean.defaultRecipe));
  const [brewedAt, setBrewedAt] = useState(localDateTimeValue);
  const [rating, setRating] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ratingKeypadOpen, setRatingKeypadOpen] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!guardMutation()) return;
    const recipePayload = recipeToPayload(recipe);
    const brewedAtUtc = toUtcTimestamp(brewedAt);
    const ratingValue = rating ? numericInputValue(normalizeNumericInput(rating, false)) : null;
    if (!recipePayload || !brewedAtUtc || (rating && (!ratingValue || !Number.isInteger(ratingValue) || ratingValue < 1 || ratingValue > 10))) { setError("Проверьте рецепт, дату и оценку от 1 до 10."); return; }
    try {
      const saved = await createCoffeeDiaryExtraction(bean.id, { brewedAt: brewedAtUtc, method: recipePayload.method, recipeSnapshot: recipePayload, notes: notes || null, rating: ratingValue }, crypto.randomUUID());
      onSaved(saved);
      onClose();
    } catch (reason) { setError(apiMessage(reason)); }
  }
  return (
    <Sheet testId="coffee-diary-extraction-sheet" eyebrow={bean.name} title="Добавить приготовление" description="В историю попадёт отдельная копия текущего рецепта." onClose={onClose} footer={<div className="coffee-diary-sheet-actions"><button type="button" className="coffee-diary-secondary-button" onClick={onClose}>Отмена</button><button type="submit" form="coffee-diary-extraction-form" className="coffee-diary-primary-button">Сохранить</button></div>}>
      <form id="coffee-diary-extraction-form" className="coffee-diary-form" onSubmit={(event) => void submit(event)}>
        <label className="coffee-diary-form__field"><span>Когда приготовлено</span><input type="datetime-local" value={brewedAt} onChange={(event) => setBrewedAt(event.target.value)} /></label>
        <RecipeEditor recipe={recipe} onChange={setRecipe} prefix="coffee-diary-extraction" />
        <div className="coffee-diary-form__field"><span>Оценка (1–10, необязательно)</span><button type="button" className="coffee-diary-numeric-trigger" onClick={() => setRatingKeypadOpen(true)}>{rating || "Без оценки"}</button>{ratingKeypadOpen && <NumericKeypad value={rating} decimal={false} maxLength={2} onChange={setRating} onDone={() => setRatingKeypadOpen(false)} label="Оценка приготовления" testId="coffee-diary-rating-keypad" />}</div>
        <label className="coffee-diary-form__field"><span>Комментарий</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} placeholder="Что получилось?" /></label>
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

  const selectedBean = useMemo(() => collection?.beans.find((bean) => bean.id === selectedId) ?? null, [collection, selectedId]);

  async function reload() {
    setLoading(true);
    try {
      const next = await getCoffeeDiary();
      setCollection(next);
      setSelectedId((current) => current && next.beans.some((bean) => bean.id === current) ? current : next.beans[0]?.id ?? null);
      setError(null);
    } catch (reason) { setError(apiMessage(reason)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    if (!selectedId) { setSelectedDetail(null); return; }
    void getCoffeeDiaryBean(selectedId).then(setSelectedDetail).catch((reason) => setError(apiMessage(reason)));
  }, [selectedId, collection?.revision]);

  async function deleteBean() {
    if (!selectedBean || !guardMutation()) return;
    const confirmation = await confirmAction("coffee-diary.bean.delete", { target: selectedBean.name });
    if (!confirmation.confirmed || !guardMutation()) return;
    try { await deleteCoffeeDiaryBean(selectedBean.id, selectedBean.version); await reload(); }
    catch (reason) { setError(apiMessage(reason)); }
  }

  async function deleteExtraction(extraction: CoffeeDiaryExtraction) {
    if (!guardMutation()) return;
    const confirmation = await confirmAction("coffee-diary.extraction.delete", { target: extraction.method });
    if (!confirmation.confirmed || !guardMutation()) return;
    try { await deleteCoffeeDiaryExtraction(extraction.id, extraction.version); await reload(); }
    catch (reason) { setError(apiMessage(reason)); }
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
    } catch (reason) { setError(apiMessage(reason)); }
  }

  return (
    <div className="coffee-diary-page" data-testid="route-coffee-diary">
      <div className="coffee-diary-page__header">
        <RouteHeader eyebrow="Личная коллекция" title={copy("page.coffeeDiary.title")} description={copy("page.coffeeDiary.subtitle")} />
        <div className="coffee-diary-page__actions"><button type="button" className="coffee-diary-secondary-button" onClick={() => void exportDiary()} data-testid="coffee-diary-export">Экспорт JSON</button><button type="button" className="coffee-diary-primary-button" onClick={() => setSheet("add-bean")} data-testid="coffee-diary-add-bean">Добавить кофе</button></div>
      </div>
      {error && <p className="coffee-diary-notice" role="alert">{error}</p>}
      {loading && <p className="coffee-diary-state">Загружаем дневник…</p>}
      {!loading && collection && collection.beans.length === 0 && <section className="coffee-diary-empty" data-testid="coffee-diary-empty"><div className="coffee-diary-empty__cup">☕</div><h2>Кофе пока не добавлен</h2><p>Добавьте зерно, чтобы сохранить его характеристики и попробовать первый рецепт.</p><button type="button" className="coffee-diary-primary-button" onClick={() => setSheet("add-bean")}>Добавить кофе</button></section>}
      {!loading && collection && collection.beans.length > 0 && <div className="coffee-diary-layout">
        <section className="coffee-diary-bean-list" aria-label="Зёрна">
          <div className="coffee-diary-section-heading"><div><p className="section-kicker">Коллекция</p><h2>Зёрна</h2></div><span>{collection.beanCount}</span></div>
          <div className="coffee-diary-bean-list__items">{collection.beans.map((bean) => <button key={bean.id} type="button" className={`coffee-diary-bean-card${bean.id === selectedId ? " is-selected" : ""}`} onClick={() => setSelectedId(bean.id)}><strong>{bean.name}</strong><span>{[bean.roaster, bean.origin, bean.roastDate].filter(Boolean).join(" · ") || "Метаданные не заполнены"}</span></button>)}</div>
        </section>
        {selectedBean && <section className="coffee-diary-detail" data-testid="coffee-diary-detail"><div className="coffee-diary-detail__header"><div><p className="section-kicker">Зерно</p><h2>{selectedBean.name}</h2><p>{[selectedBean.roaster, selectedBean.origin, selectedBean.processing].filter(Boolean).join(" · ")}</p></div><div className="coffee-diary-detail__actions"><button type="button" className="coffee-diary-secondary-button" onClick={() => setSheet("edit-bean")}>Изменить</button><button type="button" className="coffee-diary-danger-button" onClick={() => void deleteBean()}>Удалить</button></div></div>
          <dl className="coffee-diary-metadata">{([["Обжарщик", selectedBean.roaster], ["Дата обжарки", selectedBean.roastDate], ["Уровень обжарки", selectedBean.roastLevel], ["Обработка", selectedBean.processing], ["Происхождение", selectedBean.origin]] as [string, string | null][]).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}</dl>
          {selectedBean.notes && <p className="coffee-diary-long-text">{selectedBean.notes}</p>}
          <section className="coffee-diary-recipe-card"><div className="coffee-diary-section-heading"><div><p className="section-kicker">Предпочтительно</p><h3>Рецепт</h3></div><span>{selectedBean.defaultRecipe?.method ?? "Не задан"}</span></div>{selectedBean.defaultRecipe ? <ul>{coffeeDiaryRecipeLines(selectedBean.defaultRecipe).slice(1).map((line) => <li key={line}>{line}</li>)}</ul> : <p>Добавьте рецепт при редактировании зерна.</p>}</section>
          <section className="coffee-diary-history" data-testid="coffee-diary-history"><div className="coffee-diary-section-heading"><div><p className="section-kicker">История</p><h3>Приготовления</h3></div><button type="button" className="coffee-diary-primary-button" onClick={() => setSheet("add-extraction")}>Добавить</button></div>{selectedDetail?.extractions.length ? <div className="coffee-diary-history__items">{selectedDetail.extractions.map((extraction) => <article className="coffee-diary-extraction" key={extraction.id}><div className="coffee-diary-extraction__header"><div><strong>{extraction.method}</strong><time dateTime={extraction.brewedAt}>{new Date(extraction.brewedAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}</time></div><div className="coffee-diary-extraction__tools">{extraction.rating !== null && <span className="coffee-diary-rating">{extraction.rating}/10</span>}<button type="button" className="coffee-diary-link-button" onClick={() => void deleteExtraction(extraction)}>Удалить</button></div></div><ul className="coffee-diary-snapshot">{coffeeDiaryRecipeLines(extraction.recipeSnapshot).slice(1).map((line) => <li key={line}>{line}</li>)}</ul>{extraction.notes && <p>{extraction.notes}</p>}</article>)}</div> : <p className="coffee-diary-muted">Приготовлений пока нет.</p>}</section>
        </section>}
      </div>}
      {sheet === "add-bean" && <BeanSheet onClose={() => setSheet(null)} onSaved={(bean) => { setSheet(null); setSelectedId(bean.id); void reload(); }} />}
      {sheet === "edit-bean" && selectedBean && <BeanSheet bean={selectedBean} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); void reload(); }} />}
      {sheet === "add-extraction" && selectedBean && <ExtractionSheet bean={selectedBean} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); void reload(); }} />}
    </div>
  );
}
