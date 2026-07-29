# Product Specification

## 1. Product vision

Artem Control Center превращает Samsung Notebook 9 Pro 13" в персональный стационарный и переносной touch-пульт:

- информационный экран на столе;
- панель умного дома;
- автоматически формируемый центр мониторинга личных и рабочих сервисов;
- capability-based control plane;
- календарь и список задач;
- менеджер резервных копий;
- безопасный launcher автоматизаций и deployments;
- обычный ноутбук для более длительных действий.

Первый MVP не должен быть «технически работающим, но некрасивым». Design system, day/night themes, touch feedback, coffee-machine visualization и signature animations входят в первую вертикальную версию.

## 2. Host usage modes

### Ambient mode

Используется большую часть времени, когда ноутбук стоит на столе.

Обязательные элементы:

- часы и дата;
- выбранная weather location, текущая погода и краткий прогноз;
- ближайшее событие календаря;
- ближайшие/просроченные задачи;
- обязательный live coffee-machine widget;
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
- actions строятся динамически по capabilities проекта;
- widgets строятся через Widget Registry, а не hard-coded page lists.

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
- обязательный coffee-machine widget;
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
- локально доступные Edge actions;
- доступность remote HA и local edge.

### Services

Services — автоматически сформированный полный каталог enabled projects/environments/services.

Для каждого service:

- status;
- latency;
- last successful check;
- version/commit/config revision where available;
- dependencies;
- incident history;
- enabled capabilities;
- allowed actions, которых может быть ноль;
- backup state where enabled;
- audit history;
- generic или specialized widget presentation.

Monitor-only сервис не показывает пустую action bar и считается полноценным supported project.

Новый enabled service автоматически появляется в Services. Ручное дописывание его ID во frontend запрещено.

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

Settings предоставляет обычные пользовательские настройки без редактирования кода:

- add/edit/disable/remove project;
- add environments/services;
- enable/disable capabilities;
- configure actions independently;
- configure backup profiles/destinations;
- manage saved weather locations;
- enable/disable/show/hide/pin widgets;
- choose compatible generic/specialized widget;
- edit widget-safe settings;
- preview dashboard/layout;
- manage theme and ambient preferences;
- integration credentials through secure backend flow;
- export config without secrets.

Не выносятся в Settings:

- arbitrary code;
- adapter implementation;
- raw shell commands;
- unrestricted network calls;
- privilege escalation;
- schema-breaking architecture changes.

## 4. Project onboarding and automatic UI appearance

Подключение нового проекта не требует фиксированного набора кнопок и не требует изменений dashboard core.

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

После enable:

1. Panel Agent validates config.
2. Registry revision changes.
3. Frontend receives complete catalog snapshot/event.
4. Widget Resolver chooses a specialized widget.
5. If none exists, Generic Service Widget is mandatory.
6. Service appears in Services and `New items`.
7. UI test confirms visibility.

Onboarding is not successful while a service exists only in backend configuration.

Подробнее: `docs/PROJECT_ONBOARDING.md` и `docs/WIDGET_SYSTEM.md`.

## 5. Widget platform

### MVP

- Widget Registry;
- widget manifest/data/settings contract;
- Generic Service Widget;
- automatic materialization and layout reconciliation;
- mandatory specialized coffee widget;
- weather, services, backups, calendar/tasks and system widgets;
- stable default layouts;
- safe show/hide/pin where Settings scope permits.

### Post-MVP layouts

User can:

- drag widgets;
- resize within widget limits;
- move between pages/sections;
- pin/unpin;
- hide without disabling project;
- reset layout;
- create named layouts;
- use separate ambient/control/handheld layouts.

A new widget must never overwrite or silently displace existing layout content. It goes to a deterministic free location or `New items` inbox.

### Custom coded widgets

Codex creates widgets through one template containing manifest, typed contract, settings schema, fixtures and tests. A custom widget is registered globally and is not manually imported into an individual page.

### No-code user widgets — later phase

Planned presets:

- link;
- HTTP/status check;
- metric/value;
- text/note;
- clock/countdown;
- grouped services;
- image/icon launcher;
- registered action launcher;
- simple sanitized JSON field mapping.

Possible user settings include link, registered source, refresh interval, timeout, formatting, thresholds, icon, date/time and layout size.

No arbitrary JavaScript, HTML, shell or direct browser fetch is allowed.

## 6. Coffee Machine Widget — mandatory P0 MVP

The coffee-machine widget is not optional and is not postponed after MVP.

States:

