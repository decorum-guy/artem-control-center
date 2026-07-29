import { useCallback, useEffect, useMemo, useState } from "react";
import { fixtureScenarios } from "@artem/config";
import type { DashboardSnapshot, ServiceSnapshot } from "@artem/contracts";
import {
  HomePage,
  OverviewPage,
  PlaceholderPage,
  ServicesPage,
  SettingsPage
} from "./pages";
import { reconcileLayout, resolveManifest } from "./registry";
import { ProductShell, type RoutePath } from "./Shell";
import { ErrorBoundary } from "./ErrorBoundary";
import { CoffeeWidget, GenericServiceWidget } from "./widgets";

type Theme = "day" | "night";
type MotionMode = "full" | "reduced" | "low-performance" | "battery-saving";

const userRoutes: RoutePath[] = [
  "/overview",
  "/home",
  "/services",
  "/calendar",
  "/tasks",
  "/backups",
  "/apps",
  "/settings",
  "/system"
];

function routeFromLocation(): RoutePath {
  if (window.location.pathname === "/") {
    window.history.replaceState({}, "", `/overview${window.location.search}`);
    return "/overview";
  }
  const requested = window.location.pathname as RoutePath;
  return [...userRoutes, "/dev/widget-gallery"].includes(requested) ? requested : "/overview";
}

function querySetting<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = new URLSearchParams(window.location.search).get(name);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function App() {
  const [route, setRoute] = useState<RoutePath>(routeFromLocation);
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
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/snapshot?scenario=${encodeURIComponent(scenario)}`);
      if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
      setSnapshot((await response.json()) as DashboardSnapshot);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Snapshot unavailable");
    }
  }, [scenario]);

  useEffect(() => {
    void load();
  }, [load]);

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

  function navigate(nextRoute: RoutePath) {
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
    await load();
  }

  function explainSafeAction(service: ServiceSnapshot, actionId: string) {
    setActionNotice(
      `${service.title}: ${actionId} не отправлена — production actions отключены в foundation.`
    );
    window.setTimeout(() => setActionNotice(null), 5000);
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
          {route === "/overview" && (
            <OverviewPage
              snapshot={snapshot}
              onNavigate={navigate}
              onCoffeeAction={explainSafeAction}
            />
          )}
          {route === "/home" && (
            <HomePage
              snapshot={snapshot}
              onNavigate={navigate}
              onCoffeeAction={explainSafeAction}
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
          {!["/overview", "/home", "/services", "/settings"].includes(route) && (
            <PlaceholderPage route={route as "/calendar" | "/tasks" | "/backups" | "/apps" | "/system"} />
          )}
        </ProductShell>
      )}
      {actionNotice && <div className="action-notice" role="status">{actionNotice}</div>}
    </div>
  );
}
