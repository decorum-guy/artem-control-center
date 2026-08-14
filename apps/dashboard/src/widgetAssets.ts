const discoveredAssets = import.meta.glob("./assets/widgets/*.{png,webp}", {
  eager: true,
  query: "?url",
  import: "default"
}) as Record<string, string>;

export function resolveWidgetAsset(sourcePath: string): string | null {
  return discoveredAssets[sourcePath] ?? null;
}
