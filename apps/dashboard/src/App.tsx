import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fixtureScenarios } from "@artem/config";
import type { DashboardSnapshot, ServiceSnapshot } from "@artem/contracts";
import {
  HomePage,
  OverviewPage,
  PlaceholderPage,
  ServicesPage,
  SettingsPage
} from "./pages";
import { CalendarPage, RemindersPage, TasksPage } from "./PlanningRoutes";
import {
  planningCalendarRouteEnabled,
  planningRemindersRouteEnabled,
  planningTasksRouteEnabled
} from "./planningRouteConfig";
import { reconcileLayout, resolveManifest } from "./registry";
import { ProductShell, type ShellRoutePath } from "./Shell";
import { ErrorBoundary } from "./ErrorBoundary";
import { CoffeeWidget, GenericServiceWidget } from "./widgets";
import { executeCoffeeAction } from "./coffeeApi";
import { SnapshotCoordinator } from "./snapshotStream";
import { useActionConfirmation } from "./ActionConfirmations";
import { ConnectivityRecoverySurface } from "./ConnectivityActions";
import { WeatherPage } from "./Weather";
import { useNoticeCenter } from "./NoticeCenter";

type Theme = "day" | "night";
type MotionMode = "full" | "reduced" | "low-performance" | "battery-saving";

const userRoutes: ShellRoutePath[] = [
  "/overview",
  "/weather",
  "/home",
  "/services",
  "/calendar",
  "/tasks",
  "/reminders",
  "/backups",
  "/apps",
  "/settings",
  "/system"
];

function routeFromLocation(): ShellRoutePath {
  if (window.location.pathname === "/") {
    window.history.replaceState({}, "", `/overview${window.location.search}`);
    return "/overview";
  }
  const requested = window.location.pathname as ShellRoutePath;
  if (requested === "/reminders" && !planningRemindersRouteEnabled) {
    window.history.replaceState({}, "", `/overview${window.location.search}`);
    return "/overview";
  }
  return [...userRoutes, "/dev/widget-gallery"].includes(requested) ? requested : "/overview";
}

