# Project and Service Onboarding

## 1. Goal

Подключение нового проекта к Artem Control Center не должно требовать изменения core-кода панели и не должно подразумевать обязательное наличие управляющих кнопок.

Проект подключается декларативно через **capabilities**. У одного проекта может быть только мониторинг, у другого — мониторинг, резервные копии и несколько безопасных действий, у третьего — только launcher или backup.

## 2. Project, service, environment and component

Эти сущности нельзя смешивать:

- **project** — логическая система, например `AVALAR Website`;
- **environment** — `stage`, `main`, `production`, `local`;
- **service** — отдельный runtime, например frontend, backend, worker или bot;
- **component** — зависимость внутри service health: database, relay, API provider, storage;
- **action** — отдельная разрешённая операция;
- **backup profile** — способ создать и сохранить резервную копию;
- **widget definition** — зарегистрированный тип визуального представления;
- **widget instance** — конкретное размещение widget в пользовательском layout.

Один project может содержать несколько environments и services. Например, AVALAR Website имеет отдельные `stage` и `main`, которые мониторятся и управляются независимо.

## 3. Capability model

Поддерживаемые capabilities:

- `monitor` — состояние, latency, incidents и dependencies;
- `details` — защищённая диагностика;
- `actions` — одна или несколько заранее разрешённых команд;
- `deploy` — отдельный тип action с более строгой policy;
- `backup` — создание и скачивание резервной копии;
- `restore` — потенциально опасная операция, не обязательная для backup-capable проекта;
- `logs` — только sanitized recent logs;
- `open` — открыть UI проекта;
- `notifications` — получать incident events;
- `heartbeat` — push status для scheduled jobs.

Ни одна capability не обязательна, кроме стабильного `project id`. Monitor-only проект является полноценным поддерживаемым сценарием.

Примеры:

```text
Статический сайт:
monitor + open + optional deploy + backup

Telegram bot:
monitor + restart + logs + backup

Внешний API, которым нельзя управлять:
monitor only

Локальный архив:
backup only

Home Assistant:
monitor + selected actions + backup; restore отдельно и с повышенным риском
```

## 4. Declarative registration

Проекты регистрируются в `config/projects.yaml` или через Settings UI, который сохраняет ту же schema.

Пример monitor-only:

```yaml
projects:
  - id: external-provider
    name: External Provider
    enabled: true
    capabilities:
      monitor:
        adapter: http
        url_env: EXTERNAL_PROVIDER_HEALTH_URL
    actions: []
    backups: []
```

Пример проекта с несколькими actions:

```yaml
projects:
  - id: avalar-site
    name: AVALAR Website
    environments:
      - id: stage
        capabilities:
          monitor: { adapter: web }
          deploy: { action_id: avalar.deploy.stage }
          backup: { profile_id: avalar-site-stage }
      - id: main
        capabilities:
          monitor: { adapter: web }
          backup: { profile_id: avalar-site-main }
```

Frontend не содержит заранее зашитое число кнопок. Он строит карточку по capabilities и policy, полученным от Panel Agent.

## 5. Onboarding flow

UI `Settings → Projects → Add`:

1. Задать project name и stable id.
2. Выбрать тип источника: HTTP, Home Assistant, systemd/Docker host agent, Uptime Kuma, GitHub, n8n, custom adapter.
3. Добавить environments и services.
4. Выбрать capabilities.
5. Настроить credentials через secret store, не через frontend config.
6. Выполнить read-only connection test.
7. Показать обнаруженные health paths/capabilities без автоматического разрешения write actions.
8. Добавить actions по одной, с risk class, schema, confirmation и verification.
9. При необходимости добавить backup profile и destinations.
10. Preview карточки проекта.
11. Enable project.
12. Дождаться нового registry revision и frontend reconciliation.
13. Показать созданный generic/specialized widget и ссылку `Открыть в Services`.

Подключение можно сделать и через YAML. UI и YAML используют одну schema и один validator.

## 6. Automatic UI materialization

Onboarding не считается завершённым после одной записи backend-конфигурации.

После enable:

1. Panel Agent увеличивает registry revision.
2. Frontend получает полный catalog snapshot либо registry event.
3. Widget Resolver ищет compatible specialized widget.
4. При отсутствии specialized widget создаётся обязательный `core.generic-service`.
5. Service автоматически появляется в полном каталоге `Services`.
6. Новый widget появляется в `New items` и в default/inbox placement area, если не установлен `catalog_only`.
7. Automated test подтверждает, что service виден и его detail открывается.

