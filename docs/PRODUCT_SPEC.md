# Product Specification

## 1. Product vision

Artem Control Center превращает Samsung Notebook 9 Pro 13" в персональный стационарный и переносной touch-пульт:

- информационный экран на столе;
- панель умного дома;
- центр мониторинга личных и рабочих сервисов;
- capability-based control plane;
- календарь и список задач;
- менеджер резервных копий;
- безопасный launcher автоматизаций и deployments;
- обычный ноутбук для более длительных действий.

Первый MVP не должен быть «технически работающим, но некрасивым». Design system, day/night themes, touch feedback и signature animations входят в первую вертикальную версию.

## 2. Host usage modes

### Ambient mode

Используется большую часть времени, когда ноутбук стоит на столе.

Обязательные элементы:

- часы и дата;
- выбранная weather location, текущая погода и краткий прогноз;
- ближайшее событие календаря;
- ближайшие/просроченные задачи;
- состояние кофемашины;
- агрегированный статус сервисов;
- freshness последних критичных backups;
- питание, батарея и сеть;
- критичные предупреждения.

Поведение:

- минимальная визуальная плотность;
- сниженная яркость и интенсивность motion;
- отсутствие постоянных отвлекающих циклических анимаций;
- пробуждение полного UI касанием;
- cached values всегда имеют timestamp и stale state.

### Control mode

Главный интерактивный режим:

- крупные touch targets;
- быстрые действия;
- подробные состояния;
- переходы между Home, Services, Calendar, Tasks, Automations, Backups, Apps и Settings;
- actions строятся динамически по capabilities проекта.

### Desktop mode

Кнопка `Рабочий стол` сворачивает kiosk и открывает обычную Windows/Linux-сессию. Возврат в панель доступен одной кнопкой/ярлыком.

### Handheld mode

Когда ноутбук берут в руки:

- элементы не привязаны к точному положению курсора;
- свайпы имеют видимую альтернативу;
- интерфейс корректно работает при изменении ориентации;
- опасные кнопки не располагаются в grip zones;
- случайный поворот/касание не может запустить destructive action.

### Incident mode

При сбое панель показывает:

- affected project/environment/service;
- точку сбоя в dependency chain;
- last success и freshness;
- доступные recovery actions;
- backup freshness;
- результат последней попытки восстановления;
- correlation id и sanitized diagnostics.

## 3. Main navigation

### Overview

- multi-location weather;
- часы и дата;
- next event;
- focus tasks;
- summary cards Home/Services/Backups;
- active incidents;
- quick actions.

### Home

- кофемашина;
- чайник;
- свет;
- розетки;
- климат;
- сцены;
- локально доступные offline actions;
- доступность remote HA и local edge.

### Services

Для каждого project/environment/service:

- status;
- latency;
- last successful check;
- version/commit where available;
- dependencies;
- incident history;
- enabled capabilities;
- allowed actions, которых может быть ноль;
- backup state where enabled;
- audit history.

Monitor-only сервис не показывает пустую action bar и считается полноценным supported project.

### Calendar

- day/week/agenda modes;
- ближайшие события на Overview;
- агрегирование нескольких источников;
- визуальное различение календарей;
- read-only режим как безопасный baseline;
- создание/изменение событий только через adapter с подтверждённой write capability.

### Tasks

- today;
- overdue;
- upcoming;
- quick complete;
- quick create;
- TickTick adapter;
- graceful fallback на read-only feed или официальный app/web, если API не покрывает операцию.

### Automations

- n8n workflows;
- health checks;
- deployment/verification workflows;
- scheduled maintenance;
- Wake-on-LAN;
- registered server-side procedures;
- arbitrary workflow id или shell input из браузера запрещены.

### Backups

- проекты с backup capability;
- создать backup;
- выбрать optional sync destination;
- показать stages, size, checksum и verification;
- backup history;
- local/cloud/external-drive destination state;
- retention warnings;
- restore-test freshness;
- открыть folder/manifest.

### Apps

- Android loyalty card;
- Home Assistant UI;
- TickTick official app/web;
- Uptime Kuma;
- selected admin panels.

### System

- питание от сети;
- заряд и состояние батареи;
- health диска;
- свободное место и backup quotas;
- CPU/RAM/temperature;
- Internet/LAN/VPN;
- Panel Agent и Chromium status;
- firewall/update/security status;
- kiosk restart;
- reboot/shutdown with confirmation;
- logs and audit.

### Settings

- add/edit/disable/remove project;
- add environments/services;
- enable/disable capabilities;
- configure actions independently;
- configure backup profiles/destinations;
- manage saved weather locations;
- theme and ambient preferences;
- integration credentials through secure backend flow;
- export config without secrets.

## 4. Project onboarding

Подключение нового проекта не требует фиксированного набора кнопок и по возможности не требует изменений dashboard core.

Capabilities:

- monitor;
- details;
- actions;
- deploy;
- backup;
- restore;
- logs;
- open;
- heartbeat;
- notifications.

Все capabilities optional. Проект может быть:

- monitor-only;
- backup-only;
- monitor + one action;
- monitor + multiple actions;
- temporarily disabled;
- split by stage/main/production environments.

Frontend строит доступные controls по server-provided schema. Подробнее: `docs/PROJECT_ONBOARDING.md`.

## 5. Weather

Погода обязательна в MVP и поддерживает несколько сохранённых локаций.

