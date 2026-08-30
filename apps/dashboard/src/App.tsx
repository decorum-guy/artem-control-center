import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fixtureScenarios } from "@artem/config";
import type { CoffeeDelayedStartRecord, DashboardSnapshot, ServiceSnapshot } from "@artem/contracts";
import {
  HomePage,
  OverviewPage,
  PlaceholderPage,
  ServicesPage,
  SettingsPage,
  SystemPage
} from "./pages";
import { CalendarPage, RemindersPage, TasksPage } from "./PlanningRoutes";
import {
  planningRouteEnabled
} from "./planningRouteConfig";
import { planningRoutePaths } from "./planningModuleRegistry";
import { reconcileLayout, resolveManifest } from "./registry";
import { ProductShell, type ShellNavigationTarget, type ShellRoutePath } from "./Shell";
import { ErrorBoundary } from "./ErrorBoundary";
import { CoffeeWidget, GenericServiceWidget } from "./widgets";
import { cancelCoffeeDelayedStart, createCoffeeDelayedStart, executeCoffeeAction, getCoffeeDelayedStart } from "./coffeeApi";
import { CoffeeDelayedStartDialog } from "./CoffeeDelayedStartDialog";
import { SnapshotCoordinator } from "./snapshotStream";
import { useActionConfirmation } from "./ActionConfirmations";
import { ConnectivityRecoverySurface } from "./ConnectivityActions";
import { WeatherPage } from "./Weather";
import { B0NoticeFixture, GlobalNoticeRegion, useNoticeCenter } from "./NoticeCenter";
import { v2VisualShellEnabled } from "./visualShellConfig";
import { overviewV2Enabled } from "./overviewConfig";
import { OverviewV2Page } from "./features/overview/OverviewPage";
import { HomeV2Page } from "./features/home/HomeV2Page";
import { ServicesV2Page } from "./features/services/ServicesV2Page";
import { SystemV2Page } from "./features/system/SystemV2Page";
import { SettingsV2Page } from "./features/settings/SettingsV2Page";
import { useInteractionLock } from "./InteractionLock";
import { CoffeeDiaryPage } from "./CoffeeDiaryPage";

type Theme = "day" | "night";
type MotionMode = "full" | "reduced" | "low-performance" | "battery-saving";

