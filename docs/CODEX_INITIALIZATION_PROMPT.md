# Codex Initialization Prompt

Use this prompt for the first Codex session in the local clone.

---

Ты принимаешь разработку проекта **Artem Control Center**.

Работай как основной технический партнёр и архитектор проекта. Цель первой сессии — не просто прочитать README, а безопасно изучить фактические связанные проекты, устранить неизвестные, оформить integration contracts и заложить проверяемое начало реализации.

## 1. Рабочий репозиторий и права записи

Текущая рабочая папка называется:

```text
artem-control-panel
```

Это локальный клон GitHub-репозитория:

```text
decorum-guy/artem-control-center
```

**Записывать, создавать, удалять и форматировать файлы разрешено только внутри текущей папки `artem-control-panel`.**

Все остальные предоставленные папки и репозитории — строго **READ ONLY**.

Никогда не изменяй внешние проекты даже для «небольшой полезной правки».

Во внешних источниках запрещено:

- редактировать или форматировать файлы;
- запускать auto-fix/formatters, которые могут что-либо записать;
- устанавливать зависимости;
- создавать lock-файлы, caches или generated artifacts;
- запускать migrations, deploy, restart или production write-команды;
- создавать commits, branches, tags или PR;
- менять конфигурацию;
- отправлять write-запросы в production APIs;
- раскрывать secrets в выводе или документации.

Все предложения по внешним проектам оформляй только внутри `artem-control-panel` в виде analysis, contracts, patch plans и backlog.

Не выполняй `git push`. Не создавай commits без отдельной просьбы пользователя.

## 2. Read-only источники для discovery

### Home Assistant

Локальная папка на Mac:

```text
/Users/aartemida/Documents/Homeassistant
```

Строго read-only.

### AVALAR website

Пользователь предоставит доступ к локальной папке сайта с названием `avalar`.

Найди её только среди явно разрешённых/mounted директорий текущей сессии. Не сканируй бесконтрольно весь домашний каталог. Если доступно несколько вариантов, перечисли кандидатов и не записывай ни в один.

Строго read-only.

### AVALAR Exchange MCP

Локальной папки может не быть. Читай через GitHub connector:

```text
decorum-guy/avalar_exchange_mcp
```

Строго read-only: не создавай Issues, branches, commits или PR в этом repository.

## 3. Первые обязательные действия

1. Выполни safety preflight:
   - `pwd`;
   - определить repository root;
   - `git status --short --branch`;
   - проверить, нет ли пользовательских uncommitted changes;
   - убедиться, что write operations направляются только в `artem-control-panel`.
2. Прочитай в текущем репозитории как минимум:
   - `README.md`;
   - `AGENTS.md`;
   - `docs/PRODUCT_SPEC.md`;
   - `docs/ARCHITECTURE.md`;
   - `docs/PROJECT_ONBOARDING.md`;
   - `docs/WIDGET_SYSTEM.md`;
   - `docs/HOME_ASSISTANT_DEVICE_CONTRACT.md`;
   - `docs/HOME_ASSISTANT_RESILIENCE.md`;
   - `docs/INTEGRATIONS_AND_HEALTH.md`;
   - `docs/BACKUP_STRATEGY.md`;
   - `docs/SECURITY_MODEL.md`;
   - `docs/UI_MOTION_SPEC.md`;
   - `docs/DEVELOPMENT.md`;
   - `docs/ROADMAP.md`;
   - все `config/*.example.yaml`;
   - открытые Issues, если GitHub connector доступен.
3. Составь фактическую карту текущего репозитория. Не предполагай, что код уже существует: проверь.
4. После этого проведи read-only discovery внешних источников.

Не задавай пользователю вопросы, ответы на которые можно получить чтением предоставленных файлов/repositories. Если один источник недоступен, зафиксируй это и продолжай с остальными, не выдумывая содержимое.

## 4. Fixed product decisions

Считай их окончательными:

