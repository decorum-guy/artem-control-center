# RULES.md — обязательные правила работы с Artem Control Center

Этот файл — короткий операционный регламент для новых кодовых агентов. Развёрнутые и первичные проектные требования уже находятся в [AGENTS.md](AGENTS.md). При расхождении не переопределяй их здесь: остановись, сопоставь исходники/контракты и явно сообщи о конфликте. Архитектура: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); карта исходников: [docs/PROJECT_MAP.md](docs/PROJECT_MAP.md).

## 1. Сначала evidence, потом изменения

1. Прочитать AGENTS.md, этот файл, README.md, docs/AGENT_PLAYBOOK.md и документацию затронутой подсистемы.
2. Зафиксировать `git status --short`, `git branch --show-current`, `git rev-parse HEAD`, актуальный `origin/main` и существующие PR/issues.
3. Не полагаться на старые SHA и пути из чата без проверки. Не смешивать факты из живого runtime, факты из текущего кода, слова пользователя и гипотезы.
4. Воспроизвести неисправность или собрать безопасный наблюдаемый след прежде, чем менять timeout, state machine, сеть или UI.
5. Не называть фиксом маскировку ошибки или молчаливый переход на fixture/cached success.

## 2. Границы записи и production

- Изменять проектный код и документы только в этом репозитории, в отдельной ветке и PR; сохранять чужие незакоммиченные изменения.
- Внешние checkout'ы/папки по умолчанию read-only. Не править AliceTG_Bot, Home Assistant, Caddy, чужие repos, если пользователь не разрешил отдельный scope.
- Подключение к `ssh control-panel-pc` или `ssh ha-vps` допускается **только с явно предоставленным доступом** и прежде всего для read-only диагностики. Сам факт наличия SSH не означает разрешение менять production.
- Без отдельного разрешения не делать: merge, deploy, restart сервисов, reboot, изменение Windows ориентации, firewall, SSH/tunnels/sshd, Docker Compose, ключей, секретов, кэша или реальных устройств.
- Перед любой одобренной production-мутацией нужен scoped план, backup/rollback, способ проверки и подтверждённый blast radius. Не использовать `docker compose down` или общесистемный restart вместо адресной операции.

## 3. Секреты и персональные данные

- Никогда не печатать/коммитить `.env`, `runtime.env`, токены Todoist/HA/Planning, приватные ключи, cookies, содержимое личного календаря и задач.
- При проверке конфигурации выводить только `set/missing` и несекретные параметры. Не включать токены в `curl -v`, shell history, trace, логи или PR.
- Browser не получает provider credentials и не задаёт произвольные upstream URL, entity, service, shell command либо токены. Использовать typed localhost Panel Agent endpoints и существующие access/write gates.
- Примеры задач/событий в тестах — синтетические; тесты не выполняют live provider mutations.

## 4. Источники истины и деградация

- Home Assistant владеет физическим состоянием кофемашины/чайника/умного дома; UI не выдумывает подтверждённые состояния.
- Todoist — отдельный opt-in provider вкладки `/tasks`; см. [docs/TODOIST_TASKS.md](docs/TODOIST_TASKS.md). **Overview «Дела» и календарь по текущему контракту продолжают использовать Planning через AliceTG_Bot**. Не объединять Todoist IDs с Planning UUID.
- Planning/calendar source health, network/tunnel health и «запрос данных завершился» — разные вещи. HTTP 200 / кэш / нажатая кнопка обновления не доказывают успешную синхронизацию провайдера.
- Сохранять timestamps, последнюю подтверждённую версию, cached/stale/degraded/offline/unknown и правдивую причину. Не скрывать проблемные календари и не менять gates для устранения предупреждения.
- Не повторять потенциально выполненную мутацию после timeout/uncertain outcome без подтверждения состояния.

## 5. UX и тесты

- Сенсорный Samsung: минимум 48 CSS px на критические интерактивные зоны, доступность с клавиатуры, focus, reduced motion и ясная feedback-state machine.
- Landscape `1280×720` должен сохраняться без регрессий; portrait `720×1280` и реальный измеренный viewport Samsung обязательны для работ по issue #322. Поворот не должен переписывать сохранённую landscape-сетку.
- Обозначать значок обновления по его реальному действию: перечитывание Panel Agent, запрос обновления источника, либо подтверждённый sync — это не синонимы. Завершение, failure и отсутствие подтверждения должны быть различимы.
- Перед PR: focused tests, `npm run check` (либо актуальный CI-эквивалент), Playwright нужных feature profiles, `git diff --check`. Physical hardware acceptance не заменяется CI.

## 6. Выходной отчёт агента

Формат: задача → наблюдаемый симптом → evidence (где/когда/путь) → root cause либо NOT PROVEN → изменённые файлы → тесты/CI → потенциальный риск → rollback → что осталось проверить физически → branch/head/PR. Указать явно, какие SSH-соединения реально открывались и были ли production-мутации.

См. [docs/AGENT_PLAYBOOK.md](docs/AGENT_PLAYBOOK.md) и [docs/PRODUCTION_DIAGNOSTICS.md](docs/PRODUCTION_DIAGNOSTICS.md).
