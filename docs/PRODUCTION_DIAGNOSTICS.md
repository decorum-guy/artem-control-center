# Production diagnostics: «Дела», Calendar, refresh and portrait

**Purpose:** read-only investigation before changing code or production. The checks below describe the repository's expected architecture; actual host, runtime SHA, environment and failure must be verified live. Cross-reference [PROJECT_MAP.md](PROJECT_MAP.md), [WINDOWS_PRODUCTION_RUNTIME.md](WINDOWS_PRODUCTION_RUNTIME.md) and [PRIVATE_PRODUCTION_CONNECTIVITY.md](PRIVATE_PRODUCTION_CONNECTIVITY.md).

## 1. Не смешивать четыре разных процесса

| Что видит пользователь | Где читать контракт | Что это НЕ доказывает |
| --- | --- | --- |
| Вкладка «Задачи» | `TodoistTasks.tsx`, `todoist_api.py`, [TODOIST_TASKS.md](TODOIST_TASKS.md) | Не доказывает свежесть Planning «Дела»/Calendar |
| Карточка Overview «Дела» | `PlanningOverviewCard.tsx`, `planningOverview.ts`, `planning_adapter.py` | Warning не означает автоматически «Todoist сломан» |
| Экран «Календарь» | `PlanningRoutes.tsx`, `planningReadClient.ts`, `planning_api.py` | Успех GET events не равен cloud sync |
| Значок обновления календаря | `CalendarPage.refreshCalendarData()` → `setRetry` → `usePlanningRead` GET events | Само нажатие не вызывает `/calendar-sources/refresh` и не доказывает новый provider sync |

Кодовый ориентир на момент записи: кнопка `planning-calendar-refresh` вызывает `refreshCalendarData()`, увеличивает `retry`, а GET проходит через `readPlanningEventsForRange(...)`. `useCalendarRefreshNotice` показывает progress после задержки, но не отдельное подтверждение freshness внешнего провайдера. Перепроверять по текущему head перед изменениями.

## 2. Read-only обследование Samsung

При предоставленном пользователем SSH-доступе:

```text
ssh control-panel-pc
```

На Windows узнать реальный checkout/runtime (не подставлять путь без проверки), время и SHA. В checkout доступны:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\status-production.ps1 -Json
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\status-connectivity.ps1 -Json
```

Проверить:
- Panel Agent `127.0.0.1:8787`, общие snapshot/health/state и last successful timestamps;
- приватные loopback forwards `127.0.0.1:18123` (HA) и `127.0.0.1:18088` (AliceTG_Bot), process ownership/restarts;
- `/api/v1/planning/status` и безопасные health diagnostics; `/api/v1/planning/events` только по необходимости, не выносить приватные события в отчёт;
- per-domain statuses `calendar/reminders/tasks/projects`, lastSyncedAt/generatedAt, `providerStatuses`, calendar source freshness и error categories;
- status Calendar после первой загрузки, после одного refresh, и после нескольких polling cycles;
- нет ли конкурентных запросов, stale cache, provider degradation, неправильной обработки response envelope.

**Не отправлять** provider refresh POST, mutation к событиям/устройствам, сброс cache, restart tunneling или rewrite env без отдельно разрешённого scope. Токены/содержимое календаря не выводить.

## 3. Read-only обследование VPS

При явно предоставленном доступе:

```text
ssh ha-vps
```

Проверить текущий compose root (исторически `/home/codex/homeassistant`) и status только существующих контейнеров; в документации зафиксированы AliceTG_Bot loopback `127.0.0.1:18088` и HA `127.0.0.1:18123`. Проверить сервисы/логические API, не публикуя конфигурацию и token. Если нужны логи, фильтровать на безопасные timestamps, HTTP status/exception categories, без приватных events/credentials.

Сопоставить:
1. Samsung local Panel Agent жив?
2. Samsung→VPS SSH forwards живы?
3. VPS HA локально жив?
4. VPS AliceTG_Bot Planning API локально жив?
5. Planning `status` читает calendar provider без ошибок?
6. Есть ли stale/failure на уровне самого iCloud/provider, а не транспорта?
7. Может ли source быть в состоянии degraded при успешной выдаче cache/events?

**AVALAR**, **«Планы Тёмы»** и другие названия источников — лишь наблюдения пользователя, их provider IDs/URLs/health и действующие подключения надо выяснить по текущему снимку. Не скрывать и не отключать эти источники для устранения предупреждения.

## 4. Критерии классификации

- **Network/tunnel:** запрос с Samsung до AliceTG не проходит, а локально на VPS проходит; проверить SSH forward и network status, но не менять конфиг автоматически.
- **VPS service:** loopback API на VPS не отвечает/ошибается.
- **External provider:** Planning route работает, но providerSource/status и логи на VPS подтверждают stale/error iCloud или внешнего календаря.
- **Panel cache/contract:** VPS отдаёт свежий valid response, а Panel Agent отдаёт stale/error либо неверно нормализует его.
- **UI presentation:** Panel Agent действительно current, а React/route продолжает показывать warning.
- **Not proven:** разовые ошибки без достаточной корреляции. Не выдумывать причинно-следственную связь с Wi-Fi или Todoist.

## 5. Кнопка обновления: нужный UX contract для исправления

До реализации выбрать один из двух честных вариантов:

A. «Перечитать события месяца» — запрос к Panel Agent; успех означает получен новый подтверждённый response. При ответе `stale`/cached явно показать «Данные получены, но источник не обновился», timestamp и статус. При network/error — отдельная ошибка.

B. «Обновить источники и перечитать события» — если это действительно полезное пользовательское действие, сначала проверить существующий защищённый `POST /api/v1/planning/calendar-sources/refresh` и его authorization/gate, response semantics, provider sync/timeout, затем перечитать месяц и *проверить* provider source freshness. Не обещать success по одному HTTP 200 или по завершению spinner.

В любом варианте: one-click lock, bounded progress, final status (updated / still stale / partial / failed), safe provider label/timestamp, без бесконечного retry, без ложно-зелёных сообщений. Нельзя «исправлять» warning, просто изменив copy на «всё хорошо».

## 6. Portrait 9:16: проверка widget fallback

[Issue #322](https://github.com/decorum-guy/artem-control-center/issues/322) — основной acceptance contract. Текущая ширино-зависимая проекция `landscape-12 | medium-8 | compact-4` не равнозначна полноценно спроектированному портретному режиму.

При «Виджет недоступен» собрать:
- route, component/widget type/instance ID (без пользовательского контента);
- фактические `innerWidth/innerHeight`, `visualViewport`, container width, DPR, Windows scale;
- `projectOverviewLayout` issues/fallbackReason, `responsive-unsupported`, registry size variants, max/min размеры и сохранённый canonical layout revision;
- ошибки React/console и загруженный profile;
- screen at `720×1280`, `768×1366`, measured Samsung CSS portrait, и `1280×720`.

Не исправлять fallback скрытием/удалением widget. Рисовать поддерживаемую portrait variant либо показывать честный fallback с доступными действиями. Landscape persisted layout при повороте не изменять. Пользователь **оставил «Назад»** — навигацию назад сохранять.

## 7. Итог агента

Сдать таблицу `layer → status → evidence time/source → cause or NOT PROVEN → action`; отдельно `Calendar`, `Дела`, `refresh`, `ASUS/other services only if relevant`, `portrait`.

Если доказана ошибка кода — отдельный branch/PR с focused regression tests; если внешняя проблема — не менять инфраструктуру без разрешения и не мешать исправлению portrait. Результат в CI не означает физическое устранение сбоя до проверки Samsung.
