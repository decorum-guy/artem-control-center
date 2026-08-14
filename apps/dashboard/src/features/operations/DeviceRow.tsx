import type { ServiceSnapshot } from "@artem/contracts";
import { Icon } from "../../icons";
import { StatusText } from "../../ShellPrimitives";
import { healthLabel, healthTone, homeDeviceState } from "./routeDensity";

export function DeviceRow({
  service,
  primary = false
}: {
  service: ServiceSnapshot;
  primary?: boolean;
}) {
  const actionTitles = service.actions.filter((action) => action.enabled).map((action) => action.title);
  return (
    <article
      className={`device-row${primary ? " device-row--primary" : ""}`}
      data-testid={`device-row-${service.id}`}
      data-device-id={service.id}
    >
      <span className="device-row__icon" aria-hidden="true"><Icon name="home" /></span>
      <div className="device-row__identity">
        <h3>{service.title}</h3>
        <span>{homeDeviceState(service)}</span>
      </div>
      <div className="device-row__status">
        <StatusText label={healthLabel(service.health)} tone={healthTone(service.health)} />
        {service.presentation?.freshnessLabel && <span>{service.presentation.freshnessLabel}</span>}
      </div>
      <div className="device-row__capabilities">
        {actionTitles.length
          ? <span>Зарегистрировано: {actionTitles.join(", ")}</span>
          : <span>Управление не предусмотрено</span>}
      </div>
    </article>
  );
}
