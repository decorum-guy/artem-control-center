"""The deployment gate must be satisfiable by CI on the actual merged SHA.

These checks caught the former PR-only workflows: a successful PR suite does
not produce the main/push receipts required by the host-side deployment gate.
"""
import itertools
import json
from pathlib import Path
import re

import yaml


ROOT = Path(__file__).resolve().parents[3]
WORKFLOWS = (
    "ci.yml",
    "panel-runtime-update.yml",
    "kiosk-presence-hotfix.yml",
    "kiosk-process-tree-hotfix.yml",
)


def _job_names(workflow):
    names = []
    for job_id, job in workflow["jobs"].items():
        name = job.get("name", job_id)
        matrix = job.get("strategy", {}).get("matrix")
        if not matrix:
            names.append(name)
            continue
        axes = {key: value for key, value in matrix.items() if key not in {"include", "exclude"}}
        rows = [dict(zip(axes, values)) for values in itertools.product(*axes.values())] if axes else []
        rows.extend(matrix.get("include", []))
        for row in rows:
            if any(all(row.get(key) == value for key, value in excluded.items()) for excluded in matrix.get("exclude", [])):
                continue
            names.append(re.sub(r"\$\{\{\s*matrix\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}", lambda match: row[match[1]], name))
    return names


def test_required_workflows_run_on_main_without_path_filters():
    for filename in WORKFLOWS:
        # BaseLoader keeps GitHub's YAML key `on` a string, rather than YAML1.1
        # treating it as the boolean True.
        workflow = yaml.load((ROOT / ".github/workflows" / filename).read_text(), Loader=yaml.BaseLoader)
        push = workflow["on"]["push"]
        assert push["branches"] == ["main"], filename
        assert not {"paths", "paths-ignore", "branches-ignore"}.intersection(push), filename


def test_panel_and_ha_policies_require_every_actual_ci_job():
    expected = {}
    for filename in WORKFLOWS:
        workflow = yaml.load((ROOT / ".github/workflows" / filename).read_text(), Loader=yaml.BaseLoader)
        expected[filename] = set(_job_names(workflow))
    assert sum(map(len, expected.values())) == 6
    for filename, target_id in (("panel.example.json", "panel"), ("server.example.json", "home-assistant")):
        config = json.loads((ROOT / "scripts/auto-deploy" / filename).read_text())
        target = next(item for item in config["targets"] if item["id"] == target_id)
        assert {key: set(value) for key, value in target["required_workflows"].items()} == expected


def test_bot_policy_uses_existing_validate_job():
    # AliceTG_Bot PR45 adds the main push trigger; the existing job id/name
    # remains validate. Do not invent a `test` job that can never turn green.
    config = json.loads((ROOT / "scripts/auto-deploy/server.example.json").read_text())
    target = next(item for item in config["targets"] if item["id"] == "telegram-bot")
    assert target["required_workflows"] == {"ci.yml": ["validate"]}
