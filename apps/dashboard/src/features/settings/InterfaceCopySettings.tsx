import { useEffect, useState } from "react";
import type { InterfaceCopyField, InterfaceCopyPageKey } from "@artem/contracts";
import { useActionConfirmation } from "../../ActionConfirmations";
import { useAccess } from "../../AccessControls";
import { useInterfaceCopy, copyOverrideValue, pageSubtitleField, pageTitleField } from "../../interfaceCopy";
import { Sheet } from "../../Sheet";

type CopyFieldDefinition = {
  key: InterfaceCopyField;
  label: string;
  optional: boolean;
};

const navigationFields: CopyFieldDefinition[] = [
  ["overview", "Обзор"],
  ["weather", "Погода"],
  ["home", "Дом"],
  ["services", "Сервисы"],
  ["calendar", "Календарь"],
  ["tasks", "Задачи"],
  ["reminders", "Напоминания"],
  ["system", "Система"],
  ["settings", "Настройки"]
].map(([key, label]) => ({ key: `navigation.${key}` as InterfaceCopyField, label, optional: false }));

const pageFields: CopyFieldDefinition[] = ([
  ["overview", "Обзор"],
  ["weather", "Погода"],
  ["home", "Дом"],
  ["services", "Сервисы"],
  ["calendar", "Календарь"],
  ["tasks", "Задачи"],
  ["reminders", "Напоминания"],
  ["system", "Система"],
  ["settings", "Настройки"]
] as [InterfaceCopyPageKey, string][]).flatMap(([key, label]) => [
  { key: pageTitleField(key), label: `Заголовок страницы «${label}»`, optional: false },
  { key: pageSubtitleField(key), label: `Подпись страницы «${label}»`, optional: true }
]);

const planningGroupField: CopyFieldDefinition = {
  key: "navigationGroup.planning",
  label: "Группа «Планирование»",
  optional: false
};

function mutationMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "unknown";
  if (code === "revision_conflict") return "Настройки изменились в другом окне. Загружено актуальное состояние.";
  if (code === "interface_copy_write_disabled") return "Изменения названий сейчас недоступны.";
  if (code === "invalid_interface_copy_value") return "Введите допустимый текст без служебных символов.";
  if (code === "invalid_interface_copy_field") return "Это поле больше не поддерживается.";
  return "Не удалось сохранить названия. Показано подтверждённое состояние.";
}

export function InterfaceCopySettingsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet
      testId="settings-interface-copy-sheet"
      eyebrow="Интерфейс"
      title="Названия и подписи"
      description="Меняется только отображаемый текст. Маршруты, действия и доступы остаются прежними."
      onClose={onClose}
    >
      <InterfaceCopySettingsPanel />
    </Sheet>
  );
}

