const discoveredAssets = import.meta.glob("./assets/widgets/*.{png,webp}", {
  eager: true,
  query: "?url",
  import: "default"
}) as Record<string, string>;

const panelAssets: Record<string, string> = {
  "./assets/widgets/coffee-machine.png": "./assets/widgets/coffee-machine-panel.webp",
  "./assets/widgets/station-mini-2.png": "./assets/widgets/station-mini-2-panel.webp"
};

export function resolveWidgetAsset(sourcePath: string, panelSize = false): string | null {
  return (panelSize ? discoveredAssets[panelAssets[sourcePath]] : null) ?? discoveredAssets[sourcePath] ?? null;
}
