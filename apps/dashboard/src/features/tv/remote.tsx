import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { accents, persistAccent, persistColorMode, readAccent, readColorMode } from "../../skin/accent";
import type { Accent } from "../../skin/accent";
import { Icon } from "../../icons";
import { WorkZone } from "../../ShellPrimitives";
import { FullRemote } from "./TvRemote";
import { useTV } from "./useTV";
import { Button, Select } from "../../ui/Controls";
import "../../styles.css";
import "../../skin/skin.css";

const bundle = new URL(import.meta.url).pathname.split("/").pop() ?? "v1";
const workerPath = `/remote/sw.js?v=${encodeURIComponent(bundle)}`;

function currentWorker() {
  const worker = navigator.serviceWorker?.controller;
  return worker ? new URL(worker.scriptURL).searchParams.get("v") === bundle : false;
}

function Remote() {
  const controller = useTV("/remote/api");
  const [theme, setTheme] = useState(readColorMode);
  const [accent, setAccent] = useState(readAccent);
  const [code, setCode] = useState("");
  const [loginError, setLoginError] = useState("");
  const [pending, setPending] = useState(false);
  const [cacheCurrent, setCacheCurrent] = useState(currentWorker);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content",
      getComputedStyle(document.documentElement).getPropertyValue("--cc-canvas").trim());
  }, [theme, accent]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const updateHeight = () => {
      if (viewport.scale === 1) {
        document.documentElement.style.setProperty("--tv-viewport-height", `${viewport.height}px`);
      }
    };
    updateHeight();
    viewport.addEventListener("resize", updateHeight);
    return () => viewport.removeEventListener("resize", updateHeight);
  }, []);

  useEffect(() => {
    const worker = navigator.serviceWorker;
    const update = () => setCacheCurrent(currentWorker());
    worker?.addEventListener("controllerchange", update);
    update();
    return () => worker?.removeEventListener("controllerchange", update);
  }, []);

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
      controller.changeSession(action === "login");
      if (action === "login") await controller.refresh();
    } catch {
      setLoginError(action === "login" ? "Вход не подтверждён. Проверьте код и подключение." : "Выход не подтверждён.");
    } finally {
      setPending(false);
    }
  };

  return <main className={`app skin-v3 tv-pwa theme-${theme}`}>
    <header className="tv-pwa-header">
      <div className="tv-widget-title"><Icon name="television" size={28} /><h1>Пульт ТВ</h1></div>
      <Button className="tv-icon-button" aria-label={theme === "night" ? "Дневная тема" : "Ночная тема"} onClick={() => {
        const next = theme === "night" ? "day" : "night";
        setTheme(next);
        persistColorMode(next);
      }}><Icon name={theme === "night" ? "sun" : "moon"} /></Button>
    </header>
    <WorkZone className="tv-pwa-panel">
      {!controller.authorized ? <form className="tv-link" onSubmit={(event) => { void session("login", event); }}>
        <label htmlFor="tv-pairing">Код подключения</label>
        <input id="tv-pairing" type="password" autoComplete="current-password" required
          autoCapitalize="off" value={code} onChange={(event) => setCode(event.target.value)} />
        <Button type="submit" variant="primary" disabled={pending || !code}>Подключить пульт</Button>
      </form> : <FullRemote controller={controller} nativeLinkTargets clipboardPaste />}
      {loginError && <p className="tv-message" role="alert">{loginError}</p>}
    </WorkZone>
    <footer className="tv-pwa-footer">
      <Select compact label="Акцент" value={accent} options={Object.entries(accents).map(([value, label]) => ({ value, label }))}
        onChange={(value) => {
          const next = value as Accent;
          setAccent(next);
          persistAccent(next);
        }} />
      {controller.authorized && <Button disabled={pending} onClick={() => { void session("logout"); }}>Выйти</Button>}
    </footer>
    {import.meta.env.PROD && <p className="tv-pwa-build">Сборка {bundle.replace(/^tvRemote-/, "").replace(/\.js$/, "")}
      {cacheCurrent ? "" : " · кэш не подтверждён"}</p>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Remote />);
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register(workerPath, { scope: "/remote/" }).catch(() => {});
}
