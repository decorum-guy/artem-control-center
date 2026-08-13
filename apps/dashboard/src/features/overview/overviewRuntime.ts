import type { DashboardSnapshot, ServiceSnapshot } from "@artem/contracts";
import type { ShellRoutePath } from "../../Shell";

/** Runtime-only dependencies for trusted, source-owned Overview renderers. */
export interface OverviewRuntimeContext {
  readonly snapshot: DashboardSnapshot;
  readonly onNavigate: (path: ShellRoutePath) => void;
  readonly onCoffeeAction: (service: ServiceSnapshot, actionId: string) => void;
  readonly coffeeActionPending: boolean;
}
