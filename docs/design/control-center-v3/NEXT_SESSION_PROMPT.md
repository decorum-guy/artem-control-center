# Промпт для следующей сессии (передача после сессии 1, 17.11.2026)

Вставить следующему исполнителю целиком:

---

Продолжай редизайн Artem Control Center V3 «Кабина» по `docs/design/control-center-v3/ROADMAP.md`.

Репозиторий: https://github.com/decorum-guy/artem-control-center. Работай от ветки
`redesign/v3-stage-0` (draft PR #331 в `main`), а не от `main`. Чужие незакоммиченные
изменения не трогай. Merge и deploy не делай.

1. Подготовка.
   - `git fetch origin && git switch redesign/v3-stage-0 && git pull`.
   - `npm run setup`. На Windows без лаунчера `py` сначала `python -m venv .venv`, потом
     `npm run setup`. Затем `npm run install:browsers`.
   - Прочитай целиком `docs/design/control-center-v3/TASK.md` (задание владельца, первичный
     документ), `ROADMAP.md` и черновик `DESIGN_SPEC.md` там же, затем документы из раздела 1
     задания: AGENTS.md, RULES.md, docs/AGENT_PLAYBOOK.md, docs/DESIGN_DIRECTION.md,
     docs/UI_MOTION_SPEC.md, docs/design/control-center-v2/DESIGN_SPEC.md, docs/PORTRAIT_MODE.md,
     docs/WIDGET_SYSTEM.md, docs/DEVELOPMENT.md. Выполни preflight из RULES.md §1.
   - Панель поднимается только на тестовых данных:
     `bash docs/design/control-center-v3/tools/dev-fixtures-accepted-v2.sh` (аргумент `v3`
     включает `VITE_V3_VISUAL_SKIN=true`). Снимки:
     `node docs/design/control-center-v3/tools/capture-screens.mjs <папка> [опции]`.
     Никакого SSH, production, реальных устройств и секретов. `networkidle` не ждать (SSE).

2. Доделай этап 0 (чек-лист в ROADMAP §5).
   - Сначала добавь в `capture-screens.mjs` подмену `GET /api/v1/access` по образцу
     `tests/e2e/access.spec.ts`: в fixture-приложении этого маршрута нет (он есть только в
     `production.py`), поэтому на снимках «Доступ недоступен». Пересними «до» с `main`
     (90e0c8f) в той же конфигурации, что и будущие «после».
   - Просмотри скриншоты «до» и допиши DESIGN_SPEC §9: все 12 экранов в 1280×720 и 720×1280.
     Сверь §7 с реальными компонентами, сними пометку «черновик».
   - Обнови ROADMAP, закоммить, запушь, обнови описание PR #331.

3. Этапы 1 и 2 подряд, без ожидания подтверждений между ними.
   - Этап 1: ветка `redesign/v3-stage-1` от `redesign/v3-stage-0`, draft PR с базой
     `redesign/v3-stage-0`. Этап 2: `redesign/v3-stage-2` от stage-1, PR с базой stage-1.
     Содержание этапов, правила встраивания (флаг `VITE_V3_VISUAL_SKIN`, `skin/tokens.css`,
     `ui/`, галерея) и критерии готовности — в TASK.md §4–7 и ROADMAP §5.
   - Решения, уже принятые без владельца, перечислены в ROADMAP §6. Соблюдай их, особенно
     5 (свои Select/Slider только под флагом, чтобы старые e2e прошли без правок), 6 (DOM
     контракт PageHeader не меняется), 7 (скорректированные токены) и 8 (RingGauge без
     анимации `stroke-dashoffset`).
   - После каждого этапа: `npm run check`, `git diff --check`, существующие e2e без флага,
     новые `tests/e2e/v3-skin-*.spec.ts` с флагом, скриншоты в
     `artifacts/redesign-v3/stage-<N>/` (в git как WebP через `git add -f`). Посмотри свои
     скриншоты и сравни с TASK.md §3. Если экран выглядит как прежняя серая админка с
     перекрашенными цветами, этап не готов.

4. После этапа 2 остановись и покажи владельцу скриншоты «до/после» и ссылки на три PR.
   Отчёт по формату RULES.md §6; отдельно перечисли решения, нужные от владельца (ROADMAP §7).

Пожелание владельца из Telegram: «мега красиво, жидкое стекло, футуристично и элегантно».
Стекло делается без `backdrop-filter`, как записано в ROADMAP §6 (решение 4) и DESIGN_SPEC §5.

Если заканчивается время или контекст: закоммить рабочее состояние, обнови ROADMAP.md,
запушь и остановись. Не оставляй этап наполовину без записи.

---

Telegram: на компьютере DESKTOP-GE7IVII проект подключён к общему боту под ключом
`control-center`, хештег `#control_center`. На другом компьютере проверь
`node <.tg-hub>/add-project.mjs --list` и при необходимости подключи проект по инструкции
из глобального CLAUDE.md владельца.
