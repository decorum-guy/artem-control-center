from __future__ import annotations

import logging

from .main import app
from .static_dashboard import install_dashboard_routes

logging.getLogger("uvicorn.access").disabled = True
install_dashboard_routes(app)
