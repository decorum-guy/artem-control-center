import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { accents, persistAccent, persistColorMode, readAccent, readColorMode } from "../../skin/accent";
import type { Accent } from "../../skin/accent";
import { Icon } from "../../icons";
import { WorkZone } from "../../ShellPrimitives";
import { FullRemote, useTV } from "./TvRemote";
import "../../styles.css";
import "../../skin/skin.css";

function Remote() {
  const controller = useTV("/remote/api");
  const [theme, setTheme] = useState(readColorMode);
  const [accent, setAccent] = useState(readAccent);
  const [code, setCode] = useState("");
  const [loginError, setLoginError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
  }, [theme, accent]);

  const session = async (action: "login" | "logout", event?: FormEvent) => {
    event?.preventDefault();
    setPending(true);
    setLoginError("");
    try {
      const response = await fetch(`/remote/api/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Panel-TV": "1" },
        body: JSON.stringify(action === "login" ? { code } : {}),
        signal: AbortSignal.timeout(8000), cache: "no-store"
      });
      if (!response.ok) throw new Error();
      setCode("");
      await controller.refresh();
    } catch {
      setLoginError(action === "login" ? "Вход не подтверждён. Проверьте код и подключение." : "Выход не подтверждён.");
    } finally {
      setPending(false);
    }
  };

  return <main className="tv-pwa">
    <header className="tv-pwa-header">
      <div className="tv-widget-title"><Icon name="system" size={28} /><h1>Пульт ТВ</h1></div>
      <button type="button" className="tv-button tv-icon-button" aria-label={theme === "night" ? "Дневная тема" : "Ночная тема"} onClick={() => {
        const next = theme === "night" ? "day" : "night";
        setTheme(next);
        persistColorMode(next);
      }}><Icon name={theme === "night" ? "sun" : "moon"} /></button>
    </header>
    <WorkZone className="tv-pwa-panel">
      {!controller.authorized ? <form className="tv-link" onSubmit={(event) => { void session("login", event); }}>
        <label htmlFor="tv-pairing">Код подключения</label>
        <input id="tv-pairing" type="password" autoComplete="current-password" required
          autoCapitalize="off" value={code} onChange={(event) => setCode(event.target.value)} />
        <button className="tv-button" disabled={pending || !code}>Подключить пульт</button>
      </form> : <FullRemote controller={controller} />}
      {loginError && <p className="tv-message" role="alert">{loginError}</p>}
    </WorkZone>
    <footer className="tv-pwa-footer">
      <label>Акцент <select value={accent} onChange={(event) => {
        const next = event.target.value as Accent;
        setAccent(next);
        persistAccent(next);
      }}>{Object.entries(accents).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
      {controller.authorized && <button type="button" className="tv-button" disabled={pending} onClick={() => { void session("logout"); }}>Выйти</button>}
    </footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Remote />);
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const version = new URL(import.meta.url).pathname.split("/").pop() ?? "v1";
  void navigator.serviceWorker.register(`/remote/sw.js?v=${encodeURIComponent(version)}`, { scope: "/remote/" }).catch(() => {});
}
