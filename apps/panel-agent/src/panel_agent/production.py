from __future__ import annotations

from .main import app
from .static_dashboard import install_dashboard_routes

install_dashboard_routes(app)
