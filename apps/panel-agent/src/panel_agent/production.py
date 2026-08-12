from __future__ import annotations

import logging

from .access_middleware import AccessPolicyMiddleware
from .access_policy import AccessPolicyStore, build_access_router
from .avalar_actions import AvalarActionExecutor, build_avalar_action_router
from .connectivity_actions import (
    ConnectivityActionExecutor,
    build_connectivity_action_router,
)
from .main import SETTINGS, app, runtime
from .rog_g703_power import RogG703ActionExecutor, build_rog_g703_action_router
from .static_dashboard import install_dashboard_routes

logging.getLogger("uvicorn.access").disabled = True

access_policy = AccessPolicyStore.from_environment(
    temporary_minutes=SETTINGS.access_temporary_minutes,
)
avalar_actions = AvalarActionExecutor(
    SETTINGS,
    access_policy,
    details_provider=runtime.avalar_ssh,
    refresh_callback=runtime.http.refresh,
)
connectivity_actions = ConnectivityActionExecutor(
    SETTINGS,
    access_policy,
    runtime=runtime,
)
rog_g703_actions = RogG703ActionExecutor(
    SETTINGS,
    access_policy,
    device=runtime.rog_g703,
)

app.add_middleware(AccessPolicyMiddleware, store=access_policy)
app.include_router(build_access_router(access_policy))
app.include_router(build_avalar_action_router(avalar_actions))
app.include_router(build_connectivity_action_router(connectivity_actions))
app.include_router(build_rog_g703_action_router(rog_g703_actions))
install_dashboard_routes(app)