Нельзя требовать отдельный frontend commit только для того, чтобы новый monitor-only service появился на экране.

No service may silently exist only in Panel Agent config.

Полный widget contract: `docs/WIDGET_SYSTEM.md`.

## 7. Enable, disable and remove

- `enabled: false` временно скрывает active probes/actions, но сохраняет config/history/layout references.
- capability можно отключить отдельно: например, оставить мониторинг и убрать restart.
- action можно отключить без удаления project.
- удаление project не удаляет backups автоматически.
- отключённый project не продолжает polling или scheduled backups.
- secrets удаляются отдельной подтверждаемой операцией.
- hide widget не равен disable project: скрытый widget не останавливает monitoring.
- re-enable project запускает UI reconciliation и возвращает widget, если active instance отсутствует.

## 8. Action independence

Actions не выводятся из названия или типа проекта. Каждая action регистрируется отдельно.

Обязательные поля:

- stable `action_id`;
- target project/environment/service;
- risk class;
- input schema;
- confirmation mode;
- timeout;
- cooldown/lock scope;
- executor;
- verification;
- rollback, если возможен;
- audit redaction policy.

Таким образом, проект может иметь 0, 1 или любое разумное число управляющих действий.

## 9. Adapter contract

Каждый adapter объявляет:

- поддерживаемые capabilities;
- configuration schema;
- required secrets;
- health mapping;
- timeout/retry/cache policy;
- offline/stale behavior;
- actions и schemas;
- backup support;
- compatible widget data contracts;
- version compatibility.

Adapter не может автоматически включать опасную capability после обновления. Новые write-capabilities требуют явного opt-in.

## 10. Validation and testing

Перед enable:

- config schema valid;
- credentials resolvable;
- read-only probe passes либо явно сохраняется как not-yet-reachable;
- no duplicate project/environment/service ids;
- action ids unique;
- verification strategy exists для write actions;
- backup destination writable для enabled backup profiles;
- no secret is rendered into browser state;
- compatible widget exists or generic fallback is available.

После enable:

- registry revision changed;
- service appears in catalog;
- widget instance materialized;
- actions match capability policy;
- monitor-only service has no empty action bar;
- disabling stops polling;
- re-enabling restores visibility without losing history.

Для custom adapter обязательны unit tests и fixture без production secrets.

## 11. Discovery without unsafe assumptions

Panel Agent может предложить найденные endpoints или services, но не должен:

- считать любой systemd service безопасным для restart;
- создавать arbitrary shell action;
- включать deploy по наличию `deploy.sh`;
- копировать весь server filesystem в backup;
- считать repository existence доказательством active deployment;
- автоматически назначать write-capability найденному widget;
- скрывать unknown service вместо generic fallback.

Discovery создаёт draft config. Владелец явно утверждает capabilities.

## 12. UI behavior

Project card показывает только реально доступные элементы:

- monitor-only: status и details без action bar;
- one-action: одна primary/secondary button;
- multi-action: quick actions + expanded action sheet;
- backup-capable: backup status и кнопка создания backup;
- disabled action: причина policy/dependency, а не пустая кнопка.

Карточка не выглядит сломанной, если у проекта нет действий.

Enabled service всегда доступен в Services catalog. Dashboard placement является дополнительным представлением, а не единственным способом найти service.

## 13. Settings UI

Обычные настройки выполняются внутри приложения:

- add/edit/disable/remove project;
- add environment/service;
- enable/disable capability;
- add/remove registered action;
- select compatible widget;
- show/hide/pin widget;
- configure safe widget settings;
- manage backup profile/destination;
- preview config and card;
- view registry revision;
- export config without secrets.

Не выносятся в обычные user settings:

- arbitrary code;
- adapter implementation;
- raw shell command;
- unrestricted API request;
- privilege escalation;
- schema-breaking architecture changes.

## 14. Versioning and migration

- config имеет schema version;
- migrations выполняются Panel Agent;
- unknown capability не игнорируется молча;
- backup config экспортируется отдельно от secrets;
- layout/widget references migrate by stable ids;
- before incompatible migration create local config/database backup;
- migration must reconcile UI and report orphaned widgets/services explicitly.