function querySetting<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = new URLSearchParams(window.location.search).get(name);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function App() {
  const { confirmAction, confirmationOpen } = useActionConfirmation();
  const { showNotice } = useNoticeCenter();
  const [route, setRoute] = useState<ShellRoutePath>(routeFromLocation);
  const [scenario, setScenario] = useState<string>(() =>
    import.meta.env.DEV
      ? querySetting("scenario", fixtureScenarios, "ha-healthy")
      : "ha-healthy"
  );
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() =>
    querySetting("theme", ["day", "night"] as const, "night")
  );
  const [motion, setMotion] = useState<MotionMode>(() =>
    querySetting(
      "motion",
      ["full", "reduced", "low-performance", "battery-saving"] as const,
      "full"
    )
  );
  const [kiosk, setKiosk] = useState(false);
  const [devSettingsOpen, setDevSettingsOpen] = useState(false);
  const [coffeeActionPending, setCoffeeActionPending] = useState(false);
  const snapshotCoordinator = useRef<SnapshotCoordinator | null>(null);

  useEffect(() => {
    const coordinator = new SnapshotCoordinator({
      scenario,
      onSnapshot: setSnapshot,
      onError: (message) => setError(message || null)
    });
    snapshotCoordinator.current = coordinator;
    coordinator.start();
    return () => {
      coordinator.stop();
      if (snapshotCoordinator.current === coordinator) {
        snapshotCoordinator.current = null;
      }
    };
  }, [scenario]);

  const reconcileSnapshot = useCallback(
    () => snapshotCoordinator.current?.refresh() ?? Promise.resolve(false),
    []
  );

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const widgets = useMemo(
    () => (snapshot ? reconcileLayout(snapshot.services) : []),
    [snapshot]
  );

  function navigate(nextRoute: ShellRoutePath) {
    const query = import.meta.env.DEV ? window.location.search : "";
    window.history.pushState({}, "", `${nextRoute}${query}`);
    setRoute(nextRoute);
  }

  async function addFixtureService() {
    const service: ServiceSnapshot = {
      id: `discovered-${Date.now()}`,
      title: "Discovered Service",
      enabled: true,
      dataContract: "future.contract.v1",
      health: "healthy",
      source: "fixture",
      summary: "Registry update materialized automatically",
      actions: [],
      data: {}
    };
    const response = await fetch("/api/v1/fixtures/services", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(service)
    });
    if (!response.ok) throw new Error(`Fixture update failed: ${response.status}`);
    await reconcileSnapshot();
  }

  async function runCoffeeAction(service: ServiceSnapshot, actionId: string) {
    if (coffeeActionPending || confirmationOpen) return;
    const action = actionId.endsWith("turn_on") ? "turn_on" : "turn_off";
    if (action === "turn_on") {
      const confirmation = await confirmAction("home.coffee.turn_on");
      if (!confirmation.confirmed) return;
    }
    setCoffeeActionPending(true);
    showNotice({
      id: "coffee.action",
      severity: "progress",
      title: service.title,
      detail: "Команда отправлена, ждём подтверждение Home Assistant…"
    });
    try {
      const result = await executeCoffeeAction(action, crypto.randomUUID());
      showNotice({
        id: "coffee.action",
        severity: "progress",
        title: service.title,
        detail: "Команда подтверждена, обновляем данные панели…"
      });
      const reconciled = await reconcileSnapshot();
      showNotice({
        id: "coffee.action",
        severity: reconciled ? "success" : "warning",
        title: service.title,
        detail: reconciled
          ? `Home Assistant подтвердил состояние «${result.confirmedState === "on" ? "включена" : "выключена"}».`
          : "Команда подтверждена, но данные панели ещё обновляются.",
        timeoutMs: 6_000
      });
    } catch {
      showNotice({
        id: "coffee.action",
        severity: "error",
        title: service.title,
        detail: "Подтверждение не получено. Проверьте текущее состояние перед повтором.",
        timeoutMs: 10_000
      });
    } finally {
      setCoffeeActionPending(false);
    }
  }

  const appClassName = [
    "app",
    `theme-${theme}`,
    `motion-${motion}`,
    kiosk ? "simulated-kiosk" : ""
  ].filter(Boolean).join(" ");

  if (route === "/dev/widget-gallery") {
    if (import.meta.env.PROD) {
      return (
        <main className={appClassName}>
          <section className="dev-disabled" data-testid="dev-disabled">
            <p className="section-kicker">Development route</p>
            <h1>Widget gallery отключена</h1>
            <p>Этот маршрут недоступен в production build.</p>
            <button type="button" onClick={() => navigate("/overview")}>Вернуться в обзор</button>
          </section>
        </main>
      );
    }

    return (
      <main className={appClassName}>
        <header className="dev-header">
          <div>
            <p className="section-kicker">Artem Control Center · development</p>
            <h1>Widget gallery</h1>
          </div>
          <button type="button" onClick={() => navigate("/overview")}>Открыть продукт</button>
        </header>
        <nav className="dev-toolbar" aria-label="Development controls">
          <label>
            Fixture
            <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
              {fixtureScenarios.map((fixture) => (
                <option key={fixture} value={fixture}>{fixture}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setTheme(theme === "night" ? "day" : "night")}>
            {theme === "night" ? "День" : "Ночь"}
          </button>
          <button
            type="button"
            onClick={() => setMotion(motion === "full" ? "reduced" : "full")}
          >
            Motion: {motion}
          </button>
          <button type="button" onClick={() => setKiosk(!kiosk)}>Kiosk viewport</button>
          <button type="button" onClick={() => setDevSettingsOpen(!devSettingsOpen)}>Settings</button>
          {snapshot?.mode === "fixtures" && (
            <button data-testid="add-service" type="button" onClick={() => void addFixtureService()}>
              + Registry service
            </button>
          )}
          <span className="mode-badge" data-testid="mode-badge">
            {snapshot?.mode ?? "loading"}
          </span>
        </nav>

        {devSettingsOpen && (
          <aside className="dev-settings" data-testid="settings-panel">
            <p className="section-kicker">Settings</p>
            <h2>Layout reconciliation</h2>
            <p>Новые enabled services появляются автоматически; существующие позиции сохраняются.</p>
            <dl>
              <div><dt>Theme</dt><dd>{theme}</dd></div>
              <div><dt>Motion</dt><dd>{motion}</dd></div>
              <div><dt>Widgets</dt><dd>{widgets.length}</dd></div>
            </dl>
          </aside>
        )}

        {error && <p className="global-error">{error}</p>}
        {!snapshot && !error && <p className="loading">Собираем fixture snapshot…</p>}
        <section className="dev-widget-grid" aria-label="Automatically reconciled widgets">
          {snapshot &&
            widgets.map((widget) => {
              const service = snapshot.services.find((item) => item.id === widget.serviceId)!;
              const manifest = resolveManifest(service);
              return (
                <ErrorBoundary key={widget.id} title={service.title}>
                  {manifest.id === "home.coffee-machine" ? (
                    <CoffeeWidget
                      service={service}
                      generatedAt={snapshot.generatedAt}
                      manifest={manifest}
                      variant="gallery"
                    />
                  ) : (
                    <GenericServiceWidget service={service} />
                  )}
                </ErrorBoundary>
              );
            })}
        </section>
      </main>
    );
  }

  return (
    <div className={appClassName}>
      {error && <p className="global-error">{error}</p>}
      {!snapshot && !error && <p className="loading">Собираем локальный snapshot…</p>}
      {snapshot && (
        <ProductShell route={route} services={snapshot.services} onNavigate={navigate}>
          {(route === "/overview" || route === "/home" || route === "/services") && (
            <ConnectivityRecoverySurface
              services={snapshot.services}
              showWhenHealthy={route === "/services"}
            />
          )}
          {route === "/overview" && (
            <OverviewPage
              snapshot={snapshot}
              onNavigate={navigate}
              onCoffeeAction={(service, actionId) => void runCoffeeAction(service, actionId)}
              coffeeActionPending={coffeeActionPending}
            />
          )}
          {route === "/weather" && <WeatherPage />}
          {route === "/home" && (
            <HomePage
              snapshot={snapshot}
              onNavigate={navigate}
              onCoffeeAction={(service, actionId) => void runCoffeeAction(service, actionId)}
              coffeeActionPending={coffeeActionPending}
            />
          )}
          {route === "/services" && <ServicesPage snapshot={snapshot} onNavigate={navigate} />}
          {route === "/settings" && (
            <SettingsPage
              theme={theme}
              motion={motion}
              onThemeChange={setTheme}
              onMotionChange={setMotion}
            />
          )}
          {route === "/tasks" && (planningTasksRouteEnabled ? <TasksPage snapshot={snapshot} onNavigate={navigate} /> : <PlaceholderPage route="/tasks" />)}
          {route === "/calendar" && (planningCalendarRouteEnabled ? <CalendarPage snapshot={snapshot} onNavigate={navigate} /> : <PlaceholderPage route="/calendar" />)}
          {route === "/reminders" && planningRemindersRouteEnabled && <RemindersPage snapshot={snapshot} onNavigate={navigate} />}
          {!["/overview", "/weather", "/home", "/services", "/settings", "/tasks", "/calendar", "/reminders"].includes(route) && (
            <PlaceholderPage route={route as "/backups" | "/apps" | "/system"} />
          )}
        </ProductShell>
      )}
    </div>
  );
}
