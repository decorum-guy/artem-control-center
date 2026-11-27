# Карта репозитория и runtime — Artem Control Center

Карта составлена по структуре `decorum-guy/artem-control-center` и документам проекта. Пути к production-host и сервисам ниже **документированы в репозитории**, но должны сверяться агентом на живой машине: они не подтверждают текущее состояние сами по себе.

## 1. Быстрая модель

Инфраструктурные узлы и SSH alias описаны в [INFRASTRUCTURE_ACCESS.md](INFRASTRUCTURE_ACCESS.md).

```mermaid
flowchart TD
    Mac["Mac: разработка и диагностика"]
    Samsung["Samsung: kiosk и Panel Agent"]
    VPS["ha-vps: HA и AliceTG_Bot"]
    Proxy["kz-bot: зарубежный прокси"]
    TV["Android TV"]
    Telegram["Telegram"]
    Providers["Прямые внешние API"]
    Mac -->|"ssh control-panel-pc"| Samsung
    Mac -->|"ssh ha-vps"| VPS
    Mac -->|"ssh kz-bot"| Proxy
    Samsung -->|"приватные HA / Planning forwards"| VPS
    Samsung -->|"штатный TV Executor и ADB"| TV
    Samsung -->|"например, Todoist HTTPS"| Providers
    VPS -->|"известный потребитель: Telegram-бот"| Proxy
    Proxy --> Telegram
```

Схема объединяет документированную топологию и сведения владельца; она не является текущим health-снимком. Временное отключение прокси отмечается только в датированной заметке карты доступа.

Не путать сеть с источником истины. HA — authority устройств его интеграций; AliceTG_Bot Planning — календаря/наследуемых задач/напоминаний; Todoist — отдельной вкладки `/tasks` при включённом provider. Кандидат PR #372 добавляет независимые источники: локальный Glagol для музыки, Calendar Notes для нативных напоминаний и BLE для ленты спальни. В Overview карточка «Дела» остаётся Planning-based, см. [TODOIST_TASKS.md](TODOIST_TASKS.md). Сетевая связность Samsung→VPS и Samsung→Todoist — независимые пути.

### Основной выпуск и незавершённые изменения

Сверка GitHub выполнена 27.11.2026. Таблица различает исходники и последний
предоставленный владельцем отчёт установки; новой SSH-проверки хостов в облаке
не выполнялось.

