"""Temporary Samsung loopback preview for one explicitly verified BLE strip."""

import argparse
import asyncio
import os
from pathlib import Path
from typing import Literal

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from ble_strip_pilot import ADDRESS, RGB, DeliveryUncertain, operate
from panel_agent.access_policy import AccessPolicyStore

LABELS = {
    "red": "Красный", "green": "Зелёный", "blue": "Синий", "yellow": "Жёлтый", "purple": "Фиолетовый",
    "pink": "Розовый", "sky": "Голубой", "sea": "Светлый морской", "white": "Белый", "lime": "Салатовый",
}
SWATCH = {name: f"rgb{channels}" for name, channels in RGB.items()}
SWATCH["white"] = "#f8f4f3"  # Physical output of this controller’s calibrated RGB preset.
PALETTE = "".join(
    f'<button type="button" data-action="/color/{name}"><i style="--swatch:{SWATCH[name]}"></i>{label}</button>'
    for name, label in LABELS.items()
)

PAGE = """<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Проверка BLE-ленты</title>
<style>body{background:#080e17;color:#eff5ff;font:17px system-ui;max-width:37rem;margin:2rem auto;padding:1rem}
h1{font-size:1.8rem} h2{font-size:1.13rem;margin-top:1.5rem}
button,select{min-height:48px;padding:0 14px;background:#16304a;color:inherit;border:1px solid #456c8e;border-radius:.7rem;font:inherit}
select{min-width:5.5rem} button{cursor:pointer} button:disabled{opacity:.5;cursor:default}
button:focus-visible,select:focus-visible{outline:2px solid #75c9ff;outline-offset:2px}
.controls{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center} i{display:inline-block;width:.8em;height:.8em;
border-radius:50%;background:var(--swatch);margin-right:.55em} [role=status]{min-height:1.5em;color:#bccbda}</style>
<main>
<h1>BLE-лента</h1><div class="controls">
<button type="button" data-action="/power/on">Включить</button>
<button type="button" data-action="/power/off">Выключить</button></div>
<h2>Цвет</h2><div class="controls">__PALETTE__</div>
<h2 id="brightness-label">Яркость</h2>
<form class="controls" aria-labelledby="brightness-label">
<select id="brightness" aria-labelledby="brightness-label" required>
<option value="" selected disabled>Выбрать</option>
<option value="20">20%</option><option value="40">40%</option>
<option value="60">60%</option><option value="80">80%</option><option value="100">100%</option>
</select>
<button type="submit">Применить</button></form>
<p id="result" role="status"></p></main>
<script>
const controls = [...document.querySelectorAll('button, select')];
const form = document.querySelector('form');
const input = document.querySelector('#brightness');
const result = document.querySelector('#result');
const errors = {delivery_uncertain:'Результат отправки неизвестен. Проверь ленту.',
  profile_blocked:'Нужен обычный или полный профиль панели.', gate_disabled:'Управление выключено.',
  busy:'Уже отправляется другая команда.', ble_unavailable:'Лента недоступна.'};
async function command(path, body){
  controls.forEach(el => el.disabled = true);
  result.textContent = 'Подключение…';
  try {
    const args = {method:'POST',headers:{'X-Panel-Intent':'ble-pilot'}};
    if(body){args.headers['Content-Type'] = 'application/json'; args.body = JSON.stringify(body);}
    const r = await fetch(path,args);
    const d = await r.json();
    result.textContent = r.ok ? 'Команда отправлена' : errors[d.detail] ?? 'Команда недоступна';
  } catch { result.textContent = 'Связь с проверкой потеряна. Проверь ленту перед повтором.'; }
  finally { controls.forEach(el => el.disabled = false); }
}
for(const button of document.querySelectorAll('[data-action]')){
  button.onclick = () => command(button.dataset.action);
}
form.onsubmit = event => {event.preventDefault(); command('/brightness',{percent:Number(input.value)});};
</script></html>""".replace("__PALETTE__", PALETTE)


class BrightnessRequest(BaseModel):
    percent: int = Field(strict=True, ge=1, le=100)


def create_app(address: str, port: int, policy_path: Path, audit_dir: Path, writes_enabled: bool) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1"])
    lock = asyncio.Lock()

    @app.get("/", response_class=HTMLResponse)
    async def page():
        return HTMLResponse(PAGE, headers={"Cache-Control": "no-store"})

    async def single(request: Request, capability: str, operation: str, percent: int | None = None):
        if (request.headers.get("origin") != f"http://127.0.0.1:{port}"
                or request.headers.get("x-panel-intent") != "ble-pilot"
                or request.client is None or request.client.host != "127.0.0.1"):
            raise HTTPException(403, "loopback_origin_required")
        policy = AccessPolicyStore(policy_path, audit_dir=audit_dir, read_only=True)
        policy.require(capability, gate_enabled=writes_enabled, busy=lock.locked())
        async with lock:
            try:
                outcome = await operate(operation, address, seconds=16, percent=percent)
            except DeliveryUncertain as exc:
                policy.audit_capability(capability, result="delivery_uncertain")
                raise HTTPException(503, "delivery_uncertain") from exc
            except Exception as exc:
                policy.audit_capability(capability, result="ble_unavailable")
                raise HTTPException(503, "ble_unavailable") from exc
            policy.audit_capability(capability, result="write_completed")
            return outcome

    @app.post("/power/{operation}")
    async def power(operation: Literal["on", "off"], request: Request):
        return await single(request, f"home.light_strip.power_{operation}", operation)

    @app.post("/color/{operation}")
    async def color(operation: str, request: Request):
        if operation not in RGB:
            raise HTTPException(404, "color_unknown")
        return await single(request, "home.light_strip.set_color", operation)

    @app.post("/brightness")
    async def brightness(value: BrightnessRequest, request: Request):
        return await single(request, "home.light_strip.set_brightness", "brightness", value.percent)

    return app


async def serve(args: argparse.Namespace) -> None:
    app = create_app(args.address, args.port, args.policy, args.audit_dir, args.enable_writes)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=args.port,
                                           proxy_headers=False, access_log=False, log_level="warning"))

    async def expire() -> None:
        await asyncio.sleep(args.hours * 3600)
        server.should_exit = True

    timer = asyncio.create_task(expire())
    try:
        await server.serve()
    finally:
        timer.cancel()
        await asyncio.gather(timer, return_exceptions=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--address", default=os.getenv("PANEL_BLE_PILOT_ADDRESS"))
    parser.add_argument("--port", type=int, default=8795, choices=range(1024, 65536), metavar="PORT")
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--audit-dir", type=Path, required=True)
    parser.add_argument("--hours", type=int, default=2, choices=range(1, 9), metavar="1–8")
    parser.add_argument("--enable-writes", action="store_true")
    args = parser.parse_args()
    if not args.address or not ADDRESS.fullmatch(args.address):
        parser.error("an owner-confirmed address is required")
    asyncio.run(serve(args))
