# AGENTS.md

Инструкции для Codex и любых разработчиков Artem Control Center.

## 1. Product intent

Это персональная премиальная touch-first панель, а не типовой admin dashboard.

Приоритеты:

1. Надёжность и понятная обратная связь.
2. Безопасность управляющих действий.
3. Высокое визуальное качество уже с первого MVP.
4. Обязательный кофейный HA-виджет с красивым разогревом.
5. Автоматическое появление подключённых services в UI.
6. Масштабируемая widget platform.
7. Capability-based onboarding проектов.
8. Проверяемые backups.
9. Разработка основной логики на macOS и hardware acceptance на Windows.
10. Низкая нагрузка на ноутбук с 8 ГБ RAM.

## 2. Writable repository boundary

Изменять разрешено только текущий репозиторий Artem Control Center — локальная папка может называться `artem-control-panel`, а GitHub repository — `decorum-guy/artem-control-center`.

Любые внешние источники используются только для чтения и анализа, если пользователь отдельно не дал новое явное разрешение на запись.

В частности, read-only:

- `/Users/aartemida/Documents/Homeassistant`;
- локальная папка сайта AVALAR;
- `decorum-guy/avalar_exchange_mcp` через GitHub connector;
- любые другие внешние проекты, предоставленные для discovery.

Во внешних проектах запрещено:

- редактировать/форматировать файлы;
- устанавливать зависимости;
- запускать миграции или write-команды;
- создавать commits/branches/PRs;
- менять конфигурацию;
- перезапускать production services;
- отправлять production write requests.

Предлагаемые изменения для внешних проектов оформляются только как документация, contracts, patch-plan или backlog внутри Artem Control Center repository.

## 3. Fixed technology and hosting decisions

Не менять без отдельного архитектурного решения:

- Chromium kiosk — production UI runtime.
- React + TypeScript + Vite — frontend.
- FastAPI Panel Agent — backend/control plane.
- Panel Agent localhost-only и не публикуется напрямую в Internet.
- Windows — первый production/hardware host.
- macOS — обязательный development host.
- Linux — возможный будущий host панели после hardware validation.
- Samsung laptop никогда не запускает Home Assistant: ни primary, ни standby, ни test instance.
- Будущий локальный HA host — отдельный компактный сервер.
- Текущий удалённый HA authoritative до отдельной миграции.

## 4. Home Assistant device ownership

Home Assistant управляет текущими устройствами:

- **кофемашина** — P0 и главный Home-widget MVP;
- **чайник** — P1, также HA-controlled.

Для кофемашины Home Assistant является единственным источником истины:

- on/off/availability;
- время последнего включения;
- warm-up start;
- duration/ready time;
- ready/running/too-long state;
- verification после команды.

`AliceTG_Bot` — отдельный child service HA stack. Он не является source of truth кофемашины/чайника и не должен быть нужен для чтения coffee state, если HA здоров.

Перед реальной интеграцией Codex обязан read-only изучить:

```text
/Users/aartemida/Documents/Homeassistant
```

Нужно найти точные entity IDs, scripts/services, helpers/templates/automations, источник времени последнего включения и расчёт разогрева. Нельзя придумывать entity IDs или жёстко задавать duration до inspection.

Результат discovery сохранять только здесь:

```text
docs/discovery/HOME_ASSISTANT_ENTITY_MAP.md
```

Не читать/публиковать secret values. Не коммитить `secrets.yaml`, `.env`, tokens, passwords или private webhooks.

Полный контракт: `docs/HOME_ASSISTANT_DEVICE_CONTRACT.md`.

## 5. Coffee widget — mandatory P0 MVP

Состояния:

- off;
- turning_on;
- warming;
- ready;
- running;
- running_too_long;
- turning_off;
- unavailable;
- stale.

Требования:

- state и timestamps только из HA;
- real progress либо безопасный расчёт из HA warm-up start + HA duration;
- при отсутствии достоверного duration показывать stage без fake percentage;
- no timer reset на duplicate `turn_on`;
- remaining time и last activation;
- calm steam/heat animation;
- persistent long-running warning без агрессивного мигания;
- action lifecycle `requested → accepted → executing → verifying → success/failed`;
- success только после HA state verification;
- reduced-motion и low-performance варианты;
- deterministic fixtures на Mac;
- real touch/performance acceptance на Windows;
- widget продолжает работать при падении `AliceTG_Bot`, если HA доступен.

Coffee actions выполняются через существующий HA script/service и не обходят safety logic.

## 6. Kettle

Чайник присутствует в HA device registry с начала проекта.

Первый уровень:

- availability/on/off;
- freshness;
- существующие HA turn-on/turn-off script/service;
- verification;
- Generic Home Device Widget.

Не переносить coffee warm-up assumptions на чайник без inspection.

## 7. Automatic UI materialization

После enable project/service:

1. Panel Agent валидирует config.
2. Registry revision увеличивается.
3. Frontend получает полный snapshot/event.
4. Widget Resolver выбирает specialized widget либо Generic Service Widget.
5. Layout Reconciler создаёт visible instance.
6. Service появляется в Services catalog и `New items`.
7. Playwright подтверждает появление.