- UI работает через Chromium.
- Frontend: React + TypeScript + Vite.
- Backend/control plane: FastAPI Panel Agent.
- Windows — первый production/hardware host.
- Mac — обязательный development/test host.
- Linux — возможный будущий host панели после проверки железа.
- Samsung laptop никогда не запускает Home Assistant: ни primary, ни standby, ни test instance.
- Будущий локальный HA host — отдельный компактный сервер.
- Panel Agent localhost-only; прямой public admin port запрещён.
- Enabled service автоматически появляется в UI через registry reconciliation.
- Если specialized widget отсутствует, используется Generic Service Widget.
- Hard-coded frontend lists проектов/services запрещены.
- Coffee-machine widget — P0 обязательная функция первого MVP.
- Красивые анимации входят в первый MVP.
- Drag/resize layouts — после MVP.
- No-code user widgets — поздняя фаза.
- Любые внешние папки/repositories в этой сессии read-only.

## 5. Home Assistant: критически важный discovery

Home Assistant управляет:

- кофемашиной — P0;
- чайником — P1.

**Home Assistant является единственным источником истины для состояния кофемашины и чайника.**

`AliceTG_Bot` — отдельный Telegram-бот внутри HA stack. Он не является источником coffee/kettle state.

Из `/Users/aartemida/Documents/Homeassistant` найди фактическую реализацию:

- exact coffee entity id;
- exact kettle entity id;
- existing HA scripts/services для turn-on/turn-off;
- helper/template/automation, где хранится время последнего включения кофемашины;
- warm-up start;
- warm-up duration или ready-at;
- ready/running/running-too-long logic;
- long-running safety/timers;
- все YAML includes/packages/templates, влияющие на эти устройства;
- является ли `last_changed` надёжным источником или используется отдельный helper;
- какие данные доступны через state, attributes, events или history.

Не придумывай entity IDs. Не задавай guessed warm-up duration.

Не открывай и не цитируй значения из `secrets.yaml`, `.env`, tokens, passwords или private webhooks. Если секретный файл встречается, достаточно отметить его существование без чтения значения.

Создай внутри writable repo:

```text
docs/discovery/HOME_ASSISTANT_ENTITY_MAP.md
```

Документ должен содержать:

- files inspected;
- exact entities/scripts/helpers;
- normalized coffee-state mapping;
- normalized kettle mapping;
- источник last activation;
- источник warm-up duration/progress;
- safety logic;
- gaps/unknowns;
- required HA changes — только описание, без применения;
- confidence level для каждого вывода;
- явное подтверждение, что внешняя папка не менялась.

Coffee widget должен в дальнейшем читать HA через WebSocket/REST adapter и продолжать работать, когда AliceTG Bot недоступен, если HA здоров.

## 6. AVALAR website discovery

Read-only изучи локальный сайт AVALAR:

- структуру приложения;
- stage/main deployment model;
- deploy scripts;
- фактическую процедуру, эквивалентную `avalar-reg ./deploy.sh stage`;
- current health endpoints или их отсутствие;
- runtime dependencies;
- deployment markers/version/commit availability;
- безопасные способы smoke/rollback/backup;
- что нужно добавить в backend/site для мониторинга и control actions.

Не запускай deploy, restart или write scripts.

Создай:

```text
docs/discovery/AVALAR_SITE_INTEGRATION_GAPS.md
```

Для каждого предлагаемого изменения укажи:

- external file/component;
- current fact;
- required change;
- reason;
- proposed API/health contract;
- security implications;
- tests;
- risk;
- implementation order.

## 7. AVALAR Exchange MCP discovery

Через GitHub connector read-only изучи:

```text
decorum-guy/avalar_exchange_mcp
```

Проверь актуальный код, а не только README/старые handoff-документы.

Найди:

- current health/live/ready/details behavior;
- relay/origin/application/dependency model;
- deployment/version/status mechanisms;
- existing control/validation scripts;
- database/storage dependencies;
- безопасные restart/validator/maintenance interfaces;
- изменения, необходимые для Artem Control Center.

Создай:

```text
docs/discovery/AVALAR_EXCHANGE_MCP_INTEGRATION_GAPS.md
```

Не изменяй cloud repository.

## 8. Cross-project output

Создай:

```text
docs/discovery/INITIAL_DISCOVERY_REPORT.md
docs/discovery/EXTERNAL_CHANGE_PLAN.md
```

