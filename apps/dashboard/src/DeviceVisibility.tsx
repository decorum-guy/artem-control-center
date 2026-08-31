import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DeviceVisibilitySettings, OwnerFacingDeviceKey } from "@artem/contracts";
import { getDeviceVisibility, patchDeviceVisibility } from "./deviceVisibilityApi";

interface DeviceVisibilityContextValue {
  settings: DeviceVisibilitySettings | null;
  loading: boolean;
  refresh: () => Promise<void>;
  save: (entry: { deviceKey: OwnerFacingDeviceKey; visible: boolean }) => Promise<DeviceVisibilitySettings>;
}

const DeviceVisibilityContext = createContext<DeviceVisibilityContextValue | null>(null);

export function DeviceVisibilityProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<DeviceVisibilitySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setSettings(await getDeviceVisibility()); } catch { setSettings(null); } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const onCapabilitiesChanged = () => void refresh();
    window.addEventListener("artem-capabilities-changed", onCapabilitiesChanged);
    return () => window.removeEventListener("artem-capabilities-changed", onCapabilitiesChanged);
  }, [refresh]);
  const save = useCallback(async (entry: { deviceKey: OwnerFacingDeviceKey; visible: boolean }) => {
    if (!settings) throw new Error("device_visibility_unavailable");
    const saved = await patchDeviceVisibility({ expectedRevision: settings.revision, ...entry });
    setSettings(saved);
    return saved;
  }, [settings]);
  const value = useMemo(() => ({ settings, loading, refresh, save }), [settings, loading, refresh, save]);
  return <DeviceVisibilityContext.Provider value={value}>{children}</DeviceVisibilityContext.Provider>;
}

export function useDeviceVisibility(): DeviceVisibilityContextValue {
  const value = useContext(DeviceVisibilityContext);
  if (!value) throw new Error("useDeviceVisibility must be used inside DeviceVisibilityProvider");
  return value;
}
