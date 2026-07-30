from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from panel_agent.static_dashboard import install_dashboard_routes


def make_dashboard(tmp_path):
    root = tmp_path / "dist"
    assets = root / "assets"
    assets.mkdir(parents=True)
    (root / "index.html").write_text("<main>dashboard</main>", encoding="utf-8")
    (assets / "app.js").write_text("console.log('ok')", encoding="utf-8")
    return root


def test_dashboard_serves_assets_and_spa_routes(tmp_path):
    root = make_dashboard(tmp_path)
    app = FastAPI()

    @app.get("/api/example")
    def example():
        return {"ok": True}

    assert install_dashboard_routes(app, root) is True
    client = TestClient(app)

    api = client.get("/api/example")
    assert api.status_code == 200
    assert api.json() == {"ok": True}

    overview = client.get("/overview")
    assert overview.status_code == 200
    assert overview.text == "<main>dashboard</main>"
    assert overview.headers["cache-control"] == "no-store"

    asset = client.get("/assets/app.js")
    assert asset.status_code == 200
    assert asset.text == "console.log('ok')"
    assert "immutable" in asset.headers["cache-control"]


def test_dashboard_does_not_turn_missing_api_or_assets_into_spa(tmp_path):
    root = make_dashboard(tmp_path)
    app = FastAPI()
    install_dashboard_routes(app, root)
    client = TestClient(app)

    assert client.get("/api/missing").status_code == 404
    assert client.get("/health/missing").status_code == 404
    assert client.get("/assets/missing.js").status_code == 404
    assert client.get("/missing.css").status_code == 404


def test_dashboard_blocks_path_escape(tmp_path):
    root = make_dashboard(tmp_path)
    (tmp_path / "secret.txt").write_text("secret", encoding="utf-8")
    app = FastAPI()
    install_dashboard_routes(app, root)
    client = TestClient(app)

    response = client.get("/%2e%2e/secret.txt")
    assert response.status_code == 404
    assert "secret" not in response.text
