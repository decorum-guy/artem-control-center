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

interface Notice extends Omit<NoticeInput, "timeoutMs"> {
  createdAt: number;
}

interface NoticeCenterContextValue {
  notices: Notice[];
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

function identityMatches(left: Notice, right: NoticeInput): boolean {
  return left.id === right.id || Boolean(right.correlationId && left.correlationId === right.correlationId);
}

export function NoticeCenterProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const sequenceRef = useRef(0);

  const showNotice = useCallback((input: NoticeInput) => {
    setNotices((current) => {
      const existing = current.find((notice) => identityMatches(notice, input));
      const next: Notice = {
        ...input,
        expiresAt: input.expiresAt ?? (input.timeoutMs ? Date.now() + input.timeoutMs : undefined),
        createdAt: existing?.createdAt ?? sequenceRef.current++
      };
      return [...current.filter((notice) => !identityMatches(notice, input)), next];
    });
  }, []);

  const dismissNotice = useCallback((id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
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
  return <NoticeRegion notices={notices} dismissNotice={dismissNotice} />;
}

function NoticeRegion({ notices, dismissNotice }: { notices: Notice[]; dismissNotice: (id: string) => void }) {
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
              <strong>{notice.title}</strong>
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
  }, [showNotice]);

  return null;
}
