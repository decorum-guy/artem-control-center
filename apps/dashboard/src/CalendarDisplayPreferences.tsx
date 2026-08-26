import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CalendarDisplayPreferences } from "@artem/contracts";
import { getCalendarDisplayPreferences, patchCalendarDisplayPreference } from "./calendarDisplayPreferencesApi";

interface CalendarDisplayPreferencesContextValue {
  preferences: CalendarDisplayPreferences | null;
  loading: boolean;
  refresh: () => Promise<void>;
  save: (entry: { providerId: string; calendarId: string; color: string | null }) => Promise<CalendarDisplayPreferences>;
}

const CalendarDisplayPreferencesContext = createContext<CalendarDisplayPreferencesContextValue | null>(null);

export function CalendarDisplayPreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<CalendarDisplayPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setPreferences(await getCalendarDisplayPreferences()); } catch { setPreferences(null); } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const onCapabilitiesChanged = () => void refresh();
    window.addEventListener("artem-capabilities-changed", onCapabilitiesChanged);
    return () => window.removeEventListener("artem-capabilities-changed", onCapabilitiesChanged);
  }, [refresh]);
  const save = useCallback(async (entry: { providerId: string; calendarId: string; color: string | null }) => {
    if (!preferences) throw new Error("preferences_unavailable");
    const saved = await patchCalendarDisplayPreference({ expectedRevision: preferences.revision, ...entry });
    setPreferences(saved);
    return saved;
  }, [preferences]);
  const value = useMemo(() => ({ preferences, loading, refresh, save }), [preferences, loading, refresh, save]);
  return <CalendarDisplayPreferencesContext.Provider value={value}>{children}</CalendarDisplayPreferencesContext.Provider>;
}

export function useCalendarDisplayPreferences(): CalendarDisplayPreferencesContextValue {
  const value = useContext(CalendarDisplayPreferencesContext);
  if (!value) throw new Error("useCalendarDisplayPreferences must be used inside CalendarDisplayPreferencesProvider");
  return value;
}
