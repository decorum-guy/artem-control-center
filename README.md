# Artem Control Center

Персональная сенсорная панель Артёма для умного дома, мониторинга сервисов, календаря, задач, резервных копий и безопасного запуска заранее разрешённых действий.

## Зафиксированные продуктовые решения

- **UI runtime:** Chromium в полноэкранном kiosk-режиме.
- **Frontend:** React + TypeScript + Vite.
- **Backend:** локальный Panel Agent; рекомендуемый стек — FastAPI.
- **Первый хост:** Windows на Samsung Notebook 9 Pro 13" (NP940X3M).
- **Целевая ОС:** Linux после проверки тачскрина, поворота, сна, Wi‑Fi и Android-приложения.
- **Интерфейс:** touch-first, но пригодный для обычной работы мышью и клавиатурой.
- **Погода:** обязательный элемент главного экрана с несколькими сохранёнными локациями, поиском адреса/района и быстрым переключением.
- **Темы:** обязательные отдельные дневная и ночная темы с автоматическим переключением и ручным override.
- **Motion design:** выразительные, плавные и функциональные анимации входят уже в первый визуальный MVP, а не откладываются на финальную полировку.
- **Project onboarding:** проекты подключаются декларативно по capabilities. Проект может быть monitor-only, иметь одну кнопку, несколько actions, backup или вообще не иметь управления.
- **Backups:** резервная копия создаётся зарегистрированным profile, скачивается на ноутбук и при выбранной policy дополнительно синхронизируется с cloud drive и/или будущим внешним HDD/SSD.
- **Home Assistant:** текущий удалённый HA остаётся authoritative на первом этапе. `AliceTG_Bot` — отдельный Git-репозиторий Telegram-бота внутри HA-стека, а не репозиторий самого Home Assistant.
- **HA hosting:** старый переносимый ноутбук не становится единственным критичным HA-host. Долгосрочный предпочтительный вариант — отдельный компактный локальный сервер; ноутбук остаётся панелью, edge-node, backup-target и возможным остановленным standby.
- **Proxy server:** отдельного Git-репозитория сейчас нет; конфигурация и сервисы находятся непосредственно на сервере и подключаются через restricted host agent.
- **Безопасность:** браузер не получает SSH-ключи, административные токены или возможность выполнять произвольные команды. Panel Agent не публикуется напрямую в Internet.

## Главные разделы панели

1. **Overview** — часы, дата, погода, ближайшие события, задачи, состояние дома, backups и общий статус сервисов.
2. **Home** — кофемашина, чайник, свет, розетки, климат, сцены и критичные локальные действия.
3. **Services** — health, latency, incidents, deployment state и только разрешённые конкретному проекту actions.
4. **Calendar & Tasks** — календарь iPhone/iCloud/Google/Exchange через адаптер источника и задачи TickTick.
5. **Automations** — запуск n8n, checks, scheduled maintenance и других зарегистрированных workflows.
6. **Backups** — ручные и плановые резервные копии, destinations, retention, checksums и restore-test status.
7. **Apps** — запуск Android-карты лояльности и других полноэкранных приложений.
8. **System** — питание, сеть, батарея, температура, диск, безопасность, журналы действий и переход на обычный рабочий стол.
9. **Settings** — добавление/отключение проектов, capabilities, weather locations, backup destinations и policies.

## Репозиторий как source of truth

Ключевые документы:

- [`AGENTS.md`](AGENTS.md) — обязательные правила для Codex и других разработчиков.
- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — продуктовая спецификация и UX.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — компоненты и границы ответственности.
- [`docs/PROJECT_ONBOARDING.md`](docs/PROJECT_ONBOARDING.md) — capability-based подключение, отключение и настройка проектов.
- [`docs/INTEGRATIONS_AND_HEALTH.md`](docs/INTEGRATIONS_AND_HEALTH.md) — реестр проектов, health-контракты и control actions.
- [`docs/BACKUP_STRATEGY.md`](docs/BACKUP_STRATEGY.md) — создание, скачивание, проверка, хранение и синхронизация резервных копий.
- [`docs/HOME_ASSISTANT_RESILIENCE.md`](docs/HOME_ASSISTANT_RESILIENCE.md) — локальная работа, standby и решение по размещению HA.
- [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md) — защита ноутбука, браузера, Panel Agent, secrets, сети и remote actions.
- [`docs/UI_MOTION_SPEC.md`](docs/UI_MOTION_SPEC.md) — темы, анимации и touch-паттерны.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — порядок реализации.
- [`docs/REFERENCES.md`](docs/REFERENCES.md) — официальные источники и границы подтверждённых возможностей.
- [`config/projects.example.yaml`](config/projects.example.yaml) — capability-based registry проектов и environments.
- [`config/services.example.yaml`](config/services.example.yaml) — декларативный реестр сервисов.
- [`config/actions.example.yaml`](config/actions.example.yaml) — декларативный allow-list действий.
- [`config/backups.example.yaml`](config/backups.example.yaml) — backup profiles и destinations.
- [GitHub Issues](../../issues) — исполнимый backlog по реализации, интеграциям, health, backups, security и миграции ОС.

## Базовый принцип

Ноутбук является красивым интерфейсом, локальным edge-контроллером, backup-node и пунктом наблюдения, но не единственной точкой, от которой зависят дом, серверы или доступ к данным.
