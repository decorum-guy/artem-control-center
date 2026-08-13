import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { ServiceSnapshot } from "@artem/contracts";
import { WeatherHeaderSummary } from "./Weather";
import { TemporaryAccessIndicator, useAccess } from "./AccessControls";
import type { AccessStatus } from "./accessApi";
import { B0NoticeFixture, GlobalNoticeRegion } from "./NoticeCenter";
import { Icon, type IconName } from "./icons";
import { StatusText } from "./ShellPrimitives";
import { v2VisualShellEnabled } from "./visualShellConfig";

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

const v2PrimaryNavigation: Array<{ path: ShellRoutePath; label: string; icon: IconName }> = [
  { path: "/overview", label: "Обзор", icon: "overview" },
  { path: "/weather", label: "Погода", icon: "weather" },
  { path: "/home", label: "Дом", icon: "home" },
  { path: "/services", label: "Сервисы", icon: "services" }
];

const v2PlanningNavigation: Array<{ path: ShellRoutePath; label: string; icon: IconName }> = [
  { path: "/calendar", label: "Календарь", icon: "calendar" },
  { path: "/tasks", label: "Задачи", icon: "tasks" },
  { path: "/reminders", label: "Напоминания", icon: "reminder" }
];

const v2SecondaryNavigation: Array<{ path: ShellRoutePath; label: string; icon: IconName }> = [
  { path: "/system", label: "Система", icon: "system" },
  { path: "/settings", label: "Настройки", icon: "settings" }
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
  if (v2VisualShellEnabled) {
    return (
      <V2ProductShell route={route} services={services} onNavigate={onNavigate}>
        {children}
      </V2ProductShell>
    );
  }

  return (
    <LegacyProductShell route={route} services={services} onNavigate={onNavigate}>
      {children}
    </LegacyProductShell>
  );
}

function LegacyProductShell({
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

function V2NavigationLink({
  path,
  label,
  icon,
  current,
  onNavigate,
  child = false
}: {
  path: ShellRoutePath;
  label: string;
  icon: IconName;
  current: ShellRoutePath;
  onNavigate: (path: ShellRoutePath) => void;
  child?: boolean;
}) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    onNavigate(path);
  }

  return (
    <a
      href={path}
      className={`v2-nav-link${child ? " v2-nav-link--child" : ""}`}
      aria-current={current === path ? "page" : undefined}
      data-nav-route={path}
      onClick={handleClick}
    >
      <Icon name={icon} />
      <span>{label}</span>
    </a>
  );
}

function accessStatusLabel(status: AccessStatus): string {
  const labels: Record<AccessStatus["effectiveProfile"], string> = {
    read_only: "Только чтение",
    standard: "Обычный доступ",
    full: "Полный доступ"
  };
  return `${labels[status.effectiveProfile]}${status.temporaryFull ? " · временно" : ""}`;
}

function V2AccessHeaderStatus({ onOpen }: { onOpen: () => void }) {
  const { status, available } = useAccess();
  const label = status
    ? accessStatusLabel(status)
    : available
      ? "Проверяем доступ…"
      : "Доступ недоступен";
  const tone = status?.temporaryFull ? "warning" : "neutral";

  return (
    <button
      type="button"
      className="v2-header-control v2-header-access"
      aria-label={`Открыть уровень доступа: ${label}`}
      onClick={onOpen}
    >
      <Icon name="shield" />
      <StatusText label={label} tone={tone} showIndicator={false} />
    </button>
  );
}

function V2ProductShell({
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

  const systemLabel = attentionCount
    ? `${attentionCount} требуют внимания`
    : "Системы в норме";

  return (
    <div className="v2-shell" data-testid="v2-shell">
      <aside className="v2-navigation-rail" data-testid="v2-navigation-rail">
        <div className="v2-brand">
          <span className="v2-brand__mark" aria-hidden="true">ACC</span>
          <span className="v2-brand__copy">
            <strong>Artem</strong>
            <span>Control Center</span>
          </span>
        </div>

        <div className="v2-navigation-route-bar">
          <nav className="v2-navigation-primary" aria-label="Основные разделы">
            {v2PrimaryNavigation.map((item) => (
              <V2NavigationLink
                key={item.path}
                {...item}
                current={route}
                onNavigate={onNavigate}
              />
            ))}
            <div className="v2-planning-group">
              <p className="v2-nav-group-label">ПЛАНИРОВАНИЕ</p>
              <nav aria-label="Планирование">
                {v2PlanningNavigation.map((item) => (
                  <V2NavigationLink
                    key={item.path}
                    {...item}
                    child
                    current={route}
                    onNavigate={onNavigate}
                  />
                ))}
              </nav>
            </div>
          </nav>
          <nav className="v2-navigation-secondary" aria-label="Системные разделы">
            {v2SecondaryNavigation.map((item) => (
              <V2NavigationLink
                key={item.path}
                {...item}
                current={route}
                onNavigate={onNavigate}
              />
            ))}
          </nav>
        </div>
      </aside>

      <main className="v2-workspace">
        <header className="v2-product-header" data-testid="product-header">
          <div className="v2-compact-brand" aria-hidden="true">
            <span className="v2-brand__mark">ACC</span>
            <span>Control Center</span>
          </div>
          <div className="header-time v2-header-time">
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
          <div className="header-context v2-header-actions">
            <WeatherHeaderSummary onOpen={() => onNavigate("/weather")} />
            <button
              className={`system-summary v2-header-control v2-header-system ${attentionCount ? "system-summary--attention" : ""}`}
              type="button"
              onClick={() => onNavigate("/system")}
            >
              <StatusText label={systemLabel} tone={attentionCount ? "warning" : "success"} />
            </button>
            <V2AccessHeaderStatus onOpen={() => onNavigate("/settings")} />
            <button
              className="settings-shortcut v2-settings-shortcut"
              type="button"
              aria-label="Открыть настройки"
              onClick={() => onNavigate("/settings")}
            >
              <Icon name="settings" />
            </button>
            <TemporaryAccessIndicator />
          </div>
        </header>
        <GlobalNoticeRegion />
        <B0NoticeFixture />
        <div className="route-content v2-route-content">{children}</div>
      </main>
    </div>
  );
}