### Locations

Пользователь может:

- искать город, район или адрес, например `Москва, Очаковский район` или `Санкт-Петербург`;
- подтвердить найденную точку на карте/в списке;
- сохранить название для отображения;
- быстро переключаться между favourite locations;
- выбрать default location;
- временно открыть несохранённое место;
- изменить порядок locations;
- удалить location без удаления weather history других мест.

Geocoding обязан показывать нормализованный адрес и координаты до сохранения. Прогноз для названного района may proxy ближайшую weather grid point и не является измерением именно у конкретного дома; UI показывает выбранную точку и provider freshness.

### Data

- current conditions;
- feels-like temperature;
- precipitation probability/intensity;
- next hours summary;
- daily high/low;
- wind/gusts;
- sunrise/sunset;
- location and data freshness;
- cached last-known response;
- explicit stale state.

Источник погоды и geocoder сменные adapters. Секреты поставщика хранятся только в Panel Agent.

### UI

- location switcher на Overview;
- swipe и visible dropdown/chips;
- weather ambience ограничена по CPU/GPU;
- day/night theme может учитывать sunrise/sunset выбранной default location;
- provider outage не блокирует UI и не смешивает cached data разных locations.

## 6. Day and night themes

Обязательны две полноценные темы, а не простая инверсия цветов.

### Day

- высокая читаемость при дневном освещении;
- более светлые поверхности;
- высокая контрастность важных статусов;
- аккуратные тени и depth.

### Night

- низкая средняя яркость;
- минимизация больших белых областей;
- сохранение различимости warning/error;
- более спокойный ambient motion;
- отсутствие white flash при startup/switch.

Переключение:

- автоматически по solar cycle default weather location;
- Home Assistant preference optional;
- system preference fallback;
- ручной override с expiry или до отмены;
- сохранение выбора;
- мягкая анимированная смена токенов темы.

## 7. Animation quality bar

Красивые анимации обязательны уже для MVP.

Первый runnable vertical slice должен содержать:

- touch press/release feedback;
- shared-layout Overview card → detail;
- morph карточки при смене состояния;
- live command lifecycle;
- animated numbers/progress from real data;
- мягкое day/night switching;
- weather ambience;
- coffee warming/ready transitions;
- service incident/restart timeline;
- reduced-motion mode;
- automatic effects reduction при слабом FPS/high load.

Fake progress запрещён. Skeleton используется только при полном отсутствии cached data.

## 8. Backups

Backup capability независима от deploy/restart.

Manual backup flow:

```text
select profile
→ show scope/destinations
→ optional cloud sync choice
→ prepare/export
→ download locally
→ checksum/archive verification
→ encryption where required
→ optional sync
→ retention
→ success | partial | failed
```

`partial` означает, что не все destinations успешны.

Поддерживаются:

- local SSD;
- optional cloud drive;
- future external HDD/SSD;
- per-project retention;
- quotas/free-space checks;
- encrypted confidential backups;
- restore-test status.

Подробнее: `docs/BACKUP_STRATEGY.md`.

## 9. Home Assistant role

- Home Assistant сам по себе сейчас не имеет отдельного Git repository в проекте.
- `decorum-guy/AliceTG_Bot` — Git repository Telegram-бота, интегрированного в HA stack.
- Remote HA остаётся authoritative в первом этапе.
- Laptop может выполнять limited local edge actions и хранить backups/standby.
- Laptop не принимается как единственный permanent HA primary из-за мобильности, старого железа, single-disk failure domain и необходимости иногда использовать его как обычный ноутбук.
- Предпочтительная долгосрочная схема — отдельный компактный local server для HA, а ноутбук остаётся UI/edge/backup node.

## 10. AVALAR deployment

Для AVALAR Website stage должна быть отдельная registered deploy action, эквивалентная существующей операторской процедуре:

```text
avalar-reg ./deploy.sh stage
```

Control Center не передаёт произвольный shell. Action запускает только заранее зарегистрированный handler, показывает target/ref, выполняет prechecks, deploy, health/browser verification и audit. Main deployment/rollback подключаются отдельно и не выводятся автоматически из stage capability.

## 11. Security and safety UX

Классы действий:

- `instant`: открытие экрана, refresh, safe local toggle;
- `confirm`: действия с умеренными последствиями;
- `hold`: restart, backup, stage deploy;
- `double-confirm`: main deploy, firewall/allow-list, restore, HA failover, shutdown.

Каждое действие показывает фактический результат, а не только успешную отправку запроса.

Security baseline:

- Panel Agent localhost-only;
- no public administrative port;
- separate kiosk profile/account;
- no secrets in frontend/Git;
- firewall and security updates;
- scoped tokens;
- restricted host agents;
- audit and redaction;
- cloud backup encryption for sensitive profiles.

Подробнее: `docs/SECURITY_MODEL.md`.

## 12. Non-functional requirements

- полноценная работа интерфейса при потере Internet;
- локальные assets без обязательных CDN;
- восстановление kiosk после падения;
- cold start после входа без ручных действий;
- низкая фоновая нагрузка;
- Windows first и Linux target;
- отсутствие production secrets во frontend bundle;
- capability-based configuration;
- adapter isolation: failure одного project не роняет dashboard;
- backup/restore verification;
- audit управляющих действий;
- safe mode с read-only cached UI.
