import type { ComponentType } from "react";
import type { ServiceSnapshot } from "@artem/contracts";
import { LightStripControl } from "./LightStripControl";
import { resolveManifest } from "./registry";

const homeWidgetComponents: Record<string, ComponentType<{ service: ServiceSnapshot }>> = {
  "home.light-strip": LightStripControl
};

export function HomeWidgetRenderer({ service }: { service: ServiceSnapshot }) {
  const Component = homeWidgetComponents[resolveManifest(service).id];
  return Component ? <Component service={service} /> : null;
}
