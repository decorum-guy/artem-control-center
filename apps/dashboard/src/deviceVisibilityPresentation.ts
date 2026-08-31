import type { DashboardSnapshot, DeviceVisibilitySettings, ServiceSnapshot } from "@artem/contracts";

export const ownerFacingDeviceRegistry = [
  { key: "kettle", serviceId: "kettle", dataContract: "home.kettle.v1", defaultVisible: true }
] as const;

export function visiblePresentationServices(services: readonly ServiceSnapshot[], settings: DeviceVisibilitySettings | null): ServiceSnapshot[] {
  const visibility = settings?.available === true
    ? new Map(settings.devices.map((device) => [device.key, device.visible]))
    : new Map();
  return services.filter((service) => {
    const registered = ownerFacingDeviceRegistry.find((device) => service.id === device.serviceId && service.dataContract === device.dataContract);
    return !registered || visibility.get(registered.key) !== false;
  });
}

export function visiblePresentationSnapshot(snapshot: DashboardSnapshot, settings: DeviceVisibilitySettings | null): DashboardSnapshot {
  return { ...snapshot, services: visiblePresentationServices(snapshot.services, settings) };
}