export function InterfaceCopySettingsPanel() {
  const { settings, loading, error, pending, update, reset, resetAll, copy } = useInterfaceCopy();
  const { ensureCapability } = useAccess();
  const { confirmAction } = useActionConfirmation();
  const [drafts, setDrafts] = useState<Partial<Record<InterfaceCopyField, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setDrafts({});
  }, [settings.revision]);

  async function saveField(field: CopyFieldDefinition): Promise<void> {
    if (pending) return;
    if (!(await ensureCapability("settings.interface_copy", `Изменить: ${field.label}`))) {
      setNotice("Изменение названий доступно владельцу панели.");
      return;
    }
    setNotice(null);
    try {
      await update(field.key, drafts[field.key] ?? copy(field.key));
      setDrafts((current) => {
        const next = { ...current };
        delete next[field.key];
        return next;
      });
      setNotice("Название сохранено.");
    } catch (reason) {
      setNotice(mutationMessage(reason));
    }
  }

  async function resetField(field: CopyFieldDefinition): Promise<void> {
    if (pending) return;
    if (!(await ensureCapability("settings.interface_copy", `Сбросить: ${field.label}`))) {
      setNotice("Сброс названий доступен владельцу панели.");
      return;
    }
    setNotice(null);
    try {
      await reset(field.key);
      setDrafts((current) => {
        const next = { ...current };
        delete next[field.key];
        return next;
      });
      setNotice("Для этого поля восстановлен стандартный текст.");
    } catch (reason) {
      setNotice(mutationMessage(reason));
    }
  }

  async function resetEverything(): Promise<void> {
    if (pending) return;
    if (!(await ensureCapability("settings.interface_copy", "Вернуть стандартные названия"))) {
      setNotice("Сброс названий доступен владельцу панели.");
      return;
    }
    const confirmation = await confirmAction("settings.interface-copy.reset-all");
    if (!confirmation.confirmed) return;
    setNotice(null);
    try {
      await resetAll();
      setDrafts({});
      setNotice("Все стандартные названия восстановлены.");
    } catch (reason) {
      setNotice(mutationMessage(reason));
    }
  }

  const writeDisabled = pending !== null || !settings.available || !settings.writesEnabled;
  return (
    <div className="settings-v2-sheet-content interface-copy-settings" data-testid="interface-copy-settings">
      {loading && <p className="settings-notice" role="status">Загружаем сохранённые названия…</p>}
      {error && <p className="settings-notice" role="status">Стандартные названия используются до восстановления связи.</p>}
      {!settings.available && <p className="settings-notice" role="status">Сохранённые названия временно недоступны. Используются стандартные.</p>}
      {!settings.writesEnabled && <p className="settings-notice" role="status">Изменения недоступны в режиме только чтения.</p>}

      <section className="interface-copy-group" aria-labelledby="interface-copy-navigation-title">
        <div className="interface-copy-group__header">
          <div>
            <h2 id="interface-copy-navigation-title">Навигация</h2>
            <p>Подписи в боковой панели. Ссылки остаются на прежних маршрутах.</p>
          </div>
        </div>
        <div className="interface-copy-fields">
          {[...navigationFields, planningGroupField].map((field) => (
            <InterfaceCopyFieldEditor
              key={field.key}
              field={field}
              value={drafts[field.key] ?? copy(field.key)}
              overridden={copyOverrideValue(settings.overrides, field.key) !== null}
              disabled={writeDisabled}
              pending={pending === field.key}
              onChange={(value) => setDrafts((current) => ({ ...current, [field.key]: value }))}
              onSave={() => void saveField(field)}
              onReset={() => void resetField(field)}
            />
          ))}
        </div>
      </section>

      <section className="interface-copy-group" aria-labelledby="interface-copy-pages-title">
        <div className="interface-copy-group__header">
          <div>
            <h2 id="interface-copy-pages-title">Страницы</h2>
            <p>Заголовки и подписи страниц. Пустая подпись означает «не показывать».</p>
          </div>
        </div>
        <div className="interface-copy-fields">
          {pageFields.map((field) => (
            <InterfaceCopyFieldEditor
              key={field.key}
              field={field}
              value={drafts[field.key] ?? copy(field.key)}
              overridden={copyOverrideValue(settings.overrides, field.key) !== null}
              disabled={writeDisabled}
              pending={pending === field.key}
              onChange={(value) => setDrafts((current) => ({ ...current, [field.key]: value }))}
              onSave={() => void saveField(field)}
              onReset={() => void resetField(field)}
            />
          ))}
        </div>
      </section>

      <div className="interface-copy-actions">
        <button type="button" className="planning-secondary-button" disabled={writeDisabled} onClick={() => void resetEverything()}>
          {pending === "reset-all" ? "Сбрасываем…" : "Вернуть стандартные названия"}
        </button>
        {pending && <span role="status">Сохраняем…</span>}
      </div>
      {notice && <p className="settings-notice" role="status" aria-live="polite">{notice}</p>}
    </div>
  );
}

function InterfaceCopyFieldEditor({
  field,
  value,
  overridden,
  disabled,
  pending,
  onChange,
  onSave,
  onReset
}: {
  field: CopyFieldDefinition;
  value: string;
  overridden: boolean;
  disabled: boolean;
  pending: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const testKey = field.key.replaceAll(".", "-");
  return (
    <div className="interface-copy-field" data-testid={`interface-copy-field-${testKey}`}>
      <label htmlFor={`interface-copy-${testKey}`}>
        <span>{field.label}</span>
        {field.optional && <small>Можно оставить пустым</small>}
      </label>
      <div className="interface-copy-field__controls">
        <input
          id={`interface-copy-${testKey}`}
          data-testid={`interface-copy-input-${testKey}`}
          type="text"
          value={value}
          maxLength={field.key.includes("subtitle") ? 240 : field.key.includes("title") ? 96 : 48}
          disabled={disabled}
          aria-label={field.label}
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="button" className="planning-primary-button" disabled={disabled} onClick={onSave}>
          {pending ? "Сохраняем…" : "Сохранить"}
        </button>
        <button type="button" className="planning-secondary-button" disabled={disabled || !overridden} onClick={onReset}>
          Сбросить
        </button>
      </div>
      <small className="interface-copy-field__effective">Сейчас: {value || (field.optional ? "не показывается" : "—")}</small>
    </div>
  );
}