Service не считается onboarded, пока он не виден в UI.

Запрещено:

- hard-coded frontend lists проектов/services;
- `if project.id === ...` для обычного rendering;
- frontend release только ради monitor-only service;
- скрывать неизвестный service вместо generic fallback;
- считать backend config success достаточным без UI reconciliation.

## 8. Capability model

Независимые capabilities:

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

Все optional. Проект может иметь 0, 1 или несколько actions. Action не выводится из типа проекта и требует explicit opt-in.

## 9. Widget development

Каждый coded widget включает:

- manifest;
- typed data contract;
- settings schema;
- component;
- fixtures;
- loading/stale/offline/error states;
- tests;
- accessibility labels;
- performance class;
- reduced-motion behavior;
- README.

Custom widget регистрируется через Widget Registry, а не импортируется вручную в страницу.

Widget не получает права самостоятельно. Allowed actions приходят от Panel Agent policy.

Post-MVP layout editor разделяет:

- project enabled/disabled;
- widget visible/hidden;
- position/size;
- layout profile.

No-code widgets later remain declarative: no arbitrary JavaScript, HTML, shell or direct browser fetch.

## 10. Frontend and motion

- Проектировать сначала для 13.3" touch display.
- Touch targets минимум 48×48 CSS px; primary controls больше.
- Не зависеть от hover.
- Status не кодируется только цветом.
- Keyboard navigation и visible focus обязательны.
- One failing widget не роняет dashboard.
- Last-known data всегда имеют timestamp/stale status.
- No fake production data, fake progress или hidden optimistic success.
- Day/night themes, weather ambience, coffee states и command/backup motion входят в первый MVP.
- Effects упрощаются при reduced-motion, low FPS, high load или battery saver.

## 11. Backend and security

- Frontend не хранит tokens, SSH keys, cloud credentials или encryption keys.
- Arbitrary-command endpoint запрещён.
- No shell interpolation with user input.
- Каждая action имеет stable id, target, schema, risk, confirmation, timeout, lock/cooldown, verification и audit.
- Restart/deploy success только после health verification.
- AVALAR stage deploy использует fixed registered handler, эквивалентный `avalar-reg ./deploy.sh stage`; браузер не передаёт shell string.
- Proxy allow-list flow: validate → diff → confirm → backup → atomic apply → syntax check → reload → verify → rollback.
- Separate kiosk profile/account.
- No public administrative port.
- Sensitive cloud backups encrypted before upload.
- Audit/logs redacted.

## 12. Backup rules

Backup profile определяет:

- source/scope;
- consistency mechanism;
- local destination;
- optional cloud/external destinations;
- encryption;
- retention/quota;
- verification;
- restore-test policy.

Rules:

- HTTP 200/file existence не доказывает backup success;
- `partial` обязателен при ошибке optional destination;
- no universal `backup whole server`;
- allow-listed paths/handlers only;
- no copying live DB без consistency contract;
- never delete the only verified copy;
- HA native backup и AliceTG Bot runtime/source backup — разные artifacts;
- HA restore test не выполняется на panel laptop.

## 13. Health contract

Для owned services:

```http
GET /health/live
GET /health/ready
GET /health/details
```

Public health не раскрывает secrets, internal IPs, private content или raw traces.

## 14. Weather

- Multiple saved locations mandatory.
- Search city/district/address through geocoder adapter.
- User confirms normalized address/coordinates.
- Cache isolated per location.
- Default location drives ambient weather and optional solar theme.
- Provider/geocoder replaceable; secrets stay in Panel Agent.

## 15. macOS development workflow

До Windows validation Codex должен уметь на Mac:

- запустить frontend + Panel Agent dev mode;
- использовать fixtures/read-only mode с writes disabled;
- запускать lint/type/unit tests;
- запускать Playwright Chromium;
- проверять automatic service appearance;
- просматривать Widget Gallery;
- тестировать coffee fixtures;
- тестировать Settings/layout reconciliation;
- создавать screenshots и accessibility smoke.

Mac success не является Windows hardware acceptance. Hardware-dependent work сопровождается точным Windows checklist: commit, commands, expected behavior, metrics, logs и rollback.

## 16. Development workflow

Перед кодом:

1. Прочитать README, AGENTS и профильные docs.
2. Проверить рабочее дерево и не затирать user changes.
3. Разделить verified facts, user statements, assumptions и proposals.
4. Провести read-only discovery внешних проектов.
5. Зафиксировать findings внутри writable repo.
6. Реализовывать вертикально: schema → backend → UI → tests → docs.

Каждая integration включает:

- adapter interface/capabilities;
- config schema/migration;
- timeout/retry/cache/stale policy;
- degraded/offline behavior;
- health mapping;
- independent actions/backups;
- secret boundary;
- fixtures/tests;
- automatic UI materialization test;
- documentation;
- performance impact.

Не добавлять крупную dependency без обоснования RAM, CPU, startup time, security и maintenance cost.
