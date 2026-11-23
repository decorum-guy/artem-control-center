"""An isolated loopback monitor for the tested Mini 2, with one-time DPAPI input."""

import argparse
import asyncio
import ctypes
import json
import os
import sys
from contextlib import asynccontextmanager
from ctypes import wintypes
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from panel_agent.snapshot import SnapshotPublisher

from panel_agent.station_playback import StationPlaybackCollector, StationPlaybackSettings, build_station_playback_router
from panel_agent.station_retention import StationRetentionRecorder


class Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def dpapi(data: bytes, *, decrypt: bool) -> bytes:
    source = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    incoming = Blob(len(data), source)
    result = Blob()
    method = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    if not method(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(result)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        free = ctypes.windll.kernel32.LocalFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = ctypes.c_void_p
        free(result.data)


PAGE = """<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Замеры Станции</title>
<style>body{color:#eff5ff;background:#080e17;font:17px system-ui;max-width:36rem;margin:3rem auto;padding:1rem}
li{margin:.45rem 0}</style>
<main><h1>Замеры паузы Станции</h1><p id="state">Подключение…</p><p id="summary"></p><ul id="samples"></ul></main>
<script>
const labels={paused:'Пауза / стоп',playing:'Играет',auth_required:'Требуется вход',stale:'Связь потеряна',
 idle:'Нет трека',connecting:'Подключение',cleared:'Трек исчез',new_media:'Сменилось медиа',
 resumed:'Воспроизведение продолжилось',signal_lost:'Связь потеряна'};
const seconds=s=>s.toLocaleString('ru-RU',{maximumFractionDigits:1})+' с';
async function render(){
 try{
  const r=await fetch('/status',{cache:'no-store'}); if(!r.ok) throw Error();
  const d=await r.json(); const h=d.retention;
  const list=h.samples.filter(x=>x.outcome==='cleared').map(x=>x.seconds).sort((a,b)=>a-b);
  state.textContent=labels[d.state]+(h.activeSince?' · Замер с '+new Date(h.activeSince).toLocaleString('ru-RU'):'');
  const n=list.length;
  const median=n%2?list[Math.floor(n/2)]:(list[n/2-1]+list[n/2])/2;
  summary.textContent=n?`Замеров: ${n}. Минимум ${seconds(list[0])}, медиана ${seconds(median)}, максимум ${seconds(list[n-1])}.`:'Завершённых замеров пока нет.';
  samples.replaceChildren(...h.samples.slice(0,20).map(x=>{const li=document.createElement('li'); li.textContent=seconds(x.seconds)+' · '+labels[x.outcome];return li;}));
 }catch{state.textContent='Диагностический процесс недоступен';}
}
render();setInterval(render,15000);
</script></html>"""


async def serve(path: Path, port: int, hours: int, dashboard: Path | None = None) -> None:
    raw = json.loads(dpapi(path.read_bytes(), decrypt=True))
    path.unlink()
    settings = StationPlaybackSettings(**raw)
    recorder = StationRetentionRecorder(path.with_name("retention.json")) if dashboard is None else None
    collector = StationPlaybackCollector(settings, on_state=recorder.observe if recorder is not None else None)
    publisher = SnapshotPublisher(mode="read_only", services_builder=list,
                                  station_playback_builder=lambda: collector.state)
    if dashboard is not None:
        collector.on_change = publisher.rebuild

    @asynccontextmanager
    async def lifespan(_):
        collector.start()
        try:
            yield
        finally:
            await collector.close()
            await publisher.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    if dashboard is None:
        @app.get("/", response_class=HTMLResponse)
        async def page():
            return PAGE
    else:
        app.include_router(build_station_playback_router(collector))
        app.mount("/assets", StaticFiles(directory=dashboard / "assets"), name="assets")

        @app.get("/")
        @app.get("/overview")
        async def overview():
            return FileResponse(dashboard / "index.html", headers={"Cache-Control": "no-store"})

        @app.get("/api/v1/snapshot")
        async def snapshot(response: Response):
            response.headers["Cache-Control"] = "no-store"
            return publisher.snapshot or await publisher.rebuild()

        @app.get("/api/v1/events")
        async def events(request: Request):
            return StreamingResponse(publisher.event_stream(request.is_disconnected),
                                     media_type="text/event-stream", headers={"Cache-Control": "no-store"})

    @app.get("/status")
    async def state():
        current = collector.state
        return {"state": current.status if current else "connecting", "titlePresent": bool(current and current.title),
                "artistPresent": bool(current and current.artist), "coverPresent": bool(current and current.coverPath),
                "retention": recorder.snapshot() if recorder is not None else None,
                "revision": publisher.revision}

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, access_log=False, log_level="warning"))

    async def expire():
        await asyncio.sleep(hours * 3600)
        server.should_exit = True

    timer = asyncio.create_task(expire())
    try:
        await server.serve()
    finally:
        timer.cancel()
        await asyncio.gather(timer, return_exceptions=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lease", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8794, choices=range(1024, 65536), metavar="PORT")
    parser.add_argument("--hours", type=int, default=168, choices=range(1, 169), metavar="1–168")
    parser.add_argument("--dashboard", type=Path, help="Serve the compiled dashboard in read-only preview")
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("the isolated one-time launcher requires Windows")
    try:
        asyncio.run(serve(args.lease, args.port, args.hours, args.dashboard))
    except Exception as exc:
        print(f"Station pilot stopped: {type(exc).__name__}", file=sys.stderr)
        sys.exit(1)
