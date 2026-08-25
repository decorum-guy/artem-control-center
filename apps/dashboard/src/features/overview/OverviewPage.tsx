import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { DashboardSnapshot, OverviewLayoutDocument, ServiceSnapshot } from "@artem/contracts";
import type { ShellRoutePath } from "../../Shell";
import { useNoticeCenter } from "../../NoticeCenter";
import { DashboardGrid } from "./DashboardGrid";
import { EditToolbar } from "./EditToolbar";
import { WidgetAppearanceSheet } from "./WidgetAppearanceSheet";
import { WidgetPicker } from "./WidgetPicker";
import { overviewEditorEnabled, overviewV2Enabled } from "../../overviewConfig";
import { getOverviewLayout, OverviewLayoutApiError, readBackOverviewLayout, saveOverviewLayout } from "./overviewLayoutApi";
import { overviewFoundationLayout, overviewFixtureModeFromLocation } from "./overviewFixture";
import { overviewEditorDirty, overviewEditorReducer, createOverviewEditorState, makeShippedOverviewDocument, overviewItemsEqual } from "./overviewEditorReducer";
import { validateOverviewLayout } from "./layoutValidation";
import { useInteractionLock } from "../../InteractionLock";
import "./overviewEditor.css";

export function OverviewV2Page({
  snapshot,
  onNavigate,
  onCoffeeAction,
  coffeeActionPending
}: {
  snapshot: DashboardSnapshot;
  onNavigate: (path: ShellRoutePath) => void;
  onCoffeeAction: (service: ServiceSnapshot, actionId: string) => void;
  coffeeActionPending: boolean;
}): ReactNode {
  const fixtureMode = overviewFixtureModeFromLocation();
  const { showNotice } = useNoticeCenter();
  const { guardMutation } = useInteractionLock();
  const [editor, dispatch] = useReducer(
    overviewEditorReducer,
    makeShippedOverviewDocument(false),
    createOverviewEditorState
  );
  const [layoutAvailable, setLayoutAvailable] = useState(false);
  const [layoutLoading, setLayoutLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [appearanceInstanceId, setAppearanceInstanceId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const etagRef = useRef('"0"');

  useEffect(() => {
    const controller = new AbortController();
    setLayoutLoading(true);
    void getOverviewLayout(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        etagRef.current = result.etag;
        setLayoutAvailable(result.available);
        const document: OverviewLayoutDocument = fixtureMode === "default"
          ? result.document
          : { ...result.document, items: overviewFoundationLayout(fixtureMode) as OverviewLayoutDocument["items"] };
        dispatch({ type: "hydrate", document });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        etagRef.current = '"0"';
        setLayoutAvailable(false);
        dispatch({ type: "hydrate", document: makeShippedOverviewDocument(false) });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLayoutLoading(false);
      });
    return () => controller.abort();
  }, [fixtureMode]);

  const editMode = editor.mode !== "normal";
  const saving = editor.mode === "saving";
  const uncertain = editor.mode === "uncertain";
  const dirty = overviewEditorDirty(editor);
  const canWrite = overviewV2Enabled && overviewEditorEnabled && layoutAvailable && editor.canonical.writesEnabled === true;
  const canEnterEdit = canWrite && !layoutLoading;
  const visibleItems = editMode ? editor.draft : editor.canonical.items;
  const appearanceItem = appearanceInstanceId
    ? editor.draft.find((item) => item.instanceId === appearanceInstanceId) ?? null
    : null;

  const runtime = {
    snapshot,
    onNavigate: editMode ? (() => undefined) : onNavigate,
    onCoffeeAction: editMode ? (() => undefined) : onCoffeeAction,
    coffeeActionPending,
    editMode
  };

  async function reconcileUncertain(candidate: OverviewLayoutDocument["items"]): Promise<void> {
    try {
      const read = await readBackOverviewLayout();
      if (!read.available) {
        dispatch({ type: "save-uncertain", message: "Проверка пока недоступна. Черновик сохранён на экране; повторная запись не выполнялась." });
        return;
      }
      etagRef.current = read.etag;
      if (overviewItemsEqual(read.document.items, candidate)) {
        dispatch({ type: "save-succeeded", document: read.document });
        setAppearanceInstanceId(null);
        showNotice({ id: "overview.layout.save", severity: "success", title: "Панель сохранена", detail: "Сервер подтвердил сохранённую конфигурацию.", timeoutMs: 6_000 });
        return;
      }
      dispatch({ type: "save-conflict", message: "Панель изменилась в другом окне. Черновик не перезаписан." });
      showNotice({
        id: "overview.layout.conflict",
        severity: "warning",
        title: "Конфликт конфигурации",
        detail: "Загрузите актуальную версию панели перед продолжением.",
        timeoutMs: 10_000
      });
    } catch {
      dispatch({ type: "save-uncertain", message: "Не удалось подтвердить результат. Не повторяйте сохранение вслепую." });
    }
  }

  async function saveDraft(): Promise<void> {
    if (!guardMutation()) {
      const message = "Панель заблокирована. Удерживайте замок для разблокировки.";
      dispatch({ type: "message", message });
      setAnnouncement(message);
      return;
    }
    const validation = validateOverviewLayout(editor.draft);
    if (!validation.valid) {
      const message = "Черновик содержит недопустимое размещение или настройку. Исправьте его перед сохранением.";
      dispatch({ type: "message", message });
      setAnnouncement(message);
      return;
    }
    const candidate = editor.draft.map((item) => ({ ...item, placement: { ...item.placement }, config: item.config ? { ...item.config } : {} }));
    dispatch({ type: "save-started" });
    try {
      if (!guardMutation()) {
        const message = "Панель заблокирована. Удерживайте замок для разблокировки.";
        dispatch({ type: "save-failed", message });
        setAnnouncement(message);
        return;
      }
      const result = await saveOverviewLayout(candidate, etagRef.current);
      etagRef.current = result.etag;
      dispatch({ type: "save-succeeded", document: result.document });
      setAppearanceInstanceId(null);
        showNotice({ id: "overview.layout.save", severity: "success", title: "Панель сохранена", detail: "Новая конфигурация загружена.", timeoutMs: 6_000 });
    } catch (error) {
      if (error instanceof OverviewLayoutApiError && error.conflict) {
        dispatch({ type: "save-conflict", message: "Панель изменилась в другом окне. Локальный черновик сохранён." });
        showNotice({
          id: "overview.layout.conflict",
          severity: "warning",
          title: "Панель изменилась в другом окне",
          detail: "Загрузите актуальную версию, чтобы продолжить безопасно.",
          timeoutMs: 10_000
        });
        return;
      }
      if (error instanceof OverviewLayoutApiError && error.uncertain) {
        dispatch({ type: "save-uncertain", message: "Результат сохранения неизвестен. Проверяем сервер без повторной записи…" });
        void reconcileUncertain(candidate);
        return;
      }
      const message = error instanceof Error ? error.message : "Сохранение не выполнено.";
      dispatch({ type: "save-failed", message });
      setAnnouncement(message);
    }
  }

  async function loadCurrentServer(): Promise<void> {
    try {
      const result = await getOverviewLayout();
      if (!result.available) {
        dispatch({ type: "message", message: "Актуальная версия панели пока недоступна." });
        return;
      }
      etagRef.current = result.etag;
      dispatch({ type: "load-server", document: result.document });
      setAppearanceInstanceId(null);
    } catch {
      dispatch({ type: "message", message: "Не удалось загрузить актуальную версию панели." });
    }
  }

  function cancelEdit(): void {
    dispatch({ type: "cancel" });
    setPickerOpen(false);
    setAppearanceInstanceId(null);
    setAnnouncement("");
  }

  const toolbar = editMode ? (
    <EditToolbar
      dirty={dirty}
      saving={saving}
      uncertain={uncertain}
      canWrite={canWrite}
      message={editor.message}
      conflict={editor.conflict}
      onAdd={() => setPickerOpen(true)}
      onReset={() => {
        dispatch({ type: "reset" });
        setAppearanceInstanceId(null);
      }}
      onCancel={cancelEdit}
      onSave={() => void saveDraft()}
      onReconcile={() => void reconcileUncertain(editor.draft)}
      onLoadCurrent={() => void loadCurrentServer()}
    />
  ) : (
    <header className="overview-v2-toolbar" data-testid="overview-toolbar">
      <div className="overview-v2-toolbar__copy">
        <h1>Обзор</h1>
        <p>Сегодня, всё важное в первом экране</p>
      </div>
      <button
        type="button"
        className="overview-v2-toolbar__configure"
        disabled={!canEnterEdit}
        aria-disabled={!canEnterEdit}
        aria-describedby="overview-configure-note"
        data-testid="overview-configure"
        title={canEnterEdit ? "Редактировать расположение и виджеты" : "Редактор панели сейчас недоступен"}
        onClick={() => dispatch({ type: "enter" })}
      >
        Настроить
      </button>
      <span id="overview-configure-note" className="overview-v2-toolbar__note">
        {!overviewEditorEnabled
          ? "Редактор панели выключен флагом продукта."
          : layoutLoading
            ? "Проверяем панель…"
            : !layoutAvailable
              ? "Сохранённая конфигурация недоступна; показывается стандартная раскладка."
              : !canWrite
                ? "Сохранение панели отключено."
                : "Редактор панели готов."}
      </span>
    </header>
  );

  return (
    <div className={`overview-v2-page${editMode ? " overview-v2-page--editing" : ""}`} data-testid="route-overview-v2" data-snapshot-mode={snapshot.mode} data-editor-mode={editor.mode}>
      {toolbar}
      {announcement && <p className="overview-edit-announcement" aria-live="polite">{announcement}</p>}
      {editor.canonical.warnings && editor.canonical.warnings.length > 0 && !editMode && (
        <p className="overview-v2-layout-warning" data-testid="overview-layout-warning">Показывается безопасное восстановление сохранённой панели.</p>
      )}
      {editMode && editor.canonical.unplaced && editor.canonical.unplaced.length > 0 && (
        <section className="overview-unplaced" data-testid="overview-unplaced">
          <h2>Неразмещённые</h2>
          {editor.canonical.unplaced.map((record) => (
            <p key={`${record.instanceId}-${record.widgetType}`}><strong>{record.instanceId}</strong> · {record.widgetType} — {record.reason}</p>
          ))}
        </section>
      )}
      <DashboardGrid
        items={visibleItems}
        runtime={runtime}
        editMode={editMode}
        selectedInstanceId={editor.selectedInstanceId}
        chromeHiddenInstanceId={appearanceInstanceId}
        editingDisabled={saving || uncertain}
        onSelect={(instanceId) => dispatch({ type: "select", instanceId })}
        onMove={(instanceId, dx, dy) => {
          dispatch({ type: "move", instanceId, dx, dy });
          setAnnouncement("");
        }}
        onResize={(instanceId, sizeVariant) => {
          dispatch({ type: "resize", instanceId, sizeVariant });
          setAnnouncement("");
        }}
        onRemove={(instanceId) => {
          dispatch({ type: "remove", instanceId });
          setAppearanceInstanceId(null);
        }}
        onOpenAppearance={(instanceId) => {
          dispatch({ type: "select", instanceId });
          setAppearanceInstanceId(instanceId);
        }}
        onAnnounce={setAnnouncement}
      />
      {pickerOpen && editMode && (
        <WidgetPicker
          items={editor.draft}
          onAdd={(widgetType) => dispatch({ type: "add", widgetType })}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {appearanceItem && editMode && (
        <WidgetAppearanceSheet
          item={appearanceItem}
          onChange={(key, value) => dispatch({ type: "set-config", instanceId: appearanceItem.instanceId, key, value })}
          onReset={() => dispatch({ type: "reset-widget-config", instanceId: appearanceItem.instanceId })}
          onClose={() => setAppearanceInstanceId(null)}
        />
      )}
    </div>
  );
}