const userRoutes: ShellRoutePath[] = [
  "/overview",
  "/weather",
  "/home",
  "/services",
  "/coffee-diary",
  ...planningRoutePaths,
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
  if (requested === "/reminders" && !planningRouteEnabled("/reminders")) {
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
  const { guardMutation } = useInteractionLock();
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
  const [coffeeDelayedStart, setCoffeeDelayedStart] = useState<CoffeeDelayedStartRecord | null>(null);
  const [coffeeDelayedStartCanReplace, setCoffeeDelayedStartCanReplace] = useState(false);
  const [coffeeDelayedStartWritesEnabled, setCoffeeDelayedStartWritesEnabled] = useState(false);
  const [coffeeDelayedStartConfirming, setCoffeeDelayedStartConfirming] = useState(false);
  const [coffeeDelayedStartPending, setCoffeeDelayedStartPending] = useState(false);
  const [coffeeDelayedStartDialogOpen, setCoffeeDelayedStartDialogOpen] = useState(false);
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
  const reconcileSnapshotAfterAction = useCallback(
    () => snapshotCoordinator.current?.refreshAfterCurrent() ?? Promise.resolve(false),
    []
  );

  const refreshCoffeeDelayedStart = useCallback(async () => {
    try {
      const result = await getCoffeeDelayedStart();
      setCoffeeDelayedStart(result.schedule);
      setCoffeeDelayedStartWritesEnabled(result.writesEnabled);
      setCoffeeDelayedStartCanReplace(
        result.writesEnabled
        && result.available
        && result.schedule?.status !== "executing"
      );
      return result.schedule;
    } catch {
      // A failed read-back must not leave a stale confirmed countdown on screen.
      setCoffeeDelayedStart(null);
      setCoffeeDelayedStartCanReplace(false);
      setCoffeeDelayedStartWritesEnabled(false);
      return null;
    }
  }, []);

  const hasSnapshot = snapshot !== null;
  useEffect(() => {
    if (!hasSnapshot) return;
    void refreshCoffeeDelayedStart();
    const timer = window.setInterval(() => void refreshCoffeeDelayedStart(), 10_000);
    return () => window.clearInterval(timer);
  }, [hasSnapshot, refreshCoffeeDelayedStart, scenario]);

  useEffect(() => {
    if (snapshot) void refreshCoffeeDelayedStart();
  }, [refreshCoffeeDelayedStart, snapshot]);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.motion = motion;
  }, [motion]);

  const widgets = useMemo(
    () => (snapshot ? reconcileLayout(snapshot.services) : []),
    [snapshot]
  );

  function navigate(target: ShellNavigationTarget) {
    const nextRoute = typeof target === "string" ? target : target.path;
    const query = new URLSearchParams(import.meta.env.DEV ? window.location.search : "");
    if (typeof target !== "string") {
      const targetQuery = new URLSearchParams(target.search);
      targetQuery.forEach((value, name) => query.set(name, value));
    }
    const search = query.toString();
    window.history.pushState({}, "", `${nextRoute}${search ? `?${search}` : ""}`);
    setRoute(nextRoute);
  }

  async function addFixtureService() {
    if (!guardMutation()) return;
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
    if (!guardMutation()) return;
    if (coffeeActionPending || confirmationOpen) return;
    const action = actionId.endsWith("turn_on") ? "turn_on" : "turn_off";
    if (action === "turn_on") {
      const confirmation = await confirmAction("home.coffee.turn_on");
      if (!confirmation.confirmed) return;
    }
    if (!guardMutation()) return;
    setCoffeeActionPending(true);
    showNotice({
      id: "coffee.action",
      severity: "progress",
      title: service.title,
        detail: "Команда отправлена, проверяем состояние…"
    });
    try {
      const result = await executeCoffeeAction(action, crypto.randomUUID());
      showNotice({
        id: "coffee.action",
        severity: "progress",
        title: service.title,
        detail: "Проверяем новое состояние…"
      });
      const reconciled = await reconcileSnapshot();
      await refreshCoffeeDelayedStart();
      showNotice({
        id: "coffee.action",
        severity: reconciled ? "success" : "warning",
        title: service.title,
        detail: reconciled
          ? `Кофемашина ${result.confirmedState === "on" ? "включена" : "выключена"}.`
          : "Состояние ещё обновляется.",
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

  function openCoffeeDelayedStart(): void {
    if (!guardMutation()) {
      showNotice({
        id: "coffee.delayed-start.locked",
        severity: "warning",
        title: "Панель заблокирована",
        detail: "Удерживайте замок для разблокировки управления.",
        timeoutMs: 6_000
      });
      return;
    }
    setCoffeeDelayedStartDialogOpen(true);
  }

  async function saveCoffeeDelayedStart(delayMinutes: number): Promise<void> {
    if (!guardMutation() || coffeeDelayedStartPending || coffeeDelayedStartConfirming || confirmationOpen) return;
    setCoffeeDelayedStartConfirming(true);
    try {
      const confirmation = await confirmAction("home.coffee.turn_on", {
        target: `Кофемашина · запуск через ${delayMinutes} мин`
      });
      if (!confirmation.confirmed || !guardMutation()) return;
      setCoffeeDelayedStartPending(true);
      const result = await createCoffeeDelayedStart(delayMinutes, crypto.randomUUID());
      setCoffeeDelayedStart(result.schedule);
      setCoffeeDelayedStartWritesEnabled(result.writesEnabled);
      setCoffeeDelayedStartCanReplace(
        result.writesEnabled
        && result.available
        && result.schedule?.status !== "executing"
      );
      await reconcileSnapshot();
      if (result.schedule?.status === "pending" || result.schedule?.status === "executing") {
        showNotice({
          id: "coffee.delayed-start",
          severity: "success",
          title: "Запуск запланирован",
          detail: `Кофемашина включится в ${new Date(result.schedule.dueAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}.`,
          timeoutMs: 6_000
        });
      } else {
        showNotice({
          id: "coffee.delayed-start",
          severity: "warning",
          title: "Состояние запуска требует проверки",
          detail: "Panel Agent вернул терминальный результат; отсчёт не запущен.",
          timeoutMs: 10_000
        });
      }
    } catch (error) {
      await refreshCoffeeDelayedStart();
      throw error;
    } finally {
      setCoffeeDelayedStartPending(false);
      setCoffeeDelayedStartConfirming(false);
    }
  }

  async function cancelCoffeeDelayedStartSchedule(): Promise<void> {
    if (!guardMutation() || coffeeDelayedStartPending) return;
    setCoffeeDelayedStartPending(true);
    try {
      const result = await cancelCoffeeDelayedStart();
      setCoffeeDelayedStart(result.schedule);
      await reconcileSnapshot();
      if (!result.schedule || result.schedule.status === "cancelled") {
        showNotice({
          id: "coffee.delayed-start",
          severity: "success",
          title: "Запуск отменён",
          detail: "Панель получила подтверждение отложенного запуска.",
          timeoutMs: 6_000
        });
      } else if (result.schedule.status === "executing") {
        showNotice({
          id: "coffee.delayed-start",
          severity: "warning",
          title: "Запуск уже выполняется",
          detail: "Отмена больше недоступна; проверяем состояние кофемашины.",
          timeoutMs: 10_000
        });
      } else {
        showNotice({
          id: "coffee.delayed-start",
          severity: "warning",
          title: "Состояние запуска требует проверки",
          detail: "Panel Agent вернул терминальный результат; отсчёт не запущен.",
          timeoutMs: 10_000
        });
      }
    } catch (error) {
      await refreshCoffeeDelayedStart();
      throw error;
    } finally {
      setCoffeeDelayedStartPending(false);
    }
  }

  const appClassName = [
    "app",
    `theme-${theme}`,
    `motion-${motion}`,
    v2VisualShellEnabled ? "v2-shell-enabled" : "",
    kiosk ? "simulated-kiosk" : ""
  ].filter(Boolean).join(" ");
  const v2DensityRoute = v2VisualShellEnabled && ["/home", "/services", "/system"].includes(route);

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
        {!snapshot && !error && <p className="loading">Загружаем данные…</p>}
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
      {!snapshot && !error && <p className="loading">Загружаем данные…</p>}
      {snapshot && (
        <ProductShell route={route} snapshot={snapshot} onNavigate={navigate}>
          {!v2DensityRoute && ((route !== "/overview" || !overviewV2Enabled) && (route === "/overview" || route === "/home" || route === "/services")) && (
            <ConnectivityRecoverySurface
              services={snapshot.services}
              showWhenHealthy={route === "/services"}
            />
          )}
          {route === "/overview" && (
            overviewV2Enabled ? (
              <OverviewV2Page
                snapshot={snapshot}
                onNavigate={navigate}
                onCoffeeAction={(service, actionId) => void runCoffeeAction(service, actionId)}
                coffeeActionPending={coffeeActionPending}
                coffeeDelayedStart={coffeeDelayedStart}
                coffeeDelayedStartPending={coffeeDelayedStartPending || coffeeDelayedStartConfirming}
                onCoffeeDelayedStart={openCoffeeDelayedStart}
              />
            ) : (
              <OverviewPage
                snapshot={snapshot}
                onNavigate={navigate}
                onCoffeeAction={(service, actionId) => void runCoffeeAction(service, actionId)}
                coffeeActionPending={coffeeActionPending}
                coffeeDelayedStart={coffeeDelayedStart}
                coffeeDelayedStartPending={coffeeDelayedStartPending || coffeeDelayedStartConfirming}
                onCoffeeDelayedStart={openCoffeeDelayedStart}
              />
            )
          )}
          {route === "/weather" && <WeatherPage />}
          {route === "/home" && (
            v2VisualShellEnabled ? (
              <HomeV2Page
                snapshot={snapshot}
                onCoffeeAction={(service, actionId) => void runCoffeeAction(service, actionId)}
                coffeeActionPending={coffeeActionPending}
                coffeeDelayedStart={coffeeDelayedStart}
                coffeeDelayedStartPending={coffeeDelayedStartPending || coffeeDelayedStartConfirming}
                onCoffeeDelayedStart={openCoffeeDelayedStart}
              />
            ) : (
              <HomePage
                snapshot={snapshot}
                onNavigate={navigate}
                onCoffeeAction={(service, actionId) => void runCoffeeAction(service, actionId)}
                coffeeActionPending={coffeeActionPending}
                coffeeDelayedStart={coffeeDelayedStart}
                coffeeDelayedStartPending={coffeeDelayedStartPending || coffeeDelayedStartConfirming}
                onCoffeeDelayedStart={openCoffeeDelayedStart}
              />
            )
          )}
          {route === "/services" && (
            v2VisualShellEnabled
              ? <ServicesV2Page snapshot={snapshot} />
              : <ServicesPage snapshot={snapshot} onNavigate={navigate} />
          )}
          {route === "/coffee-diary" && <CoffeeDiaryPage />}
          {route === "/settings" && (
            v2VisualShellEnabled ? (
              <SettingsV2Page
                theme={theme}
                motion={motion}
                calendarSources={snapshot?.planning?.providerStatuses ?? []}
                onThemeChange={setTheme}
                onMotionChange={setMotion}
                onRefreshCalendarMetadata={reconcileSnapshotAfterAction}
              />
            ) : (
              <SettingsPage
                theme={theme}
                motion={motion}
                onThemeChange={setTheme}
                onMotionChange={setMotion}
              />
            )
          )}
          {route === "/system" && (v2VisualShellEnabled ? <SystemV2Page snapshot={snapshot} /> : <SystemPage snapshot={snapshot} />)}
          {route === "/tasks" && (planningRouteEnabled("/tasks") ? <TasksPage snapshot={snapshot} onNavigate={navigate} /> : <PlaceholderPage route="/tasks" />)}
          {route === "/calendar" && (planningRouteEnabled("/calendar") ? <CalendarPage snapshot={snapshot} onNavigate={navigate} /> : <PlaceholderPage route="/calendar" />)}
          {route === "/reminders" && planningRouteEnabled("/reminders") && <RemindersPage snapshot={snapshot} onNavigate={navigate} />}
          {!["/overview", "/weather", "/home", "/services", "/coffee-diary", "/settings", "/system", "/tasks", "/calendar", "/reminders"].includes(route) && (
            <PlaceholderPage route={route as "/backups" | "/apps" | "/system"} />
          )}
        </ProductShell>
      )}
      {coffeeDelayedStartDialogOpen && (
        <CoffeeDelayedStartDialog
          schedule={coffeeDelayedStart}
          saving={coffeeDelayedStartPending || coffeeDelayedStartConfirming}
          canReplace={coffeeDelayedStartCanReplace}
          writesEnabled={coffeeDelayedStartWritesEnabled}
          onCreate={saveCoffeeDelayedStart}
          onCancel={cancelCoffeeDelayedStartSchedule}
          onClose={() => setCoffeeDelayedStartDialogOpen(false)}
        />
      )}
      <GlobalNoticeRegion />
      <B0NoticeFixture />
    </div>
  );
}
