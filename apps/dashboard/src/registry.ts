import type {
  MaterializedWidget,
  ServiceSnapshot,
  WidgetManifest
} from "@artem/contracts";

export const widgetManifests: WidgetManifest[] = [
  {
    id: "home.coffee-machine",
    kind: "specialized",
    supportedDataContracts: ["home.coffee-machine.v1"],
    settingsSchema: {
      showRemainingTime: { type: "boolean", default: true },
      showAuthority: { type: "boolean", default: true }
    },
    defaultSection: "overview",
    defaultPriority: 100,
    visualAsset: {
      type: "image",
      sourcePath: "./assets/widgets/coffee-machine.png",
      fit: "contain",
      alt: "Кофемашина"
    }
  },
  {
    id: "home.kettle",
    kind: "specialized",
    supportedDataContracts: ["home.kettle.v1"],
    settingsSchema: {},
    defaultSection: "home",
    defaultPriority: 70
  },
  {
    id: "core.generic-service",
    kind: "generic",
    supportedDataContracts: ["*"],
    settingsSchema: {},
    defaultSection: "new-items",
    defaultPriority: 0
  }
];

export function resolveManifest(service: ServiceSnapshot): WidgetManifest {
  return (
    widgetManifests.find(
      (manifest) =>
        manifest.kind === "specialized" &&
        manifest.supportedDataContracts.includes(service.dataContract)
    ) ?? widgetManifests.find((manifest) => manifest.id === "core.generic-service")!
  );
}

export function reconcileLayout(
  services: ServiceSnapshot[],
  existing: MaterializedWidget[] = []
): MaterializedWidget[] {
  const enabled = services.filter((service) => service.enabled);
  const byService = new Map(existing.map((widget) => [widget.serviceId, widget]));

  return enabled.map((service) => {
    const current = byService.get(service.id);
    if (current) return { ...current, preserved: true };
    const manifest = resolveManifest(service);
    return {
      id: `auto.${service.id}`,
      serviceId: service.id,
      manifestId: manifest.id,
      section: manifest.defaultSection,
      preserved: false
    };
  });
}

export function servicesByPriority(services: ServiceSnapshot[]): ServiceSnapshot[] {
  return [...services]
    .filter((service) => service.enabled)
    .sort(
      (left, right) =>
        (right.presentation?.priority ?? resolveManifest(right).defaultPriority) -
        (left.presentation?.priority ?? resolveManifest(left).defaultPriority)
    );
}
