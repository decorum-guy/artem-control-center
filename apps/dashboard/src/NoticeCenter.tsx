import { createPortal } from "react-dom";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import "./NoticeCenter.css";

export type NoticeSeverity = "info" | "progress" | "success" | "warning" | "error";

export interface NoticeAction {
  label: string;
  onAction: () => void | Promise<void>;
}

export interface NoticeInput {
  id: string;
  correlationId?: string;
  severity: NoticeSeverity;
  title: string;
  detail: string;
  action?: NoticeAction;
  expiresAt?: number;
  timeoutMs?: number;
  testId?: string;
}

export interface NoticeRecord extends Omit<NoticeInput, "timeoutMs"> {
  createdAt: number;
}

interface NoticeCenterContextValue {
  notices: NoticeRecord[];
  showNotice: (notice: NoticeInput) => void;
  dismissNotice: (id: string) => void;
}

const NoticeCenterContext = createContext<NoticeCenterContextValue | null>(null);

const severityOrder: Record<NoticeSeverity, number> = {
  error: 0,
  warning: 1,
  progress: 2,
  success: 3,
  info: 4
};

const defaultTimeoutBySeverity: Partial<Record<NoticeSeverity, number>> = {
  success: 6_000,
  warning: 10_000,
  error: 12_000
};

export const MAX_DISMISSED_CORRELATED_NOTICE_KEYS = 100;

const severityLabel: Record<NoticeSeverity, string> = {
  info: "Информация",
  progress: "Выполняется",
  success: "Успешно",
  warning: "Предупреждение",
  error: "Ошибка"
};

export function noticeIdentityMatches(
  left: Pick<NoticeInput, "id" | "correlationId">,
  right: Pick<NoticeInput, "id" | "correlationId">
): boolean {
  return left.id === right.id || Boolean(
    left.correlationId &&
    right.correlationId &&
    left.correlationId === right.correlationId
  );
}

/**
 * Returns the stable dismissal key for an operation notice. Correlated
 * operation notices are event-scoped; uncorrelated notices remain ephemeral
 * so existing category-level notices can represent a later event again.
 */
export function noticeDismissalKey(
  input: Pick<NoticeInput, "id" | "correlationId">
): string | undefined {
  return input.correlationId
    ? `notice:${input.id}:correlation:${input.correlationId}`
    : undefined;
}

export function isNoticeDismissed(
  input: Pick<NoticeInput, "id" | "correlationId">,
  dismissedKeys: ReadonlySet<string>
): boolean {
  const key = noticeDismissalKey(input);
  return key !== undefined && dismissedKeys.has(key);
}

/** Retain only the most recently inserted correlated dismissal identities. */
export function rememberDismissedNoticeKey(dismissedKeys: Set<string>, key: string): void {
  if (dismissedKeys.has(key)) return;

  dismissedKeys.add(key);
  while (dismissedKeys.size > MAX_DISMISSED_CORRELATED_NOTICE_KEYS) {
    const oldestKey = dismissedKeys.values().next().value;
    if (oldestKey === undefined) return;
    dismissedKeys.delete(oldestKey);
  }
}

export function noticeExpiresAt(input: NoticeInput, now = Date.now()): number | undefined {
  if (input.expiresAt !== undefined) return input.expiresAt;
  if (input.timeoutMs !== undefined) return now + input.timeoutMs;
  const defaultTimeout = defaultTimeoutBySeverity[input.severity];
  return defaultTimeout === undefined ? undefined : now + defaultTimeout;
}

