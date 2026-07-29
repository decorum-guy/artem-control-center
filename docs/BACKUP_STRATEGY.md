# Backup and Storage Strategy

## 1. Goal

Artem Control Center должен уметь запускать резервное копирование зарегистрированного проекта одной понятной кнопкой, сохранять backup на ноутбук и, если для profile включена синхронизация, отправлять дополнительную копию во внешнее хранилище.

Backup capability является независимой: проект может поддерживать backup без restart/deploy, а monitor-only проект может не иметь backup вообще.

## 2. Backup is not just file download

Успешный backup означает:

1. источник подготовил консистентные данные;
2. archive/dump получен полностью;
3. вычислены checksum и размер;
4. manifest сохранён;
5. archive читается;
6. локальная запись завершена атомарно;
7. optional destinations синхронизированы либо явно получили отдельный failed status;
8. retention применён;
9. результат появился в audit/history.

Факт HTTP 200 или появления файла не считается достаточной проверкой.

## 3. Backup profile

Каждый profile задаёт:

- project/environment/service;
- source adapter;
- scope;
- consistency method;
- archive format;
- encryption policy;
- local destination;
- optional remote destinations;
- retention;
- schedule optional;
- manual action availability;
- verification;
- restore-test policy.

Пример:

```yaml
id: avalar-site-stage
project_id: avalar-site
source:
  adapter: restricted_ssh_bundle
  handler_ref: avalar_site_stage_backup
local_destination: laptop-primary
remote_destinations:
  - id: cloud-drive
    enabled: ask_each_time
retention:
  keep_last: 10
  keep_daily_days: 14
encryption:
  required: true
verification:
  checksum: sha256
  archive_test: true
```

## 4. Source adapters

Поддерживаемые типы должны быть модульными:

- `git_snapshot` — repository metadata, refs и optional bundle;
- `filesystem_bundle` — только explicit allow-listed paths;
- `database_dump` — Postgres/MySQL/SQLite-specific consistency;
- `docker_volume_export`;
- `home_assistant_backup`;
- `application_export_api`;
- `restricted_ssh_bundle` — заранее определённый server-side script;
- `download_existing_artifact`;
- `config_only`.

Запрещён общий action «скачать весь сервер».

## 5. What a project backup may include

В зависимости от проекта:

- source/config not already protected by Git;
- database dump;
- uploads/media;
- deployment metadata;
- environment template without secrets;
- service unit/container manifests;
- version/commit;
- restore instructions;
- checksums.

Secrets включаются только если это необходимо для восстановления и только в отдельно зашифрованном payload. По умолчанию secrets исключены.

## 6. Local storage layout

```text
<backup-root>/
└── <project-id>/
    └── <environment>/
        └── YYYY/MM/
            ├── <timestamp>-<backup-id>.archive
            └── <timestamp>-<backup-id>.manifest.json
```

Manifest содержит:

- backup id;
- project/environment;
- source version/commit;
- creation timestamps;
- included scopes;
- excluded sensitive scopes;
- archive size;
- checksum;
- encryption state;
- source result;
- destination results;
- restore-test state.

Frontend не показывает secret material.

## 7. Destinations

### Laptop primary storage

Первый destination — внутренний SSD ноутбука.

Ограничения:

- нельзя заполнять системный диск;
- задаются minimum free-space threshold и per-project quota;
- backup блокируется до source execution, если места заведомо недостаточно;
- большие temporary files удаляются после atomic finalize;
- внутренний SSD не считается единственной надёжной копией.

### Cloud drive

Adapter может использовать выбранное пользователем хранилище через безопасный sync layer, например WebDAV/S3/rclone-compatible provider.

Per-profile modes:

- `disabled`;
- `always`;
- `ask_each_time`;
- `scheduled_only`;
- `manual_only`.

Перед upload UI показывает, какие данные и приблизительный размер будут синхронизированы. Confidential backups должны быть encrypted before cloud upload.

### External HDD/SSD

Будущий external storage destination:

