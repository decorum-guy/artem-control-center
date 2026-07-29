# AGENTS.md

Инструкции для Codex и любых разработчиков, работающих с Artem Control Center.

## 1. Product intent

Это не обычный административный dashboard. Интерфейс должен ощущаться как персональная премиальная операционная панель, рассчитанная на постоянное присутствие на столе и управление пальцами.

Приоритеты:

1. Надёжность и понятная обратная связь.
2. Безопасность управляющих действий.
3. Высокое визуальное качество уже с первого MVP.
4. Touch-first UX.
5. Автоматическое появление подключённых проектов/services в UI.
6. Масштабируемая widget platform.
7. Простое capability-based подключение новых проектов.
8. Проверяемые резервные копии и восстановление.
9. Разработка и тестирование основной логики на macOS.
10. Низкое потребление ресурсов на ноутбуке с 8 ГБ RAM.
11. Переносимость Windows → Linux без переписывания frontend.

## 2. Fixed decisions

Не менять без отдельного архитектурного решения:

- Chromium kiosk как основной production runtime интерфейса.
- React + TypeScript + Vite для frontend.
- Локальный Panel Agent как единственная точка выполнения системных и удалённых команд.
- Panel Agent localhost-only по умолчанию и не публикуется напрямую в Internet.
- Проекты подключаются декларативно по capabilities; restart/deploy/backup не обязательны.
- Monitor-only project является полноценным supported scenario.
- Enabled project/service автоматически материализуется в UI после registry update.
- Если специализированного widget нет, обязателен Generic Service Widget.
- Hard-coded frontend lists проектов/services запрещены.
- Widget definitions используют единый manifest/data/settings contract.
- Backup является отдельной capability и не подразумевает restore/restart/deploy.
- Погода, несколько weather locations, дневная/ночная темы, календарь и задачи входят в обязательный MVP.
- Coffee-machine warm-up widget является обязательным P0 MVP widget.
- Motion design и signature animations входят в первый visual MVP и Definition of Done.
- macOS является поддерживаемым development host для UI, fixtures, Panel Agent dev mode и Playwright.
- Windows остаётся первым production/hardware acceptance host.
- Home Assistant никогда не запускается на Samsung laptop: ни primary, ни standby, ни test host.
- Текущий удалённый HA authoritative до миграции на отдельный compact server.
- `AliceTG_Bot` — child service HA stack, а не repository Home Assistant.
- Proxy server считается server-managed системой без Git repository до появления отдельного source repository.

## 3. Frontend requirements

- Проектировать сначала для 13.3" touch display.
- Минимальная активная область обычной кнопки: 48×48 CSS px; primary actions больше.
- Навигация не зависит от hover.
- Статус читается по тексту, иконке и форме, не только по цвету.
- Keyboard navigation и visible focus обязательны.
- Не использовать тяжёлые постоянные WebGL-сцены.
- Анимации упрощаются при `prefers-reduced-motion`, низком FPS, high load или battery saver.
- UI переживает потерю backend/Internet: last-known state, timestamp и stale/offline status.
- Никаких fake production data, fake progress или скрытого optimistic success.
- Project card строится из capabilities; отсутствие actions не должно выглядеть ошибкой.
- Backup `partial` не отображается как полный success.
- One failing widget не роняет dashboard: error boundary обязателен.
- Registry reconnect начинается с полного snapshot; events не являются единственным source of truth.

## 4. Automatic UI materialization

После enable project/service:

1. Panel Agent валидирует config.
2. Registry revision увеличивается.
3. Frontend получает snapshot/event.
4. Widget Resolver выбирает specialized widget либо Generic Service Widget.
5. Layout Reconciler создаёт visible instance.
6. Service появляется в Services catalog и `New items`.
7. Automated UI test подтверждает появление.

Service не считается onboarded, пока он не виден в UI.

Запрещено:

- вручную добавлять каждый service в страницу;
- использовать `if project.id === ...` для обычного rendering;
- требовать frontend release только ради отображения monitor-only service;
- скрывать неизвестный service вместо generic fallback;
- считать backend config success достаточным без UI reconciliation.

Перед изменением registries/widgets читать `docs/PROJECT_ONBOARDING.md`, `docs/WIDGET_SYSTEM.md`, `config/projects.example.yaml` и `config/widgets.example.yaml`.

## 5. Widget development rules

Каждый coded widget включает:

- manifest;
- typed data contract;
- settings schema;
- component;
- deterministic fixtures;
- loading/stale/offline/error states;
- tests;
- accessibility labels;
- reduced-motion behavior where animated;
- performance classification;
- README/usage description.

Custom widget подключается через Widget Registry, а не напрямую импортируется в конкретную страницу.

New widget cannot silently acquire write permissions. Actions приходят только из Panel Agent policy.

Post-MVP layout editor должен разделять:

- project enabled/disabled;
- widget visible/hidden;
- widget position/size;
- layout profile.

No-code widgets в поздней версии остаются declarative: no arbitrary JavaScript, HTML, shell или direct browser fetch.

## 6. Coffee widget rules

Coffee widget обязателен в первом runnable MVP.

Fixtures/states:

- off;
- turning_on;
- warming early/middle/late;
- ready;
- running;
- running_too_long;
- turning_off;
- unavailable;
- stale;
- action lifecycle success/failure;
- reduced-motion;
- handheld.