export function NoticeCenterProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<NoticeRecord[]>([]);
  const sequenceRef = useRef(0);
  const dismissedKeysRef = useRef<Set<string>>(new Set());

  const showNotice = useCallback((input: NoticeInput) => {
    setNotices((current) => {
      if (isNoticeDismissed(input, dismissedKeysRef.current)) return current;
      const existing = current.find((notice) => noticeIdentityMatches(notice, input));
      const next: NoticeRecord = {
        ...input,
        expiresAt: noticeExpiresAt(input),
        createdAt: existing?.createdAt ?? sequenceRef.current++
      };
      return [...current.filter((notice) => !noticeIdentityMatches(notice, input)), next];
    });
  }, []);

  const dismissNotice = useCallback((id: string) => {
    setNotices((current) => {
      const dismissed = current.find((notice) => notice.id === id);
      const key = dismissed && noticeDismissalKey(dismissed);
      if (key) rememberDismissedNoticeKey(dismissedKeysRef.current, key);
      return current.filter((notice) => notice.id !== id);
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setNotices((current) => current.filter((notice) => !notice.expiresAt || notice.expiresAt > now));
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  const value = useMemo<NoticeCenterContextValue>(() => ({ notices, showNotice, dismissNotice }), [notices, showNotice, dismissNotice]);

  return <NoticeCenterContext.Provider value={value}>{children}</NoticeCenterContext.Provider>;
}

export function useNoticeCenter() {
  const value = useContext(NoticeCenterContext);
  if (!value) throw new Error("useNoticeCenter must be used inside NoticeCenterProvider");
  return value;
}

export function GlobalNoticeRegion() {
  const { notices, dismissNotice } = useNoticeCenter();
  const region = <NoticeRegion notices={notices} dismissNotice={dismissNotice} />;
  return typeof document === "undefined" || !document.body
    ? region
    : createPortal(region, document.body);
}

function NoticeRegion({ notices, dismissNotice }: { notices: NoticeRecord[]; dismissNotice: (id: string) => void }) {
  const visible = [...notices]
    .sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity] || left.createdAt - right.createdAt)
    .slice(0, 3);

  if (!visible.length) return null;

  return (
    <section className="global-notice-stack" aria-label="Уведомления" data-testid="global-notice-stack">
      {visible.map((notice) => (
        <article
          key={notice.id}
          className={`global-notice global-notice--${notice.severity}`}
          role={notice.severity === "error" ? "alert" : "status"}
          aria-live={notice.severity === "error" ? "assertive" : "polite"}
          aria-atomic="true"
          data-testid={notice.testId ?? "global-notice"}
          data-notice-id={notice.id}
          data-correlation-id={notice.correlationId}
        >
          <span className="global-notice__indicator" aria-hidden="true" />
          <div className="global-notice__body">
            <div className="global-notice__heading">
              <div className="global-notice__heading-copy">
                <span className="global-notice__severity">{severityLabel[notice.severity]}</span>
                <strong>{notice.title}</strong>
              </div>
              <button type="button" className="global-notice__dismiss" onClick={() => dismissNotice(notice.id)} aria-label="Закрыть уведомление">×</button>
            </div>
            <p>{notice.detail}</p>
            {notice.action && (
              <button
                type="button"
                className="global-notice__action"
                onClick={() => {
                  void notice.action?.onAction();
                  dismissNotice(notice.id);
                }}
              >
                {notice.action.label}
              </button>
            )}
          </div>
        </article>
      ))}
      {notices.length > 1 && (
        <p className="global-notice__count" data-testid="global-notice-count">
          Ещё уведомлений: {Math.max(0, notices.length - 1)}
        </p>
      )}
    </section>
  );
}

export function B0NoticeFixture() {
  const { showNotice } = useNoticeCenter();

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const mode = new URLSearchParams(window.location.search).get("b0");
    if (mode === "triple-notice") {
      showNotice({ id: "b0.connectivity", correlationId: "b0-connectivity-1", severity: "progress", title: "Домашнее подключение", detail: "Проверяем Home Assistant и AliceTG." });
      showNotice({ id: "b0.avalar", correlationId: "b0-avalar-1", severity: "success", title: "AVALAR Stage", detail: "Операция подтверждена." });
      showNotice({ id: "b0.coffee", severity: "info", title: "Кофемашина", detail: "Состояние обновлено." });
    }
    if (mode === "duplicate-notice") {
      showNotice({ id: "b0.duplicate-first", correlationId: "b0-same-correlation", severity: "info", title: "Повторное событие", detail: "Первое сообщение." });
      showNotice({ id: "b0.duplicate-second", correlationId: "b0-same-correlation", severity: "info", title: "Повторное событие", detail: "Дубликат устранён." });
    }
    if (mode === "notice-four") {
      for (const [id, title] of [["b0.four-1", "Первое"], ["b0.four-2", "Второе"], ["b0.four-3", "Третье"], ["b0.four-4", "Четвёртое"]] as const) {
        showNotice({ id, severity: "info", title, detail: "Проверка ограничения видимого стека." });
      }
    }
    if (mode === "notice-action") {
      showNotice({
        id: "b0.action",
        severity: "warning",
        title: "Требуется действие",
        detail: "Проверка безопасной кнопки уведомления.",
        action: { label: "Открыть", onAction: () => undefined }
      });
    }
    let terminalTimer: number | undefined;
    if (mode === "notice-lifecycle") {
      showNotice({ id: "b0.lifecycle-progress", correlationId: "b0-lifecycle", severity: "progress", title: "Синхронизация", detail: "Операция выполняется." });
      terminalTimer = window.setTimeout(() => {
        showNotice({ id: "b0.lifecycle-success", correlationId: "b0-lifecycle", severity: "success", title: "Синхронизация", detail: "Операция завершена." });
      }, 120);
    }
    return () => {
      if (terminalTimer !== undefined) window.clearTimeout(terminalTimer);
    };
  }, [showNotice]);

  return null;
}
