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

### Основная панель, кандидат и следующая функция

По [отчёту PR #372](https://github.com/decorum-guy/artem-control-center/blob/de472a808df864167e0e8a014c7c278809155a82/docs/plans/SAMSUNG_AUTONOMOUS_RESULTS_2026_11_24.md), [отчёту PR #373](https://github.com/decorum-guy/artem-control-center/blob/a81166047e44442874ddd6c8a1b0f80f33018622/docs/YOUTUBE_CURRENT_TRACK.md) и проверке исходников 24.11.2026:

| Объект | Последнее документированное состояние |
| --- | --- |
| Основной Samsung runtime | `2b361918f11b`, основной loopback-порт `8787`; новая аппаратная проверка при подготовке этой карты не выполнялась. |
| Изолированный preview | По отчёту `9c09fe7` из ветки #373, порт `8797`, без автозапуска и с ограниченным сроком. Не считать процесс ещё работающим без проверки. |
| Кандидаты | #372 — `de472a808df864167e0e8a014c7c278809155a82`; #373 — `a81166047e44442874ddd6c8a1b0f80f33018622`, основан на #372. Прежний независимый аудит относился к `e787ce4`; новые аппаратные результаты взяты из отчёта исполнителя и подтверждений владельца. |
| Напоминания и BLE | Озвучку записи с формы на Mini 2 владелец подтвердил. Push на iPhone и комбинированная доставка остаются открытыми. Скачки при ошибке обновления устранены в preview по отчёту. Физическое включение BLE после recovery ранее подтверждено. [Архив задания и последующие результаты](plans/SAMSUNG_FINISHING_ROUND_2026_11_24.md). |
| Сохранение текущей песни | В #373 работают каталог ytmusicapi, официальный лайк и readback через Happ. Две голосовые фразы проверены; появление отдельных ID в Music наблюдалось в браузере. Программное чтение Music текущим Desktop OAuth вернуло 400. [Исходное исследование и ссылки на реализацию](YOUTUBE_CURRENT_TRACK.md). |
| Следующий этап | [Два списка понравившихся и запуск по выбранному треку](plans/LIKED_MUSIC_LIBRARY_2026_11_24.md). Для элемента YouTube предлагается явно обозначенное соответствие записи Яндекса; прямой YouTube Music streaming на Mini 2 не подтверждён. |

До установки кандидата не описывать его модули как уже работающие в основной панели. Для кодовых ссылок на эти модули использовать ревизию кандидата, а не предполагать их наличие в `main`.

При разрешённом переходе preview → основной runtime сначала проверить основную панель с выключенным TV voice handler, затем остановить получатель preview и только после этого включить единственный основной получатель. Подробный порядок и откат — в отчёте кандидата. Публикация этого документа не выполняет установку.

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
| Карточка «Дела», health labels | `apps/dashboard/src/PlanningOverviewCard.tsx`, `planningOverview.ts` | `apps/panel-agent/src/panel_agent/{planning_adapter.py,planning.py}` |
| Calendar page, кнопка обновления | `apps/dashboard/src/PlanningRoutes.tsx`, `planningReadClient.ts` | `apps/panel-agent/src/panel_agent/{planning_api.py,planning_adapter.py,planning_cache.py}` |
| Todoist Tasks | `apps/dashboard/src/{TodoistTasks.tsx,todoistClient.ts,todoistTasks.css}` | `apps/panel-agent/src/panel_agent/{todoist.py,todoist_api.py}`; [docs/TODOIST_TASKS.md](TODOIST_TASKS.md) |
| HA / smart home / kettle | `apps/dashboard/src/{KettleControl.tsx,ClimateControl.tsx}` | `apps/panel-agent/src/panel_agent/{home_assistant.py,home_assistant_actions.py}` |
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

