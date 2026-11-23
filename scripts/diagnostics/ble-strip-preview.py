"""Temporary Samsung loopback preview for one explicitly verified BLE strip."""

import argparse
import asyncio
import os
from pathlib import Path
from typing import Literal

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from ble_strip_pilot import ADDRESS, DeliveryUncertain, operate
from panel_agent.access_policy import AccessPolicyStore


PAGE = """<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Проверка BLE-ленты</title>
<style>body{background:#080e17;color:#eff5ff;font:17px system-ui;max-width:30rem;margin:3rem auto;padding:1rem}
button{min-height:48px;padding:0 16px;margin:.25rem;background:#16304a;color:inherit;border:1px solid #456c8e;border-radius:.7rem;font:inherit}
button:disabled{opacity:.5}</style>
<main><h1>BLE-лента</h1><button type="button" data-power="on">Включить</button>
<button type="button" data-power="off">Выключить</button><p role="status"></p></main>
<script>
const buttons = [...document.querySelectorAll('button')];
const result = document.querySelector('[role=status]');
for (const button of buttons) button.onclick = async () => {
  buttons.forEach(item => item.disabled = true);
  result.textContent = 'Подключение…';
  try {
    const r = await fetch('/power/' + button.dataset.power, {method:'POST', headers:{'X-Panel-Intent':'ble-pilot'}});
    const d = await r.json();
    result.textContent = r.ok ? 'Команда отправлена. Состояние ленты проверь визуально.' :
      d.detail === 'delivery_uncertain' ? 'Результат отправки неизвестен. Проверь ленту.' :
      d.detail === 'profile_blocked' ? 'Для команды нужен обычный или полный профиль панели.' : 'Команда недоступна.';
  } catch { result.textContent = 'Связь с проверкой потеряна. Проверь ленту перед повтором.'; }
  finally { buttons.forEach(item => item.disabled = false); }
};
</script></html>"""


def create_app(address: str, port: int, policy_path: Path, audit_dir: Path, writes_enabled: bool) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1"])
    lock = asyncio.Lock()

    @app.get("/", response_class=HTMLResponse)
    async def page():
        return HTMLResponse(PAGE, headers={"Cache-Control": "no-store"})

    @app.post("/power/{operation}")
    async def power(operation: Literal["on", "off"], request: Request):
        if (request.headers.get("origin") != f"http://127.0.0.1:{port}"
                or request.headers.get("x-panel-intent") != "ble-pilot"
                or request.client is None or request.client.host != "127.0.0.1"):
            raise HTTPException(403, "loopback_origin_required")
        policy = AccessPolicyStore(policy_path, audit_dir=audit_dir)
        capability = f"home.light_strip.power_{operation}"
        policy.require(capability, gate_enabled=writes_enabled, busy=lock.locked())
        async with lock:
            try:
                outcome = await operate(operation, address, seconds=16)
            except DeliveryUncertain as exc:
                policy.audit_capability(capability, result="delivery_uncertain")
                raise HTTPException(503, "delivery_uncertain") from exc
            except Exception as exc:
                policy.audit_capability(capability, result="ble_unavailable")
                raise HTTPException(503, "ble_unavailable") from exc
            policy.audit_capability(capability, result="write_completed")
            return outcome

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
