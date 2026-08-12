import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { ServiceSnapshot } from "@artem/contracts";
import { WeatherHeaderSummary } from "./Weather";
import { TemporaryAccessIndicator } from "./AccessControls";
import { B0NoticeFixture, GlobalNoticeRegion } from "./NoticeCenter";

export type RoutePath =
  | "/overview"
  | "/home"
  | "/services"
  | "/calendar"
  | "/tasks"
  | "/reminders"
  | "/backups"
  | "/apps"
  | "/settings"
  | "/system"
  | "/dev/widget-gallery";

export type ShellRoutePath = RoutePath | "/weather";

const primaryNavigation: Array<{ path: ShellRoutePath; label: string; short: string }> = [
  { path: "/overview", label: "Обзор", short: "О" },
  { path: "/weather", label: "Погода", short: "П" },
  { path: "/home", label: "Дом", short: "Д" },
  { path: "/services", label: "Сервисы", short: "С" },
  { path: "/calendar", label: "Календарь", short: "К" },
  { path: "/tasks", label: "Задачи", short: "З" },
  { path: "/backups", label: "Резервные копии", short: "Б" }
];

const secondaryNavigation: Array<{ path: ShellRoutePath; label: string }> = [
  { path: "/apps", label: "Приложения" },
  { path: "/system", label: "Система" },
  { path: "/settings", label: "Настройки" }
];

function NavigationLink({
  path,
  label,
  short,
  current,
  onNavigate
}: {
  path: ShellRoutePath;
  label: string;
  short?: string;
  current: ShellRoutePath;
  onNavigate: (path: ShellRoutePath) => void;
}) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    onNavigate(path);
  }

  return (
    <a
      href={path}
      className="navigation-link"
      aria-current={current === path ? "page" : undefined}
      onClick={handleClick}
    >
      {short && <span className="navigation-link__short" aria-hidden="true">{short}</span>}
      <span>{label}</span>
    </a>
  );
}

export function ProductShell({
  route,
  services,
  onNavigate,
  children
}: {
  route: ShellRoutePath;
  services: ServiceSnapshot[];
  onNavigate: (path: ShellRoutePath) => void;
  children: ReactNode;
}) {
  const [now, setNow] = useState(() => new Date());
  const attentionCount = services.filter(
    (service) => service.enabled && service.health !== "healthy"
  ).length;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="product-shell">
      <aside className="navigation-rail">
        <div className="product-mark">
          <strong>ACC</strong>
          <span>Artem Control Center</span>
        </div>
        <nav className="primary-navigation" aria-label="Основные разделы">
          {primaryNavigation.map((item) => (
            <NavigationLink
              key={item.path}
              {...item}
              current={route}
              onNavigate={onNavigate}
            />
          ))}
        </nav>
        <nav className="secondary-navigation" aria-label="Дополнительные разделы">
          {secondaryNavigation.map((item) => (
            <NavigationLink
              key={item.path}
              {...item}
              current={route}
              onNavigate={onNavigate}
            />
          ))}
        </nav>
      </aside>

      <main className="workspace">
        <header className="product-header" data-testid="product-header">
          <div className="header-time">
            <time dateTime={now.toISOString()}>
              {now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
            </time>
            <span>
              {now.toLocaleDateString("ru-RU", {
                weekday: "long",
                day: "numeric",
                month: "long"
              })}
            </span>
          </div>
          <div className="header-context">
            <WeatherHeaderSummary onOpen={() => onNavigate("/weather")} />
            <button
              className={`system-summary ${attentionCount ? "system-summary--attention" : ""}`}
              type="button"
              onClick={() => onNavigate("/system")}
            >
              <i aria-hidden="true" />
              {attentionCount ? `${attentionCount} требуют внимания` : "Системы в норме"}
            </button>
            <button
              className="settings-shortcut"
              type="button"
              aria-label="Открыть настройки"
              onClick={() => onNavigate("/settings")}
            >
              А
            </button>
            <TemporaryAccessIndicator />
          </div>
        </header>
        <GlobalNoticeRegion />
        <B0NoticeFixture />
        <div className="route-content">{children}</div>
      </main>
    </div>
  );
}
