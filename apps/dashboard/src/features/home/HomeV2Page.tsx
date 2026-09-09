import type { CoffeeDelayedStartRecord, DashboardSnapshot, ServiceSnapshot } from "@artem/contracts";
import { ErrorBoundary } from "../../ErrorBoundary";
import { Icon } from "../../icons";
import { resolveManifest } from "../../registry";
import { RouteHeader, SectionHeader, StatusText } from "../../ShellPrimitives";
import { CoffeeWidget } from "../../widgets";
import { ClimateControl } from "../../ClimateControl";
import { RogG703HomeControl } from "../../RogG703Controls";
import { RogPsuControls } from "../../RogPsuControls";
import { DeviceRow } from "../operations/DeviceRow";
import { useInterfaceCopy } from "../../interfaceCopy";
import {
  healthLabel,
  healthTone,
  homeAuthority,
  selectHomeAsusServices,
  selectHomePrimaryDevices
} from "../operations/routeDensity";

export function HomeV2Page({
  snapshot,
  onCoffeeAction,
  coffeeActionPending,
  coffeeDelayedStart,
  coffeeDelayedStartPending,
  onCoffeeDelayedStart
}: {
  snapshot: DashboardSnapshot;
  onCoffeeAction: (service: ServiceSnapshot, actionId: string) => void;
  coffeeActionPending: boolean;
  coffeeDelayedStart?: CoffeeDelayedStartRecord | null;
  coffeeDelayedStartPending?: boolean;
  onCoffeeDelayedStart?: () => void;
}) {
  const { copy } = useInterfaceCopy();
  const selection = selectHomePrimaryDevices(snapshot.services);
  const asus = selectHomeAsusServices(snapshot.services);
  const authority = homeAuthority(snapshot.services);
  const authorityLabel = authority ? healthLabel(authority.health) : "Недоступен";
  const authorityTone = authority ? healthTone(authority.health) : "unavailable";

  return (
    <div className="home-v2-page" data-testid="route-home-v2">
      <RouteHeader
        variant="compact"
        title={copy("page.home.title")}
        description={copy("page.home.subtitle")}
        data-testid="home-v2-toolbar"
      />

      <section className={`home-authority-line${authority ? ` home-authority-line--${authority.health}` : " home-authority-line--unavailable"}`} data-testid="home-authority-line">
        <span className="home-authority-line__icon" aria-hidden="true"><Icon name="home" /></span>
        <div className="home-authority-line__identity">
          <strong>Home Assistant</strong>
          <StatusText label={authorityLabel} tone={authorityTone} />
        </div>
        {authority && authority.health !== "healthy" && authority.presentation?.freshnessLabel && (
          <span className="home-authority-line__freshness">
            {authority.presentation.freshnessLabel}
          </span>
        )}
      </section>

      <section className="home-v2-primary-grid" data-testid="home-primary-grid" aria-label="Основные устройства дома">
        {selection.coffee && (
          <ErrorBoundary title={selection.coffee.title}>
            <CoffeeWidget
              service={selection.coffee}
              generatedAt={snapshot.generatedAt}
              manifest={resolveManifest(selection.coffee)}
              variant="home-v2"
              onAction={onCoffeeAction}
              actionPending={coffeeActionPending}
              delayedStart={coffeeDelayedStart}
              delayedStartPending={coffeeDelayedStartPending}
              onDelayedStart={onCoffeeDelayedStart}
            />
          </ErrorBoundary>
        )}
        {selection.climate && (
          <ErrorBoundary title={selection.climate.title}>
            <ClimateControl service={selection.climate} variant="home" />
          </ErrorBoundary>
        )}
        {selection.kettle && !selection.climate && (
          <ErrorBoundary title={selection.kettle.title}>
            <DeviceRow service={selection.kettle} primary />
          </ErrorBoundary>
        )}
        {!selection.coffee && !selection.climate && !selection.kettle && selection.fallback && (
          <ErrorBoundary title={selection.fallback.title}>
            <DeviceRow service={selection.fallback} primary />
          </ErrorBoundary>
        )}
        {!selection.coffee && !selection.climate && !selection.kettle && !selection.fallback && (
          <div className="home-v2-empty" data-testid="home-no-devices">
            <Icon name="home" />
            <strong>Домашние устройства не зарегистрированы</strong>
            <span>Устройства пока не найдены.</span>
          </div>
        )}
      </section>

      {(asus.rog || asus.rogPsu) && (
        <section className="home-v2-asus-zone" data-testid="home-asus-zone" aria-labelledby="home-asus-zone-title">
          <header className="home-v2-asus-zone__header">
            <span className="home-v2-asus-zone__icon" aria-hidden="true"><Icon name="home" /></span>
            <div>
              <h2 id="home-asus-zone-title">ASUS ROG G703GI</h2>
              <span>Домашняя зона</span>
            </div>
          </header>
          <div className="home-v2-asus-zone__grid">
            {asus.rog && (
              <ErrorBoundary title={asus.rog.title}>
                <RogG703HomeControl service={asus.rog} />
              </ErrorBoundary>
            )}
            {asus.rogPsu && (
              <ErrorBoundary title={asus.rogPsu.title}>
                <RogPsuControls service={asus.rogPsu} variant="home" />
              </ErrorBoundary>
            )}
          </div>
        </section>
      )}

      {selection.additional.length > 0 && (
        <section className="home-v2-secondary-zone" data-testid="home-secondary-devices">
          <SectionHeader eyebrow="Дом" title="Другие устройства" metadata={selection.additional.length} />
          <div className="home-v2-device-rows">
            {selection.additional.map((service) => <DeviceRow key={service.id} service={service} />)}
          </div>
        </section>
      )}
    </div>
  );
}