- определяется по stable volume id, не по случайной букве диска/mount path;
- проверяется writable state и свободное место;
- отсутствие диска не ломает локальный backup, если profile разрешает degraded destinations;
- можно настроить `required` для особо важных проектов;
- Control Center показывает last seen, filesystem health where available и last successful sync;
- диск безопасно размонтируется через System UI.

## 8. Backup button UX

Project detail может показывать:

- `Создать резервную копию`;
- последний success и возраст;
- размер последней копии;
- destinations;
- restore test status;
- свободное место;
- retention warning.

Flow:

1. выбрать backup profile, если их несколько;
2. показать scope и destinations;
3. спросить optional cloud sync, если mode=`ask_each_time`;
4. hold-to-confirm для medium/high risk sources;
5. показывать реальные этапы: preparing → exporting → downloading → verifying → encrypting → syncing → retention → success/partial/failed;
6. дать открыть папку/manifest, но не secret payload.

`partial` означает, например, что локальная копия успешна, а cloud sync failed. UI не должен называть такой результат полным success.

## 9. Consistency

Для каждого source adapter фиксируется consistency contract:

- static files: snapshot/archive;
- SQLite: online backup API или остановка writer по safe procedure;
- Postgres/MySQL: database-native dump;
- uploads + DB: shared application backup script/version marker;
- Docker volumes: application-aware quiesce where needed;
- Home Assistant: native backup mechanism.

Простое копирование живого database file допускается только если provider гарантирует consistency.

## 10. Encryption and secrets

- encryption keys не попадают во frontend, Git или manifest;
- key availability показывается boolean/status;
- ключ хранится отдельно от backup destinations;
- cloud copy encrypted before upload;
- optional local encryption зависит от threat model, но для credentials/databases рекомендуется обязательно;
- restore procedure должна быть документирована и тестироваться без раскрытия ключа в UI.

## 11. Retention

Поддержать:

- keep last N;
- hourly/daily/weekly/monthly tiers;
- maximum total bytes;
- minimum free disk threshold;
- protected/pinned backups;
- never delete the only verified copy;
- deletion audit.

Retention применяется отдельно на каждом destination. Удаление локальной копии не должно автоматически удалять cloud/external copy без profile policy.

## 12. Restore testing

Backup без теста восстановления may proxy реальную защищённость, но не доказывает её.

Для каждого critical project задаётся:

- last restore test;
- test environment;
- expected checks;
- result;
- next due date.

Restore test должен быть non-destructive и выполняться в sandbox/stage/temporary container, когда это возможно.

## 13. Security boundaries

- browser не получает server paths или SSH credentials;
- Panel Agent вызывает только registered source handler;
- server-side backup scripts allow-list конкретные paths/commands;
- archive проходит filename/path traversal validation;
- checksum сверяется после transfer;
- remote upload credentials scoped by destination;
- downloaded executable content не запускается;
- backup history не раскрывает sensitive filenames без необходимости.

## 14. Home Assistant backup

HA — отдельный native profile:

- backup создаётся штатным механизмом HA;
- копия скачивается на ноутбук;
- optional encrypted off-device sync;
- контролируется age, size and last restore test;
- AliceTG_Bot не является backup source всего HA: это отдельный Git repository внутри HA-стека;
- HA runtime/config/data backup и backup репозитория `AliceTG_Bot` считаются разными artifacts.

## 15. Initial backup candidates

- Artem Control Center config/audit database;
- Home Assistant native backup;
- `AliceTG_Bot` runtime state/config where not already included in HA backup;
- AVALAR Website stage/main server data and deployment metadata;
- AVALAR Exchange MCP application config/database/runbook artifacts;
- proxy-server configs and allow-list, несмотря на отсутствие Git repository;
- n8n workflows/credentials database through a dedicated safe export;
- CleaManager storage when a real deployment exists;
- ИнфоПульс database/config when active deployment is confirmed.

Каждый candidate требует отдельного profile и restore contract; одна универсальная команда не допускается.
