from http.server import ThreadingHTTPServer
import json
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.tv_api import TVCommand, build_tv_router
from panel_agent.tv_ingress import Sessions, build_handler


def test_panel_api_rejects_cross_origin_and_unregistered_actions():
    app = FastAPI()
    app.include_router(build_tv_router(lambda: True))
    client = TestClient(app)
    assert client.post("/api/tv/command", json={"action": "shell"}).status_code == 422
    assert client.post("/api/tv/command", json={"action": "home"},
                       headers={"X-Panel-TV": "1", "Origin": "https://example.org"}).status_code == 403
    assert client.post("/api/tv/command", json={"action": "home"}).status_code == 403


class StubExecutor:
    def __init__(self):
        self.commands = []

    def invoke(self, command: TVCommand | None = None):
        if command:
            self.commands.append(command)
            return 503, {"outcome": "unconfirmed"}
        return 200, {"availability": "offline"}


def test_tv_ingress_session_status_revoke_and_asset_scope(tmp_path):
    dist = tmp_path / "dist"
    for directory in ("remote", ".vite", "assets"):
        (dist / directory).mkdir(parents=True, exist_ok=True)
    (dist / "remote/index.html").write_text("<title>TV</title>", encoding="utf-8")
    (dist / ".vite/manifest.json").write_text(json.dumps({"remote/index.html": {"file": "assets/remote.js"}}))
    (dist / "assets/remote.js").write_text("void 0;")
    (dist / "assets/admin.js").write_text("void 1;")
    sessions = Sessions(tmp_path / "sessions.db")
    executor = StubExecutor()
    origin = "https://remote.example.test"
    server = ThreadingHTTPServer(("127.0.0.1", 0), build_handler(dist, sessions, "test-code", origin, executor))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def request(path, *, payload=None, cookie="", supplied_origin=origin):
        headers = {"Origin": supplied_origin, "Cookie": cookie, "X-Panel-TV": "1", "Content-Type": "application/json"}
        req = Request(f"http://127.0.0.1:{server.server_port}" + path,
                      json.dumps(payload).encode() if payload is not None else None, headers)
        try:
            response = urlopen(req, timeout=2)
        except HTTPError as error:
            response = error
        with response:
            return response.code, response.read(), response.headers

    try:
        assert request("/remote/")[0] == 200
        assert request("/assets/remote.js")[0] == 200
        assert request("/assets/admin.js")[0] == 404
        assert request("/api/v1/settings")[0] == 404
        assert request("/remote/api/status")[0] == 401
        assert request("/remote/api/login", payload={"code": "wrong"})[0] == 401
        assert request("/remote/api/login", payload={"code": "test-code"}, supplied_origin="https://other.example")[0] == 403
        code, _, headers = request("/remote/api/login", payload={"code": "test-code"})
        assert code == 200
        assert "HttpOnly; SameSite=Strict; Secure" in headers["Set-Cookie"]
        cookie = headers["Set-Cookie"].split(";")[0]
        assert json.loads(request("/remote/api/status", cookie=cookie)[1]) == {"availability": "offline"}
        assert request("/remote/api/command", payload={"action": "arbitrary"}, cookie=cookie)[0] == 400
        assert request("/remote/api/command", payload={"action": "up"}, cookie=cookie)[0] == 503
        assert len(executor.commands) == 1
        assert request("/remote/api/logout", payload={}, cookie=cookie)[0] == 200
        assert request("/remote/api/status", cookie=cookie)[0] == 401
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
