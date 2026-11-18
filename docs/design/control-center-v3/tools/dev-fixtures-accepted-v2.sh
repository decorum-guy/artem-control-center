#!/usr/bin/env bash
# Fixture-only dev server for V3 redesign review.
# Env = webServer.command from playwright.config.ts + the accepted-v2 production
# build profile (scripts/production-build-profile.mjs), but with the touch lock
# initially unlocked (VITE_TOUCH_INPUT_LOCK_START_LOCKED=false), as the V3 task requires.
# No SSH, no production, no real devices, synthetic secrets only.
#
# Usage (repo root, macOS shell or Windows Git Bash):
#   bash docs/design/control-center-v3/tools/dev-fixtures-accepted-v2.sh       # V2 look
#   bash docs/design/control-center-v3/tools/dev-fixtures-accepted-v2.sh v3    # VITE_V3_VISUAL_SKIN=true
# Requires `npm run setup` first. Serves http://127.0.0.1:5173 (Vite) and :8787 (Panel Agent).
set -euo pipefail
cd "$(dirname "$0")/../../../.."
mkdir -p .cache/dev-server
SKIN="false"
if [ "${1:-}" = "v3" ]; then SKIN="true"; fi
export PANEL_AGENT_RELOAD=false
export PANEL_WRITES_ENABLED=true
export PANEL_DEVICE_VISIBILITY_PATH=.cache/dev-server/device-visibility.json
export PANEL_COFFEE_DIARY_PATH=.cache/dev-server/coffee-diary.json
export PANEL_COFFEE_DIARY_IMAGE_DIR=.cache/dev-server/coffee-diary-images
export PANEL_COFFEE_DIARY_UPLOAD_ORIGIN=http://192.0.2.1:8788
export PANEL_OVERVIEW_LAYOUT_WRITES_ENABLED=true
export PANEL_OVERVIEW_LAYOUT_PATH=.cache/dev-server/overview-layout.json
export PANEL_COFFEE_TIMING_WRITES_ENABLED=true
export PANEL_COFFEE_NOTIFICATION_WRITES_ENABLED=true
export PANEL_COFFEE_ACTIONS_ENABLED=true
export PANEL_PLANNING_ENABLED=true
export PANEL_PLANNING_BASE_URL=http://fixture.test
export PANEL_PLANNING_INTERNAL_SECRET=synthetic-internal-secret
export PANEL_PLANNING_SECRET=synthetic-panel-agent-secret
export PANEL_PLANNING_FIXTURE_SCENARIO=b3-healthy
export PANEL_PLANNING_REMINDER_MUTATIONS_ENABLED=true
export PANEL_PLANNING_TASK_MUTATIONS_ENABLED=true
export PANEL_PLANNING_CALENDAR_MUTATIONS_ENABLED=true
# Keep dev.mjs away from %LOCALAPPDATA%\ArtemControlCenter on Windows hosts.
export PANEL_KIOSK_CONTROLS_ENABLED=false
export PANEL_RUNTIME_COMMAND_PATH=.cache/dev-server/runtime-command.json
export VITE_V2_VISUAL_SHELL=true
export VITE_OVERVIEW_V2_ENABLED=true
export VITE_OVERVIEW_EDITOR_ENABLED=true
export VITE_PLANNING_OVERVIEW_ENABLED=true
export VITE_PLANNING_TASKS_ROUTE_ENABLED=true
export VITE_PLANNING_CALENDAR_ROUTE_ENABLED=true
export VITE_PLANNING_REMINDERS_ROUTE_ENABLED=true
export VITE_PLANNING_REMINDER_MUTATIONS_ENABLED=true
export VITE_PLANNING_TASK_MUTATIONS_ENABLED=true
export VITE_PLANNING_CALENDAR_MUTATIONS_ENABLED=true
export VITE_TOUCH_INPUT_LOCK_ENABLED=true
export VITE_TOUCH_INPUT_LOCK_START_LOCKED=false
export VITE_V3_VISUAL_SKIN="$SKIN"
exec npm run dev:fixtures
