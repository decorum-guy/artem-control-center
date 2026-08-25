import type { DashboardSnapshot, ServiceSnapshot } from "@artem/contracts";
import { ErrorBoundary } from "../../ErrorBoundary";
import { Icon } from "../../icons";
import { resolveManifest } from "../../registry";
import { StatusText } from "../../ShellPrimitives";
import { CoffeeWidget } from "../../widgets";
import { DeviceRow } from "../operations/DeviceRow";
import {
  healthLabel,
  healthTone,
  homeAuthority,
  selectHomePrimaryDevices
} from "../operations/routeDensity";

export function HomeV2Page({
  snapshot,
  onCoffeeAction,
  coffeeActionPending
}: {
  snapshot: DashboardSnapshot;
  onCoffeeAction: (service: ServiceSnapshot, actionId: string) => void;
  coffeeActionPending: boolean;
}) {
  const selection = selectHomePrimaryDevices(snapshot.services);
  const authority = homeAuthority(snapshot.services);
  const authorityLabel = authority ? healthLabel(authority.health) : "Недоступен";
  const authorityTone = authority ? healthTone(authority.health) : "unavailable";

  return (
    <div className="home-v2-page" data-testid="route-home-v2">
      <header className="density-route-toolbar" data-testid="home-v2-toolbar">
        <h1>Дом</h1>
        <span>Устройства и подтверждённые действия</span>
      </header>

      <section className={`home-authority-line${authority ? ` home-authority-line--${authority.health}` : " home-authority-line--unavailable"}`} data-testid="home-authority-line">
        <span className="home-authority-line__icon" aria-hidden="true"><Icon name="home" /></span>
        <div className="home-authority-line__identity">
          <strong>Home Assistant</strong>
          <StatusText label={authorityLabel} tone={authorityTone} />
        </div>
        <span className="home-authority-line__source">
          {authority?.presentation?.freshnessLabel ?? "Источник состояния не получен"}
        </span>
        <span className="home-authority-line__authority">Источник дома</span>
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
            />
          </ErrorBoundary>
        )}
        {selection.kettle && (
          <ErrorBoundary title={selection.kettle.title}>
            <DeviceRow service={selection.kettle} primary />
          </ErrorBoundary>
        )}
        {!selection.coffee && !selection.kettle && selection.fallback && (
          <ErrorBoundary title={selection.fallback.title}>
            <DeviceRow service={selection.fallback} primary />
          </ErrorBoundary>
        )}
        {!selection.coffee && !selection.kettle && !selection.fallback && (
          <div className="home-v2-empty" data-testid="home-no-devices">
            <Icon name="home" />
            <strong>Домашние устройства не зарегистрированы</strong>
            <span>Устройства пока не найдены.</span>
          </div>
        )}
      </section>

      {selection.additional.length > 0 && (
        <section className="home-v2-secondary-zone" data-testid="home-secondary-devices">
          <header className="density-section-heading">
            <div>
              <p className="section-kicker">Дом</p>
              <h2>Другие устройства</h2>
            </div>
            <span>{selection.additional.length}</span>
          </header>
          <div className="home-v2-device-rows">
            {selection.additional.map((service) => <DeviceRow key={service.id} service={service} />)}
          </div>
        </section>
      )}
    </div>
  );
}
