import type { ServiceSnapshot } from "@artem/contracts";
import { Icon, type IconName } from "../../icons";
import { StatusText } from "../../ShellPrimitives";
import { healthLabel, healthTone } from "./routeDensity";

function iconForService(service: ServiceSnapshot): IconName {
  switch (service.presentation?.category) {
    case "home-infrastructure":
    case "home-device":
      return "home";
    case "work":
    case "personal-infrastructure":
    case "external":
      return "services";
    case "system":
      return "system";
    default:
      return "services";
  }
}
export function HealthRow({
  service,
  onDetails
}: {
  service: ServiceSnapshot;
  onDetails: () => void;
}) {
  const freshness = service.presentation?.freshnessLabel;
  return (
    <div
      className={`health-row health-row--${service.health}`}
      data-testid={`health-row-${service.id}`}
      data-health={service.health}
    >
      <span className="health-row__icon" aria-hidden="true"><Icon name={iconForService(service)} /></span>
      <div className="health-row__identity">
        <h3>{service.title}</h3>
        <StatusText label={healthLabel(service.health)} tone={healthTone(service.health)} />
      </div>
      <div className="health-row__summary">
        <span>{freshness ?? service.summary}</span>
        {freshness && <span>{service.summary}</span>}
      </div>
      <button
        type="button"
        className="health-row__details"
        aria-label={`Подробнее: ${service.title}`}
        onClick={onDetails}
      >
        Подробнее
      </button>
    </div>
  );
}
