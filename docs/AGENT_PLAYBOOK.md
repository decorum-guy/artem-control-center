# Agent Playbook: как входить в проект и сдавать изменения

Этот документ описывает последовательность действий нового агента в `decorum-guy/artem-control-center`. Он дополняет, но не заменяет обязательные [AGENTS.md](../AGENTS.md) и [RULES.md](../RULES.md).

## 0. Before anything

Сначала определить, что пользователь попросил: диагностику, план, код/PR, production fix или physical acceptance. Не интерпретировать разрешение читать SSH как разрешение менять сервер/Windows.

Прочитай в таком порядке:

1. `README.md`, `AGENTS.md`, `RULES.md`;
2. [PROJECT_MAP.md](PROJECT_MAP.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DESIGN_DIRECTION.md](DESIGN_DIRECTION.md);
3. [DEVELOPMENT.md](DEVELOPMENT.md), [WINDOWS_PRODUCTION_RUNTIME.md](WINDOWS_PRODUCTION_RUNTIME.md), [PRIVATE_PRODUCTION_CONNECTIVITY.md](PRIVATE_PRODUCTION_CONNECTIVITY.md);
4. тематические контракты (Todoist, Planning, HA, Overview, ASUS) и связанный GitHub issue;
5. актуальный source и tests — **source wins over old prose**; не изменять контракт молча.

## 1. Repository preflight

В чистом development checkout:

```bash
pwd
git status --short
git branch --show-current
git rev-parse HEAD
git fetch origin
git rev-parse origin/main
git log -5 --oneline origin/main
```

Если есть чужие uncommitted changes, не затирать их. Создавать branch/worktree по текущему `origin/main` и конкретному issue. Не обновлять production checkout ради discovery. Внешние repos (включая `AliceTG_Bot`) — read-only без отдельно разрешённых изменений.

Ищи актуальные места через `rg`, сверяй маршруты/флаги на обеих сторонах frontend/backend. Не делай глобальный replace или масштабный рефакторинг в рамках точечного инцидента.

## 2. Как диагностировать production

**Разделяй три источника доказательств:**

- `LIVE`: hostname, runtime SHA, sanitised logs, HTTP status, timings, counters, service state с реально доступной машины;
- `CODE`: проверенные обработчики и tests в конкретном Git SHA;
- `INFERENCE`: гипотеза, пока не подтверждена последовательностью наблюдений.

Если пользователь явно дал SSH доступ, сначала read-only:
- `ssh control-panel-pc` — узнать реальный Samsung hostname/uptime/runtime SHA, `status-production.ps1 -Json`, `status-connectivity.ps1 -Json`, process/ports/logs;
- `ssh ha-vps` — проверить container state/loopback health/safe logs HA и AliceTG_Bot;
- проверить независимые пути: browser→Panel Agent, Samsung→HA, Samsung→Planning, Samsung→Todoist, provider→iCloud, а не объявлять всё одной проблемой.

Не делать `cat runtime.env`, `env`, токенсодержащие `curl -v`, отключение firewall или рестарт services без отдельной санкции. Read-only probes не должны мутировать календари/задачи или HA devices. Детальный runbook: [PRODUCTION_DIAGNOSTICS.md](PRODUCTION_DIAGNOSTICS.md).

## 3. Логика диагностики проблем «Дела» и календаря

- Todoist Tasks — отдельный источник `/tasks`; `PlanningOverviewCard` и Calendar используют Planning. Не переносить проблему из одного слоя в другой.
- Сравнить Planning `status`, per-domain health, provider statuses, last success timestamps, cached/stale state, events page read и настоящий provider/calendar source health.
- «Обновить календарь» сейчас инициирует новый GET отображаемого месяца через `PlanningRoutes.tsx`; наличие новых данных в UI **не доказывает** refresh внешнего источника или устранение календарной ошибки.
- Соотнести имена проблемных источников и их IDs, не обнулять истории и не скрывать configured calendars «чтобы warning исчез».
- Если проблема провайдера/облака/Wi-Fi доказана, объяснить внешнюю границу и сохранить корректное degraded state; не строить новый proxy ради обхода без решения владельца.

## 4. Разработка

Минимальная вертикаль: тип/contract → backend/adapter → auth/access/gates → UI → fixtures → tests → docs. Не делать browser-to-provider requests с tokens. Данные после мутаций подтверждать authoritative readback.

UX:
- ориентир: Samsung 13.3” touch, 48 CSS px цели, читаемость, состояние loading/success/stale/failure;
- единый notice/sheet/access/interaction-lock;
- никакого fake status/optimistic success;
- новый portrait-mode из [issue #322](https://github.com/decorum-guy/artem-control-center/issues/322) должен поддерживать `720×1280`, реальный Samsung portrait viewport и неизменённый landscape `1280×720`;
- портретная сетка/редактор не должны разрушать landscape placements, даже при многократном rotate.

Сохранять полезную навигацию «Назад» — пользователь НЕ просит её убирать.

## 5. Тестовая матрица и evidence

Примеры команд из root `package.json`:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:python
npm run test:runtime
npm run check
git diff --check
```

Команды/версии актуализировать по `package.json`, `.github/workflows/ci.yml` и `docs/DEVELOPMENT.md`; убедиться в CI-compatible Python/Node. Playwright запускать по существующим скриптам и **правильным feature profiles**, а не приписывать fixture-mode успех к production. Доказательства UI: screenshots, размеры/scrollWidth, состояния уведомлений и клавиатуры. Production deployment и physical hardware acceptance — отдельные этапы.

Перед допуском к PR:
- focused unit/backend tests на root cause;
- regressions соседних функций;
- full repo validation и CI;
- опасные операции/tunnel/restart/HA writes не происходили;
- проектные документы и screenshot artifacts не содержат приватных данных.

## 6. Последовательность PR

1. Подтверди root cause с evidence; не маскируй несколько независимых причин одной правкой.
2. Если три области независимы, делай три reviewable PR: connectivity/calendar/refresh UX; portrait shell; portrait widgets/editor & route parity. Разбивка не освобождает от полного выполнения принятого scope.
3. В каждом PR укажи base SHA, branch, head SHA, связь с issue, изменённые файлы, результат tests/CI, screenshots, scope exclusions, rollback.
4. Не делать merge/deploy без прямого поручения владельца. Код в GitHub не означает обновление Samsung.
5. Для выполнения физических тестов нужен явный протокол: точный deployed SHA, физический viewport, шаги/наблюдения; CI не заменяет это.

## 7. Финальный отчёт

Обязательно отвечай на вопросы пользователя и не заявляй «исправлено», если есть только подозрение или зелёные тесты. Должны быть отдельно:
- что **наблюдалось live**;
- что **доказано исходниками**;
- что **не удалось проверить**;
- исправление и чем оно проверено;
- оставшиеся внешние зависимости;
- сведения о PR/CI;
- требуемая physical acceptance.

Если доступ к SSH отсутствует, зафиксировать `SSH unavailable`, а не имитировать удалённую диагностику. Если код доступен только GitHub через connector, не заявлять о запуске тестов на Samsung.