| Объект | Подтверждённый источник и состояние |
| --- | --- |
| `main` | `36e8f7df2a335210d821fd882617438663ba1e46`, merge [#375](https://github.com/decorum-guy/artem-control-center/pull/375). |
| Основной Samsung | В отчёте установки [#378](https://github.com/decorum-guy/artem-control-center/pull/378) на `8787` установлен тот же `36e8f7d`; текущее живое состояние сверять на хосте. |
| Установленные исходники #375 | Отдельная страница музыки, каталоги Яндекса/YouTube, вход Google, нативные напоминания, BLE, голосовое ТВ и принятые дополнения. Прежние таблицы preview в release-планах — исторические. |
| Исправления #380 | [Открытый PR #380](https://github.com/decorum-guy/artem-control-center/pull/380), head `77d4e40b7ece06132811820f0e511f1bfa7a33c7`: обе ленты в Overview, карточка HA, лайки/очереди/поиск, напоминания, поля V3 и последующий раунд трёх блокеров. Merge и установка не подтверждены. |
| Голосовая яркость | [#381](https://github.com/decorum-guy/artem-control-center/issues/381), [контракт и установка](ALICE_PANEL_BRIGHTNESS.md). Код и программные проверки отдельно от подключения HA→Яндекс и приёмки фраз на Мини 2. |
| Автоматические выпуски | [#382](https://github.com/decorum-guy/artem-control-center/issues/382), [AUTOMATIC_DEPLOYMENT.md](AUTOMATIC_DEPLOYMENT.md). Первичная установка worker и включение целей на Samsung/VPS не следуют из наличия кода в репозитории. |

Открытые вопросы не подменять отсутствием реализованной функции: создание
напоминаний уже имеет три варианта доставки, один нативный phone-only push
подтверждён владельцем. Дополнительные измерения доставки ранее остановлены.
Фан-режим кондиционера при изменении температуры владелец принял как поведение
устройства. Точный трек Notch Decay, изменение маршрута уже существующего
напоминания и физические проверки новых очередей — отдельные границы #380.

Точные SHA, CI и установленные ревизии всегда перечитываются перед новой работой.
Старые loopback preview-ссылки и сроки не считаются действующими без проверки.

## 2. Корень проекта

| Путь | Назначение |
| --- | --- |
| `README.md` | назначение продукта, основные разделы, способы запуска |
| `AGENTS.md` | основной набор требований к агентам |
| `RULES.md` | краткие обязательные правила безопасности и workflow |
| `package.json` | npm workspaces и канонические build/test команды |
| `apps/dashboard/` | React/Vite dashboard: маршруты, виджеты, UX, тесты |
| `apps/panel-agent/` | FastAPI Panel Agent: интеграции, access, snapshot, API, Python tests |
| `apps/jarvis-voice/` | отдельные материалы/компоненты локального голосового слоя |
| `packages/contracts/` | общие типизированные контракты frontend/backend |
| `packages/config/` | общая конфигурация и fixtures |
| `config/` | примерные конфигурации и schema; не реальный production env |
| `scripts/` | dev/build/production orchestration и проверки |
| `scripts/windows/` | Samsung runtime, connectivity tunnel, updater, ASUS companion helper |
| `tests/e2e/` | Playwright browser tests и visual acceptance profiles |
| `docs/` | архитектура, интеграции, безопасность, дизайн, delivery и runbooks |

## 3. Где искать по подсистемам

| Симптом/задача | Frontend | Backend / contract |
| --- | --- | --- |
| Shell, маршруты, навигация, 9:16 | `apps/dashboard/src/Shell.tsx`, `ShellPrimitives.tsx`, `useVisualViewport.ts` | `docs/DESIGN_DIRECTION.md`, [issue #322](https://github.com/decorum-guy/artem-control-center/issues/322) |
| Overview grid, editor, «Виджет недоступен» | `apps/dashboard/src/features/overview/{DashboardGrid.tsx,layoutValidation.ts,OverviewPage.tsx,overviewGrid.css,overviewEditor.css}` | `apps/panel-agent/src/panel_agent/overview_layout.py` |
| Страница «Музыка» `/music`, кандидат #375 | `apps/dashboard/src/features/music/{MusicPage.tsx,musicLibraryStore.ts,musicPage.css}`, App/Shell и interface copy | `apps/panel-agent/src/panel_agent/{music_library.py,music_library_types.py,yandex_library.py,youtube_library.py,youtube_library_credentials.py,station_playback.py}`; [актуальная проверка подключения](plans/YOUTUBE_CONNECTION_REVIEW_375_2026_11_24.md) |
| Карточка «Дела», health labels | `apps/dashboard/src/PlanningOverviewCard.tsx`, `planningOverview.ts` | `apps/panel-agent/src/panel_agent/{planning_adapter.py,planning.py}` |
| Calendar page, кнопка обновления | `apps/dashboard/src/PlanningRoutes.tsx`, `planningReadClient.ts` | `apps/panel-agent/src/panel_agent/{planning_api.py,planning_adapter.py,planning_cache.py}` |
| Todoist Tasks | `apps/dashboard/src/{TodoistTasks.tsx,todoistClient.ts,todoistTasks.css}` | `apps/panel-agent/src/panel_agent/{todoist.py,todoist_api.py}`; [docs/TODOIST_TASKS.md](TODOIST_TASKS.md) |
| HA / smart home / kettle | `apps/dashboard/src/{KettleControl.tsx,ClimateControl.tsx}` | `apps/panel-agent/src/panel_agent/{home_assistant.py,home_assistant_actions.py}` |
| Асинхронные climate-controls, кандидат #374 | `apps/dashboard/src/{ClimateControl.tsx,useCommandSeries.ts,homeAssistantControlApi.ts}` | `home_assistant_actions.py`: `_climate_lock`, readback и повторная проверка доступа; [принятый раунд R1–R5](plans/MUSIC_LIBRARY_ROUND2_RESULTS_2026_11_24.md) и [диагностика fan](plans/MUSIC_LIBRARY_ROUND3_2026_11_24.md) |
| CI и хранение артефактов | `.github/workflows/ci.yml`, `playwright.config.ts`, `tests/e2e/{music-page.spec.ts,climate-async.spec.ts}` | `scripts/test-production-profile.mjs`; [проверенные запуски и выпуск](plans/YOUTUBE_CONNECTION_REVIEW_375_2026_11_24.md) |
| Телевизор: пульт, снимки и доступ с Mac | `apps/dashboard/src/features/tv/`, `apps/dashboard/remote/` | `apps/panel-agent/src/panel_agent/{tv_api.py,tv_ingress.py}`; [TV_CONTROL.md](TV_CONTROL.md), [TV_ACCESS.md](TV_ACCESS.md) |
| Подключение / перезапуск туннеля | `apps/dashboard/src/{ConnectivityActions.tsx,connectivityApi.ts}` | `apps/panel-agent/src/panel_agent/connectivity_actions.py`; `scripts/windows/*connectivity*.ps1` |
| ASUS ROG G703GI | `apps/dashboard/src/{RogG703Controller.tsx,RogG703Controls.tsx}` | `apps/panel-agent/src/panel_agent/rog_g703_power.py`, `scripts/windows/rog_g703_companion.py` |
| Project health, включая AVALAR | `apps/dashboard/src/ServicesPage` (найти фактический компонент через поиск) | `apps/panel-agent/src/panel_agent/{project_monitor.py,project_registry.py}` |
| Доступы/запрет записи | `apps/dashboard/src/{AccessControls.tsx,InteractionLock.tsx}` | `apps/panel-agent/src/panel_agent/{access_policy.py,access_middleware.py,settings.py}` |
| Запуск, автообновление, логи | Edge kiosk и runtime UI — смотреть `App.tsx` | `scripts/production-runtime.mjs`, `scripts/windows/{status-production.ps1,update-production.ps1}` |

Путь `ServicesPage` в таблице — смысловой ориентир, **не гарантированное имя файла**. Используй `rg` в текущем checkout, а не придумывай импорт.

## 4. Топология и runtime (проверять, не угадывать)

Документация: [WINDOWS_PRODUCTION_RUNTIME.md](WINDOWS_PRODUCTION_RUNTIME.md), [PRIVATE_PRODUCTION_CONNECTIVITY.md](PRIVATE_PRODUCTION_CONNECTIVITY.md).

- Production Samsung документирован как Windows convertible; FastAPI на `127.0.0.1:8787`, task `Artem Control Center Runtime`.
- Пример checkout: `C:\Users\ARTEM-PANEL\Projects\artem-control-center`. Не применять команды к пути без проверки.
- Защищённый env: `%LOCALAPPDATA%\ArtemControlCenter\runtime.env`; logs: `%LOCALAPPDATA%\ArtemControlCenter\logs`. **Не читать содержимое секретов в отчёт.**
- Приватные local forwards по действующему design: `127.0.0.1:18123` → VPS HA, `127.0.0.1:18088` → VPS AliceTG_Bot. Это не публичные API через Caddy.
- Публичный Caddy, HA и AliceTG_Bot находятся за границей данного репозитория и имеют отдельную процедуру изменения.
- ASUS может использовать HTTP companion либо pinned SSH; какой выбран сейчас, определять по защищённой production config без вывода secrets.
- На Mac владельца подтверждены alias `control-panel-pc`, `ha-vps`, `kz-bot`. Использование и ограничения: [INFRASTRUCTURE_ACCESS.md](INFRASTRUCTURE_ACCESS.md). В облачном runtime нельзя предполагать наличие Mac SSH config/ключей.

## 5. С чего начать агенту

1. [AGENT_PLAYBOOK.md](AGENT_PLAYBOOK.md) и [INFRASTRUCTURE_ACCESS.md](INFRASTRUCTURE_ACCESS.md) — onboarding, доступы и delivery.
2. [RULES.md](../RULES.md) — безопасность, границы записи, truthfulness.
3. [PRODUCTION_DIAGNOSTICS.md](PRODUCTION_DIAGNOSTICS.md) — read-only диагностика Samsung/VPS/Planning и отличие refresh от sync.
4. `npm run check` и подходящий `tests/e2e/*` — проверка кода до PR.
5. Physical acceptance — отдельно и после review; результаты CI не доказывают состояние железа.
