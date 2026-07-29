from copy import deepcopy
import json
from pathlib import Path
from typing import Any, Dict, List

from .contracts import ServiceSnapshot

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
FIXTURE_PATH = REPOSITORY_ROOT / "packages" / "config" / "fixtures" / "scenarios.json"


def load_fixture_document() -> Dict[str, Any]:
    with FIXTURE_PATH.open("r", encoding="utf-8") as fixture_file:
        return json.load(fixture_file)


def deep_merge(target: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    result = deepcopy(target)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


def services_for_scenario(scenario: str) -> List[ServiceSnapshot]:
    document = load_fixture_document()
    scenarios = document["scenarios"]
    if scenario not in scenarios:
        raise KeyError(scenario)
    patches = scenarios[scenario]
    services = []
    for base in document["baseServices"]:
        merged = deep_merge(base, patches.get(base["id"], {}))
        services.append(ServiceSnapshot.model_validate(merged))
    return services


def safe_read_only_services() -> List[ServiceSnapshot]:
    services = services_for_scenario("ha-offline")
    for service in services:
        service.actions = []
        service.summary = "Read-only adapter not configured" if service.id != "home-assistant" else service.summary
    return services
