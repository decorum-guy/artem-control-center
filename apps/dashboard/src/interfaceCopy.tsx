import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { interfaceCopyCatalog } from "@artem/config";
import type {
  InterfaceCopyCatalog,
  InterfaceCopyField,
  InterfaceCopyOverrides,
  InterfaceCopyPageKey,
  InterfaceCopySettings
} from "@artem/contracts";
import { getInterfaceCopy, patchInterfaceCopy, InterfaceCopyApiError } from "./interfaceCopyApi";

export const defaultInterfaceCopyCatalog: InterfaceCopyCatalog = interfaceCopyCatalog;

export function copyFromCatalog(catalog: InterfaceCopyCatalog, field: InterfaceCopyField): string {
  switch (field) {
    case "navigation.overview": return catalog.navigation.overview;
    case "navigation.weather": return catalog.navigation.weather;
    case "navigation.home": return catalog.navigation.home;
    case "navigation.services": return catalog.navigation.services;
    case "navigation.calendar": return catalog.navigation.calendar;
    case "navigation.tasks": return catalog.navigation.tasks;
    case "navigation.reminders": return catalog.navigation.reminders;
    case "navigation.backups": return catalog.navigation.backups;
    case "navigation.apps": return catalog.navigation.apps;
    case "navigation.system": return catalog.navigation.system;
    case "navigation.settings": return catalog.navigation.settings;
    case "navigationGroup.planning": return catalog.navigationGroup.planning;
    case "page.overview.title": return catalog.page.overview.title;
    case "page.overview.subtitle": return catalog.page.overview.subtitle;
    case "page.weather.title": return catalog.page.weather.title;
    case "page.weather.subtitle": return catalog.page.weather.subtitle;
    case "page.home.title": return catalog.page.home.title;
    case "page.home.subtitle": return catalog.page.home.subtitle;
    case "page.services.title": return catalog.page.services.title;
    case "page.services.subtitle": return catalog.page.services.subtitle;
    case "page.calendar.title": return catalog.page.calendar.title;
    case "page.calendar.subtitle": return catalog.page.calendar.subtitle;
    case "page.tasks.title": return catalog.page.tasks.title;
    case "page.tasks.subtitle": return catalog.page.tasks.subtitle;
    case "page.reminders.title": return catalog.page.reminders.title;
    case "page.reminders.subtitle": return catalog.page.reminders.subtitle;
    case "page.backups.title": return catalog.page.backups.title;
    case "page.backups.subtitle": return catalog.page.backups.subtitle;
    case "page.apps.title": return catalog.page.apps.title;
    case "page.apps.subtitle": return catalog.page.apps.subtitle;
    case "page.system.title": return catalog.page.system.title;
    case "page.system.subtitle": return catalog.page.system.subtitle;
    case "page.settings.title": return catalog.page.settings.title;
    case "page.settings.subtitle": return catalog.page.settings.subtitle;
  }
}

export function pageTitleField(pageKey: InterfaceCopyPageKey): InterfaceCopyField {
  return `page.${pageKey}.title`;
}

export function pageSubtitleField(pageKey: InterfaceCopyPageKey): InterfaceCopyField {
  return `page.${pageKey}.subtitle`;
}

export function copyOverrideValue(overrides: InterfaceCopyOverrides, field: InterfaceCopyField): string | null {
  switch (field) {
    case "navigation.overview": return overrides.navigation.overview ?? null;
    case "navigation.weather": return overrides.navigation.weather ?? null;
    case "navigation.home": return overrides.navigation.home ?? null;
    case "navigation.services": return overrides.navigation.services ?? null;
    case "navigation.calendar": return overrides.navigation.calendar ?? null;
    case "navigation.tasks": return overrides.navigation.tasks ?? null;
    case "navigation.reminders": return overrides.navigation.reminders ?? null;
    case "navigation.backups": return overrides.navigation.backups ?? null;
    case "navigation.apps": return overrides.navigation.apps ?? null;
    case "navigation.system": return overrides.navigation.system ?? null;
    case "navigation.settings": return overrides.navigation.settings ?? null;
    case "navigationGroup.planning": return overrides.navigationGroup.planning ?? null;
    case "page.overview.title": return overrides.page.overview.title ?? null;
    case "page.overview.subtitle": return overrides.page.overview.subtitle ?? null;
    case "page.weather.title": return overrides.page.weather.title ?? null;
    case "page.weather.subtitle": return overrides.page.weather.subtitle ?? null;
    case "page.home.title": return overrides.page.home.title ?? null;
    case "page.home.subtitle": return overrides.page.home.subtitle ?? null;
    case "page.services.title": return overrides.page.services.title ?? null;
    case "page.services.subtitle": return overrides.page.services.subtitle ?? null;
    case "page.calendar.title": return overrides.page.calendar.title ?? null;
    case "page.calendar.subtitle": return overrides.page.calendar.subtitle ?? null;
    case "page.tasks.title": return overrides.page.tasks.title ?? null;
    case "page.tasks.subtitle": return overrides.page.tasks.subtitle ?? null;
    case "page.reminders.title": return overrides.page.reminders.title ?? null;
    case "page.reminders.subtitle": return overrides.page.reminders.subtitle ?? null;
    case "page.backups.title": return overrides.page.backups.title ?? null;
    case "page.backups.subtitle": return overrides.page.backups.subtitle ?? null;
    case "page.apps.title": return overrides.page.apps.title ?? null;
    case "page.apps.subtitle": return overrides.page.apps.subtitle ?? null;
    case "page.system.title": return overrides.page.system.title ?? null;
    case "page.system.subtitle": return overrides.page.system.subtitle ?? null;
    case "page.settings.title": return overrides.page.settings.title ?? null;
    case "page.settings.subtitle": return overrides.page.settings.subtitle ?? null;
  }
}