Rules:

- real progress only;
- distinct stage transitions, not arbitrary fake gradient;
- no timer reset on duplicate `turn_on`;
- long-running warning persistent but not aggressively flashing;
- action success only after state verification;
- source authority shown or available in details;
- current HA/`AliceTG_Bot` safety behavior must not be bypassed silently.

## 7. Motion rules

- 60 FPS — target for ordinary transitions, not guarantee under any workload.
- Animations explain state changes.
- First runnable MVP contains touch feedback, card expansion, theme transition, weather ambience, coffee states, command/backup lifecycle and reduced-motion behavior.
- Dangerous actions use hold/double-confirm by policy.
- Action lifecycle: `requested → accepted → executing → verifying → success/failed`.
- Backup lifecycle: `preparing → exporting → downloading → verifying → encrypting → syncing → retention → success/partial/failed`.
- Success only after real verification.
- Calm ambient mode mandatory.

## 8. Capability-based onboarding

Each integration declares independent capabilities:

- monitor;
- details;
- actions;
- deploy;
- backup;
- restore;
- logs;
- open;
- heartbeat;
- notifications.

Rules:

- all capabilities optional;
- action is never inferred from project type;
- new write capability requires explicit opt-in;
- frontend does not know button count in advance;
- disabling capability does not delete project/history;
- disabled project stops polling and schedules;
- UI and YAML use one schema/validator;
- adapter failure is isolated;
- repository existence does not imply active deployment;
- absent repository does not block server-managed integration through restricted agent.

## 9. Backend and security

- Frontend stores no administrative tokens, SSH keys, cloud credentials or encryption keys.
- Each action has stable id, target, schema, risk, confirmation, timeout, cooldown/lock, verification and audit.
- Endpoint `execute arbitrary command` is forbidden.
- No shell interpolation with user input.
- Restart succeeds only after health verification.
- AVALAR stage deploy uses a fixed registered handler equivalent to `avalar-reg ./deploy.sh stage`; browser never sends the shell string.
- Firewall/proxy allow-list: validate → diff → confirm → backup → atomic apply → syntax check → reload → verify → rollback.
- Secrets use OS secret store/protected service config.
- Separate kiosk/browser profile; no public administrative port.
- Sensitive cloud backups encrypted before upload.
- Audit/logs redacted.

Before security-sensitive code read `docs/SECURITY_MODEL.md`.

## 10. Backup rules

Backup profile defines source, scope/consistency, local destination, optional destinations, encryption, retention/quota, verification and restore-test policy.

Rules:

- HTTP 200 or file existence does not prove successful backup;
- laptop copy is baseline but not the only reliable copy;
- cloud/external sync can be optional per run;
- `partial` is mandatory when optional destination fails;
- no universal `backup whole server` action;
- allow-listed paths/handlers only;
- no copying live database without consistency contract;
- never delete the only verified copy;
- restore test tracked separately;
- HA native backup and AliceTG Bot runtime/source backups are different artifacts.

## 11. Home Assistant rules

- Remote HA authoritative until dedicated-server migration.
- Samsung laptop never runs HA in any form.
- Local laptop functions are only explicitly approved LAN-capable Edge actions.
- No duplicate automations on two active HA instances.
- UI distinguishes HA host, HA app, Internet, LAN, device and AliceTG Bot failures.
- Future dedicated compact HA host is a separate infrastructure project.
- HA restore tests do not run on the panel laptop.

## 12. Health contract

For owned services:

```http
GET /health/live
GET /health/ready
GET /health/details
```

- `live`: process responds.
- `ready`: primary function is available.
- `details`: protected dependencies/version/storage/backup/deployment state.

Public health exposes no secrets, internal IPs, private content or raw traces.

## 13. Weather rules

- Multiple saved locations mandatory.
- Search supports city/district/address through geocoder adapter.
- User confirms normalized address and coordinates.
- Cache is isolated per location.
- District/address forecast may represent nearest provider grid point; UI shows location and freshness.
- Default location drives ambient weather and optional solar theme schedule.
- Provider/geocoder replaceable; secrets remain in Panel Agent.

## 14. macOS development workflow

Before target Windows validation, Codex must be able to:

- run frontend and Panel Agent dev mode on Mac;
- use fixtures/read-only mode with writes disabled by default;
- run lint/type/unit tests;
- run Playwright Chromium tests;
- inspect widget gallery and screenshots;
- test automatic service appearance;
- test day/night/reduced-motion;
- test coffee widget fixtures;
- test Settings and layout reconciliation.

Mac success is not Windows hardware acceptance. Hardware-dependent work must produce an exact Windows test checklist with commit, commands, expected behavior and logs.

Before development tooling changes read `docs/DEVELOPMENT.md`.

## 15. Development workflow

Each new integration includes:

- adapter interface and capabilities;
- config schema/migration;
- timeout/retry/cache/stale policy;
- degraded/offline behavior;
- health mapping;
- actions independently, if any;
- backup support independently, if any;
- secret boundary;
- tests/fixtures without production secrets;
- automatic UI materialization test;
- documentation;
- performance impact.

Do not add a large dependency without justifying RAM, CPU, startup time, security and maintenance cost.
