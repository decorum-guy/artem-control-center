# Artem Control Center

Персональная сенсорная панель Артёма для умного дома, мониторинга сервисов, календаря, задач, резервных копий и безопасного запуска заранее разрешённых действий.

## Зафиксированные продуктовые решения

- **UI runtime:** Chromium в полноэкранном kiosk-режиме.
- **Frontend:** React + TypeScript + Vite.
- **Backend:** локальный Panel Agent на FastAPI.
- **Первый production host:** Windows на Samsung Notebook 9 Pro 13" (NP940X3M).
- **Целевая ОС панели:** Linux после проверки тачскрина, поворота, сна, Wi‑Fi и Android-приложения.
- **macOS development:** UI и большая часть Panel Agent обязаны локально запускаться и тестироваться на Mac; hardware/kiosk acceptance выполняется отдельно на Windows.
- **Интерфейс:** touch-first, но пригодный для обычной работы мышью и клавиатурой.
- **Погода:** обязательный элемент главного экрана с несколькими сохранёнными локациями, поиском адреса/района и быстрым переключением.
- **Темы:** обязательные отдельные дневная и ночная темы с автоматическим переключением и ручным override.
- **Motion design:** выразительные, плавные и функциональные анимации входят уже в первый визуальный MVP.
- **Coffee widget:** анимированный виджет разогрева, готовности и long-running warning кофемашины — обязательная P0-функция MVP.
- **Coffee authority split:** Home Assistant управляет кофемашиной и остаётся
  единственным источником device state/availability/command verification.
  `AliceTG_Bot` предоставляет только изменяемую пользователем timing policy
  разогрева и long-running threshold через отдельный read-only contract.
- **Device priority:** кофемашина — первый приоритет Home-раздела; чайник подключается через тот же HA adapter, но может начинать с более простого generic device widget.
- **Project onboarding:** проекты подключаются декларативно по capabilities. Проект может быть monitor-only, иметь одну кнопку, несколько actions, backup или вообще не иметь управления.
- **Automatic UI materialization:** после enable новый project/service автоматически появляется в UI. Специализированный widget используется при наличии, иначе создаётся обязательный Generic Service Widget; ручное дописывание списка сервисов в frontend запрещено.
- **Widget platform:** coded widgets подключаются через единый manifest/data/settings contract; drag-and-drop layouts планируются после MVP, no-code preset widgets — в более поздней версии.
- **Settings:** обычные настройки доступны внутри UI — проекты, capabilities, виджеты, weather locations, backup destinations, layout visibility и безопасные параметры. Архитектурные/code changes в пользовательские настройки не выносятся.
- **Backups:** резервная копия создаётся зарегистрированным profile, скачивается на ноутбук и при выбранной policy дополнительно синхронизируется с cloud drive и/или будущим внешним HDD/SSD.
- **Home Assistant:** текущий удалённый HA остаётся authoritative на первом этапе. `AliceTG_Bot` — отдельный Git-репозиторий Telegram-бота внутри HA-стека, а не репозиторий самого Home Assistant.
- **HA hosting — fixed:** Samsung laptop не будет Home Assistant host или permanent HA primary. Долгосрочный локальный HA размещается на отдельном компактном сервере; ноутбук остаётся UI, edge-node, monitoring и backup-target.
- **Proxy server:** отдельного Git-репозитория сейчас нет; конфигурация и сервисы находятся непосредственно на сервере и подключаются через restricted host agent.
- **Безопасность:** браузер не получает SSH-ключи, административные токены или возможность выполнять произвольные команды. Panel Agent не публикуется напрямую в Internet.

## Главные разделы панели

1. **Overview** — часы, дата, погода, ближайшие события, задачи, состояние дома, backups и общий статус сервисов.
2. **Home** — приоритетный HA-виджет кофемашины, чайник, свет, розетки, климат, сцены и критичные локальные действия.
3. **Services** — автоматически сформированный каталог проектов/services, health, latency, incidents, deployment state и только разрешённые actions.
4. **Calendar & Tasks** — календарь iPhone/iCloud/Google/Exchange через адаптер источника и задачи TickTick.
5. **Automations** — запуск n8n, checks, scheduled maintenance и других зарегистрированных workflows.
6. **Backups** — ручные и плановые резервные копии, destinations, retention, checksums и restore-test status.
7. **Apps** — запуск Android-карты лояльности и других полноэкранных приложений.
8. **System** — питание, сеть, батарея, температура, диск, безопасность, журналы действий и переход на обычный рабочий стол.
9. **Settings** — добавление/отключение проектов, capabilities, widgets, layouts, weather locations, backup destinations и policies.

