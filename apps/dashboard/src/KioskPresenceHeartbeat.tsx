import { useEffect } from "react";

const HEARTBEAT_INTERVAL_MS = 1_000;
const PAGE_ID = crypto.randomUUID().replaceAll("-", "").slice(0, 24);

async function sendVisiblePresence() {
  if (document.visibilityState !== "visible") return;
  try {
    await fetch("/api/v1/system/runtime/kiosk-presence", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-panel-intent": "kiosk-presence"
      },
      body: JSON.stringify({ pageId: PAGE_ID }),
      cache: "no-store",
      keepalive: true
    });
  } catch {
    // Presence is advisory for the Windows kiosk launcher. A transient local
    // runtime gap must never interrupt the dashboard itself.
  }
}

export function KioskPresenceHeartbeat() {
  useEffect(() => {
    const report = () => {
      void sendVisiblePresence();
    };

    report();
    const interval = window.setInterval(report, HEARTBEAT_INTERVAL_MS);
    document.addEventListener("visibilitychange", report);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", report);
    };
  }, []);

  return null;
}
