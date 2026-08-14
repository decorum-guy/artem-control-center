import type { DashboardSnapshot, ServiceSnapshot } from "@artem/contracts";
import type { ReactNode } from "react";
import type { ShellRoutePath } from "../../Shell";
import { DashboardGrid } from "./DashboardGrid";
import { overviewFixtureModeFromLocation, overviewFoundationLayout } from "./overviewFixture";
import type { OverviewRuntimeContext } from "./overviewRuntime";

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
  const runtime: OverviewRuntimeContext = {
    snapshot,
    onNavigate,
    onCoffeeAction,
    coffeeActionPending
  };
  return (
    <div className="overview-v2-page" data-testid="route-overview-v2" data-snapshot-mode={snapshot.mode}>
      <header className="overview-v2-toolbar" data-testid="overview-toolbar">
        <div className="overview-v2-toolbar__copy">
          <h1>Обзор</h1>
          <p>Сегодня, всё важное в первом экране</p>
        </div>
        <button
          type="button"
          className="overview-v2-toolbar__configure"
          disabled
          aria-disabled="true"
          aria-describedby="overview-configure-note"
          data-testid="overview-configure"
          title="Настройка появится в следующем этапе"
        >
          Настроить
        </button>
        <span id="overview-configure-note" className="overview-v2-toolbar__note">
          Настройка панели пока не активна.
        </span>
      </header>
      <DashboardGrid items={overviewFoundationLayout(fixtureMode)} runtime={runtime} />
    </div>
  );
}