- off;
- turning on;
- warming;
- ready;
- running;
- running too long;
- turning off;
- unavailable;
- stale;
- later Edge fallback where verified.

Shows:

- source authority;
- state and freshness;
- start time;
- real warm-up progress or known duration-based progress;
- remaining time;
- ready status;
- running duration;
- long-running warning;
- command lifecycle.

Behavior:

- animated real progress, never invented;
- distinct stage/color transitions rather than meaningless continuous gradient;
- restrained steam/heat visualization;
- calm ready transition;
- visible long-running warning;
- turn on/off and detail actions;
- duplicate `turn_on` does not restart timers;
- success only after source state verification;
- reduced-motion and low-performance variants;
- deterministic Mac fixtures for every state;
- final touch/performance validation on Windows.

## 7. Weather

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

Geocoding показывает нормализованный адрес и координаты до сохранения. Прогноз района может представлять ближайшую weather grid point; UI показывает выбранную точку и provider freshness.

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

Источник погоды и geocoder — сменные adapters. Cache изолирован по location.

## 8. Day and night themes

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

## 9. Animation quality bar

Красивые анимации обязательны уже для MVP.

Первый runnable vertical slice содержит:

- touch press/release feedback;
- shared-layout Overview card → detail;
- morph карточки при смене состояния;
- live command lifecycle;
- animated numbers/progress from real data;
- мягкое day/night switching;
- weather ambience;
- coffee warming/ready transitions;
- service incident/restart timeline;
- backup lifecycle;
- reduced-motion mode;
- automatic effects reduction при слабом FPS/high load.

Fake progress запрещён. Skeleton используется только при полном отсутствии cached data.

## 10. Backups

Backup capability независима от deploy/restart.

Manual flow:

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

Поддерживаются local SSD, optional cloud drive, future external HDD/SSD, retention, quotas, encryption and restore-test status.

## 11. Home Assistant role — fixed

- Home Assistant сам по себе сейчас не имеет отдельного Git repository в проекте.
- `decorum-guy/AliceTG_Bot` — repository Telegram-бота в HA stack.
- Remote HA остаётся authoritative в первом этапе.
- Samsung laptop **никогда не запускает Home Assistant**: ни primary, ни standby, ни test instance.
- Laptop выполняет только Control Center, monitoring, backups и отдельно проверенные local Edge actions.
- Предпочтительная долгосрочная схема — отдельный compact local server для HA.
- Restore tests выполняются на отдельном approved host, не на panel laptop.

## 12. AVALAR deployment

Для AVALAR Website stage должна быть отдельная registered deploy action, эквивалентная:

```text
avalar-reg ./deploy.sh stage
```

Control Center не передаёт произвольный shell. Action запускает зарегистрированный handler, показывает target/ref, выполняет prechecks, deploy, health/browser verification и audit. Main deployment/rollback подключаются отдельно.

## 13. Security and safety UX

Классы действий:

- `instant`: открытие экрана, refresh, safe local toggle;
- `confirm`: действия с умеренными последствиями;
- `hold`: restart, backup, stage deploy;
- `double-confirm`: main deploy, firewall/allow-list, restore, HA migration, shutdown.

Каждое действие показывает фактический результат, а не только успешную отправку запроса.

Security baseline:

- Panel Agent localhost-only;
- no public administrative port;
- separate kiosk profile/account;
- no secrets in frontend/Git;
- firewall and security updates;
- widget/user preset network access only through protected Panel Agent adapters.

## 14. macOS development mode

The UI and most backend behavior must run on the owner's Mac for development.

Mac supports:

- React/Vite UI;
- ordinary Chromium/Chrome window;
- simulated kiosk viewport;
- Panel Agent fixtures/read-only modes;
- widget gallery;
- coffee fixtures;
- settings/layout testing;
- Playwright Chromium;
- screenshot and accessibility tests;
- automatic service materialization tests.

Mac does not prove:

- Samsung touch behavior;
- Windows kiosk/autostart;
- BlueStacks loyalty app;
- power/lid/thermal behavior;
- real Windows privileged helper.

After Mac tests pass, Codex supplies an exact Windows validation checklist for hardware-dependent changes.

## 15. Non-functional requirements

- полноценная работа UI shell при потере Internet;
- local functions do not depend on external CDN;
- UI assets supplied locally;
- kiosk recovery after crash;
- cold start without manual actions;
- low background load;
- automatic registry/UI reconciliation;
- widget failure isolation;
- support macOS development, Windows-first production and future Linux target;
- no production secrets in frontend bundle;
- complete audit of control actions;
- Settings covers ordinary configuration without exposing arbitrary code.