## Репозиторий как source of truth

Ключевые документы:

- [`AGENTS.md`](AGENTS.md) — обязательные правила для Codex и других разработчиков.
- [`docs/CODEX_INITIALIZATION_PROMPT.md`](docs/CODEX_INITIALIZATION_PROMPT.md) — готовый стартовый prompt для первой Codex-сессии с read-only discovery внешних проектов.
- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — продуктовая спецификация и UX.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — компоненты и границы ответственности.
- [`docs/PROJECT_ONBOARDING.md`](docs/PROJECT_ONBOARDING.md) — capability-based подключение, отключение и настройка проектов.
- [`docs/WIDGET_SYSTEM.md`](docs/WIDGET_SYSTEM.md) — автоматическое появление сервисов, widget plug-ins, layout system и no-code widgets.
- [`docs/HOME_ASSISTANT_DEVICE_CONTRACT.md`](docs/HOME_ASSISTANT_DEVICE_CONTRACT.md) — HA device authority, bot timing-policy authority и composite coffee model.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — разработка на Mac и финальная проверка на Windows/Linux.
- [`docs/INTEGRATIONS_AND_HEALTH.md`](docs/INTEGRATIONS_AND_HEALTH.md) — реестр проектов, health-контракты и control actions.
- [`docs/BACKUP_STRATEGY.md`](docs/BACKUP_STRATEGY.md) — создание, скачивание, проверка, хранение и синхронизация резервных копий.
- [`docs/HOME_ASSISTANT_RESILIENCE.md`](docs/HOME_ASSISTANT_RESILIENCE.md) — local edge, backups и будущий отдельный HA server.
- [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md) — защита ноутбука, браузера, Panel Agent, secrets, сети и remote actions.
- [`docs/UI_MOTION_SPEC.md`](docs/UI_MOTION_SPEC.md) — темы, анимации и touch-паттерны.
- [`docs/DESIGN_DIRECTION.md`](docs/DESIGN_DIRECTION.md) — продуктовая визуальная
  иерархия, touch/motion principles и anti-AI-slop review checklist.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — порядок реализации.
- [`docs/REFERENCES.md`](docs/REFERENCES.md) — официальные источники и границы подтверждённых возможностей.
- [`config/projects.example.yaml`](config/projects.example.yaml) — capability-based registry проектов и environments.
- [`config/services.example.yaml`](config/services.example.yaml) — декларативный реестр сервисов.
- [`config/actions.example.yaml`](config/actions.example.yaml) — декларативный allow-list действий.
- [`config/backups.example.yaml`](config/backups.example.yaml) — backup profiles и destinations.
- [`config/widgets.example.yaml`](config/widgets.example.yaml) — widget definitions, instances и auto-materialization policy.
- [`config/layouts.example.yaml`](config/layouts.example.yaml) — default layouts и будущие drag/resize capabilities.
- [`config/widget-user-presets.example.yaml`](config/widget-user-presets.example.yaml) — поздняя no-code модель безопасных пользовательских widgets.
- [GitHub Issues](../../issues) — исполнимый backlog по реализации, widgets, integrations, health, backups, security и миграции ОС.

## Базовый принцип

Ноутбук является красивым интерфейсом, локальным edge-контроллером, backup-node и пунктом наблюдения, но не единственной точкой, от которой зависят дом, серверы или доступ к данным.

## Первый локальный запуск на Mac

```text
npm run setup
npm run dev:mac
```

`dev:mac` одной командой запускает FastAPI Panel Agent на
`127.0.0.1:8787`, Vite на `127.0.0.1:5173` и открывает обычное окно браузера.
Режим `fixtures` визуально отмечен и не содержит production write executor.
Для безопасного пустого read-only режима используйте `npm run dev:read-only`.

Основной UI открывается на `/overview`; пользовательские разделы находятся на
`/home`, `/services`, `/calendar`, `/tasks`, `/backups`, `/apps`, `/settings` и
`/system`. Fixture controls и contract/debug metadata доступны отдельно на
`/dev/widget-gallery`; production build явно отключает этот маршрут.

Проверки:

```text
npm run check
npm run test:e2e
```
