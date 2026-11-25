import type { CoffeeDelayedStartRecord, DashboardSnapshot, ServiceSnapshot } from "@artem/contracts";
import type { ShellNavigationTarget } from "../../Shell";
import type { CoffeeEditorPreviewStage } from "../../coffee";

/** Runtime-only dependencies for trusted, source-owned Overview renderers. */
export interface OverviewRuntimeContext {
  readonly snapshot: DashboardSnapshot;
  readonly onNavigate: (target: ShellNavigationTarget) => void;
  readonly onCoffeeAction: (service: ServiceSnapshot, actionId: string) => void;
  readonly coffeeActionPending: boolean;
  readonly coffeeDelayedStart: CoffeeDelayedStartRecord | null;
  readonly coffeeDelayedStartPending: boolean;
  readonly onCoffeeDelayedStart: () => void;
  readonly editMode: boolean;
  readonly editorPreview?: { readonly instanceId: string; readonly stage: CoffeeEditorPreviewStage } | null;
}
