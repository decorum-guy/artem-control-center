import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = process.env.PANEL_PRODUCTION_BUILD_OUT_DIR
  ? resolve(process.env.PANEL_PRODUCTION_BUILD_OUT_DIR)
  : resolve(root, "apps", "dashboard", "dist");

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.name.endsWith(".js") && statSync(path).isFile() ? [path] : [];
  });
}

const files = javascriptFiles(join(dist, "assets"));
assert.ok(files.length > 0, "Production dashboard has no JavaScript assets");
const bundle = files.map((path) => readFileSync(path, "utf8")).join("\n");

for (const marker of [
  "ПЛАНИРОВАНИЕ",
  "Настроить",
  "Напоминания",
  "Задачи",
  "Календарь",
  "Погода",
  "Дом",
  "Сервисы",
  "Система",
  "Настройки",
  "Панель заблокирована",
  "Этот маршрут недоступен в production build."
]) {
  assert.ok(bundle.includes(marker), `Accepted V2 production marker is missing: ${marker}`);
}

assert.equal(bundle.includes("import.meta.env"), false, "Vite environment expressions were not compiled");
assert.equal(bundle.includes("TickTick"), false, "Production bundle fabricated unfinished TickTick functionality");
const capabilityManifest = JSON.parse(readFileSync(join(dist, "dashboard-capabilities.json"), "utf8"));
assert.equal(capabilityManifest.schemaVersion, "dashboard-capabilities.v1", "Safe build capability manifest is missing");
for (const [id, enabled] of Object.entries(capabilityManifest.active)) {
  const variable = {
    planning_overview: "VITE_PLANNING_OVERVIEW_ENABLED",
    planning_tasks_route: "VITE_PLANNING_TASKS_ROUTE_ENABLED",
    planning_calendar_route: "VITE_PLANNING_CALENDAR_ROUTE_ENABLED",
    planning_reminders_route: "VITE_PLANNING_REMINDERS_ROUTE_ENABLED"
  }[id];
  assert.ok(variable, `Unexpected build capability ${id}`);
  assert.equal(process.env[variable], String(enabled), `Manifest differs from actual build environment for ${id}`);
}
console.log(`Accepted V2 production bundle asserted (${files.length} JavaScript asset(s)).`);