function defaultSettings(): InterfaceCopySettings {
  return {
    schemaVersion: "interface.copy-settings.v1",
    revision: 0,
    recoveryRevision: null,
    updatedAt: "1970-01-01T00:00:00Z",
    defaults: defaultInterfaceCopyCatalog,
    overrides: {
      navigation: {},
      navigationGroup: {},
      page: {
        overview: {}, weather: {}, home: {}, services: {}, calendar: {}, tasks: {},
        reminders: {}, backups: {}, apps: {}, system: {}, settings: {}
      }
    },
    effective: defaultInterfaceCopyCatalog,
    available: false,
    warnings: [],
    writesEnabled: false
  };
}

interface InterfaceCopyContextValue {
  settings: InterfaceCopySettings;
  loading: boolean;
  error: string | null;
  pending: InterfaceCopyField | "reset-all" | null;
  refresh: () => Promise<InterfaceCopySettings>;
  update: (field: InterfaceCopyField, value: string) => Promise<InterfaceCopySettings>;
  reset: (field: InterfaceCopyField) => Promise<InterfaceCopySettings>;
  resetAll: () => Promise<InterfaceCopySettings>;
  copy: (field: InterfaceCopyField) => string;
}

const InterfaceCopyContext = createContext<InterfaceCopyContextValue | null>(null);

export function InterfaceCopyProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<InterfaceCopyField | "reset-all" | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getInterfaceCopy();
      setSettings(next);
      setError(null);
      return next;
    } catch (reason) {
      setSettings(defaultSettings());
      setError(reason instanceof Error ? reason.message : "interface_copy_unavailable");
      return defaultSettings();
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const mutate = useCallback(async (field: InterfaceCopyField | "reset-all", value: string | null, resetAll = false) => {
    if (pending) throw new Error("interface_copy_write_pending");
    const recoveryReset = resetAll && !settings.available && settings.recoveryRevision !== null;
    if (!settings.writesEnabled || (!settings.available && !recoveryReset)) throw new Error("interface_copy_write_disabled");
    setPending(field);
    try {
      const next = await patchInterfaceCopy({
        expectedRevision: settings.revision,
        ...(resetAll ? { resetAll: true } : { field: field as InterfaceCopyField, value })
      });
      setSettings(next);
      setError(null);
      return next;
    } catch (reason) {
      if (reason instanceof InterfaceCopyApiError && reason.code === "revision_conflict") {
        await refresh();
      }
      throw reason;
    } finally {
      setPending(null);
    }
  }, [pending, refresh, settings]);

  const update = useCallback((field: InterfaceCopyField, value: string) => mutate(field, value), [mutate]);
  const reset = useCallback((field: InterfaceCopyField) => mutate(field, null), [mutate]);
  const resetAll = useCallback(() => mutate("reset-all", null, true), [mutate]);
  const copy = useCallback((field: InterfaceCopyField) => copyFromCatalog(settings.effective, field), [settings.effective]);

  const value = useMemo(() => ({ settings, loading, error, pending, refresh, update, reset, resetAll, copy }), [copy, error, loading, pending, refresh, reset, resetAll, settings, update]);
  return <InterfaceCopyContext.Provider value={value}>{children}</InterfaceCopyContext.Provider>;
}

export function useInterfaceCopy(): InterfaceCopyContextValue {
  const value = useContext(InterfaceCopyContext);
  if (!value) throw new Error("useInterfaceCopy must be used inside InterfaceCopyProvider");
  return value;
}
