import type { DashboardSnapshot } from "@artem/contracts";
import type { ReactNode } from "react";
import { RouteHeader } from "../../ShellPrimitives";
import { DashboardGrid } from "./DashboardGrid";
import { overviewFixtureModeFromLocation, overviewFoundationLayout } from "./overviewFixture";

export function OverviewV2Page({ snapshot }: { snapshot: DashboardSnapshot }): ReactNode {
  const fixtureMode = overviewFixtureModeFromLocation();
  return (
    <div className="overview-v2-page" data-testid="route-overview-v2" data-snapshot-mode={snapshot.mode}>
      <RouteHeader
        eyebrow="Операционная панель · PR3 foundation"
        title="Обзор"
        description="Фиксированная сетка и безопасные размеры виджетов. Данные и настройка панели подключаются отдельными этапами."
      />
      <DashboardGrid items={overviewFoundationLayout(fixtureMode)} />
    </div>
  );
}