### INITIAL_DISCOVERY_REPORT

Раздели информацию на:

- Verified from writable repository;
- Verified from read-only Home Assistant folder;
- Verified from read-only AVALAR folder;
- Verified from read-only GitHub repository;
- User-stated facts;
- Engineering proposals;
- Unknown/unverified.

Добавь:

- current architecture map;
- integration dependency graph;
- security boundaries;
- highest-risk unknowns;
- recommended first vertical slice;
- какие выводы меняют существующие docs/configs.

### EXTERNAL_CHANGE_PLAN

Таблица/sections по каждому внешнему проекту:

- required change;
- repository/folder;
- why Control Center needs it;
- health/data/action/backup contract;
- whether required for prototype, MVP or later;
- exact acceptance tests;
- suggested implementation sequence;
- explicit statement: `NOT APPLIED — READ-ONLY DISCOVERY`.

## 9. Что разрешено реализовать в первой сессии

После discovery и только внутри `artem-control-panel`:

1. Исправь выявленные противоречия в документации/config examples.
2. Создай минимальный monorepo scaffold, если реального scaffold ещё нет:
   - `apps/dashboard`;
   - `apps/panel-agent`;
   - shared contracts/config packages;
   - test structure.
3. Подготовь one-command Mac development path.
4. Создай deterministic fixtures для:
   - HA healthy/degraded/offline;
   - coffee off/warming/ready/running-too-long/stale;
   - kettle on/off/unavailable;
   - Alice bot down while HA/coffee remain healthy;
   - monitor-only/multi-action services;
   - registry update → automatic widget materialization.
5. Реализуй только foundation, который не требует guessed production entity IDs или secrets.

Не подключай реальные production write-actions в первой сессии. Real HA integration разрешена только после entity-map discovery и через read-only/dev credentials до отдельного разрешения на writes.

Не создавай красивую одноразовую кофейную карточку вне Widget Registry. Даже P0 coffee widget обязан использовать общий manifest/data/settings/fixture contract.

## 10. Development and testing requirements

На Mac должно быть возможно:

- запустить dashboard и Panel Agent одной документированной командой;
- использовать `fixtures` и `read_only` modes;
- открыть обычное Chrome/Chromium окно;
- включить simulated kiosk viewport;
- запустить unit/type/lint tests;
- запустить Playwright Chromium;
- проверить automatic service appearance;
- проверить coffee fixtures/animations;
- проверить day/night/reduced-motion;
- проверить Settings/layout reconciliation.

Mac success не является Windows acceptance. Для hardware-dependent изменений подготовь точный Windows checklist:

- branch/commit or working-tree state;
- exact commands;
- expected behavior;
- touch steps;
- performance metrics;
- log paths;
- rollback/stop procedure.

## 11. Quality and security rules

- Facts, assumptions and proposals обозначай отдельно.
- Production fixtures/fake data cannot be enabled accidentally.
- No secrets in frontend, docs, logs or Git.
- No arbitrary shell endpoint.
- No user input shell interpolation.
- No public Panel Agent port.
- Actions come only from registered policy.
- Success requires state/health verification.
- One failing widget cannot crash the dashboard.
- New service cannot remain backend-only.
- No large dependency without RAM/CPU/startup/security justification.
- Do not destroy or overwrite uncommitted user changes.

## 12. Final response format

В конце первой сессии дай пользователю:

1. Что было фактически изучено.
2. Какие источники были недоступны.
3. Подтверждённую карту HA coffee/kettle logic.
4. Какие изменения нужны во внешних проектах, отдельно подчеркнув, что они не применялись.
5. Что изменено только внутри `artem-control-panel`.
6. Какие tests/commands запускались и результаты.
7. Текущие risks/unknowns.
8. Один рекомендуемый следующий vertical slice.
9. `git status --short` текущего writable repository.
10. Явное подтверждение: внешние папки/repositories не изменялись.

Начинай с safety preflight и чтения `AGENTS.md`. Не начинай с написания UI наугад до discovery Home Assistant и существующей структуры проекта.

---
