import { useState, type ReactNode } from "react";
import { DialogFrame } from "../../DialogFrame";

export function EditToolbar({
  dirty,
  saving,
  uncertain,
  canWrite,
  message,
  onAdd,
  onReset,
  onCancel,
  onSave,
  onReconcile,
  onLoadCurrent,
  conflict
}: {
  dirty: boolean;
  saving: boolean;
  uncertain: boolean;
  canWrite: boolean;
  message: string | null;
  onAdd: () => void;
  onReset: () => void;
  onCancel: () => void;
  onSave: () => void;
  onReconcile: () => void;
  onLoadCurrent: () => void;
  conflict: boolean;
}): ReactNode {
  const [resetOpen, setResetOpen] = useState(false);
  const disabled = saving || uncertain;
  return (
    <>
      <header className="overview-v2-toolbar overview-v2-toolbar--edit" data-testid="overview-edit-toolbar">
        <div className="overview-v2-toolbar__edit-actions">
          <button
            type="button"
            className="overview-v2-toolbar__primary"
            disabled={disabled || !canWrite}
            onClick={onAdd}
            data-testid="overview-add-widget"
            title={!canWrite ? "Сохранение панели отключено сервером" : undefined}
          >
            Добавить виджет
          </button>
          <button
            type="button"
            className="overview-v2-toolbar__secondary"
            disabled={disabled}
            onClick={() => setResetOpen(true)}
            data-testid="overview-reset"
          >
            Сбросить
          </button>
        </div>
        <div className="overview-v2-toolbar__dirty" role="status" aria-live="polite">
          {saving ? "Сохраняем…" : uncertain ? "Проверяем результат сохранения…" : dirty ? "Есть несохранённые изменения" : "Изменений нет"}
          {message && <span className="overview-v2-toolbar__message">{message}</span>}
        </div>
        <div className="overview-v2-toolbar__edit-actions overview-v2-toolbar__edit-actions--end">
          {uncertain && !saving && !conflict && (
            <button type="button" className="overview-v2-toolbar__secondary" onClick={onReconcile} data-testid="overview-reconcile-save">
              Проверить сохранение
            </button>
          )}
          {conflict && !saving && (
            <button type="button" className="overview-v2-toolbar__secondary" onClick={onLoadCurrent} data-testid="overview-load-current">
              Загрузить актуальную версию
            </button>
          )}
          <button type="button" className="overview-v2-toolbar__secondary" disabled={saving || uncertain} onClick={onCancel} data-testid="overview-cancel">
            Отмена
          </button>
          <button
            type="button"
            className="overview-v2-toolbar__primary"
            disabled={disabled || !canWrite || !dirty || uncertain}
            onClick={onSave}
            data-testid="overview-save"
          >
            Готово
          </button>
        </div>
      </header>
      {!canWrite && (
        <p className="overview-v2-editor-capability" data-testid="overview-editor-capability">
          Сохранение панели отключено на сервере. Изменения доступны только как безопасный просмотр.
        </p>
      )}
      {resetOpen && (
        <DialogFrame
          title="Сбросить панель?"
          description="Текущий черновик будет заменён shipped-раскладкой и настройками виджетов. Сохранение произойдёт только после нажатия «Готово»."
          testId="overview-reset-dialog"
          onClose={() => setResetOpen(false)}
          footer={(
            <>
              <button type="button" className="overview-v2-toolbar__secondary" onClick={() => setResetOpen(false)}>Отмена</button>
              <button
                type="button"
                className="overview-v2-toolbar__primary"
                onClick={() => {
                  setResetOpen(false);
                  onReset();
                }}
              >
                Сбросить
              </button>
            </>
          )}
        >
          <p>Позиции, размеры, видимость и bounded appearance-настройки вернутся к текущей версии по умолчанию.</p>
        </DialogFrame>
      )}
    </>
  );
}
