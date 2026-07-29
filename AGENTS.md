# AGENTS.md

Инструкции для Codex и любых разработчиков, работающих с Artem Control Center.

## 1. Product intent

Это не обычный административный dashboard. Интерфейс должен ощущаться как персональная премиальная операционная панель, рассчитанная на постоянное присутствие на столе и управление пальцами.

Приоритеты:

1. Надёжность и понятная обратная связь.
2. Безопасность управляющих действий.
3. Высокое визуальное качество уже с первого MVP.
4. Touch-first UX.
5. Простое capability-based подключение новых проектов.
6. Проверяемые резервные копии и восстановление.
7. Низкое потребление ресурсов на ноутбуке с 8 ГБ RAM.
8. Переносимость Windows → Linux без переписывания frontend.

## 2. Fixed decisions

Не менять без отдельного архитектурного решения:

- Chromium kiosk как основной runtime интерфейса.
- React + TypeScript + Vite для frontend.
- Локальный Panel Agent как единственная точка выполнения системных и удалённых команд.
- Panel Agent localhost-only по умолчанию и не публикуется напрямую в Internet.
- Проекты подключаются декларативно по capabilities; restart/deploy/backup не обязательны.
- Monitor-only project является полноценным supported scenario.
- Backup является отдельной capability и не подразумевает restore/restart/deploy.
- Погода, несколько weather locations, дневная/ночная темы, календарь и задачи входят в обязательный MVP.
- Motion design и signature animations входят в первый visual MVP и Definition of Done.
- Удалённый Home Assistant остаётся authoritative в первом этапе.
- `AliceTG_Bot` — child service HA stack, а не repository Home Assistant.
- Локальный fallback не создаёт два одновременно активных HA-контроллера.
- Старый ноутбук не становится единственным permanent HA primary; предпочтительный долгосрочный primary — отдельный compact server.
- Proxy server считается server-managed системой без Git repository до появления отдельного source repository.

## 3. Frontend requirements

- Проектировать сначала для 13.3" touch display.
- Минимальная активная область обычной кнопки: 48×48 CSS px; primary actions больше.
- Навигация не зависит от hover.
- Статус читается по тексту, иконке и форме, не только по цвету.
- Keyboard navigation и visible focus обязательны.
- Не использовать тяжёлые постоянные WebGL-сцены.
- Анимации упрощаются при `prefers-reduced-motion`, низком FPS, high load или battery saver.
- UI переживает потерю backend/Internet: last-known state, timestamp и stale/offline status.
- Никаких fake production data, fake progress или скрытого optimistic success.
- Project card строится из capabilities; отсутствие actions не должно выглядеть ошибкой.
- Backup `partial` не отображается как полный success.

## 4. Motion rules

- 60 FPS — целевой показатель обычных переходов, не гарантия на любом workload.
- Анимации объясняют изменение состояния.
- Первый runnable MVP содержит touch feedback, card expansion, theme transition, weather ambience, command/backup lifecycle и reduced-motion behavior.
- Опасные actions используют hold/double-confirm по policy.
- Action lifecycle: `requested → accepted → executing → verifying → success/failed`.
- Backup lifecycle: `preparing → exporting → downloading → verifying → encrypting → syncing → retention → success/partial/failed`.
- Success только после реальной verification.
- Calm ambient mode обязателен.

## 5. Capability-based onboarding

Каждая интеграция объявляет независимые capabilities:

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

Правила:

- все capabilities optional;
- action не выводится автоматически из типа проекта;
- новая write-capability требует явного opt-in;
- frontend не знает заранее число buttons;
- disable capability не удаляет project/history;
- disabled project не polling и не запускает schedules;
- UI и YAML используют одну schema/validator;
- adapter failure изолирован и не роняет dashboard;
- repository existence не означает active deployment;
- отсутствующий repository не запрещает server-managed integration через restricted agent.

Перед кодом читать `docs/PROJECT_ONBOARDING.md` и `config/projects.example.yaml`.

## 6. Backend and security

- Frontend не хранит administrative tokens, SSH keys, cloud credentials или encryption keys.
- Каждое action имеет stable id, target, schema, risk, confirmation, timeout, cooldown/lock, verification и audit.
- Запрещён endpoint `execute arbitrary command`.
- No shell interpolation с пользовательским input.
- Restart считается успешным только после health verification.
- Deploy stage AVALAR выполняется фиксированным registered handler, эквивалентным `avalar-reg ./deploy.sh stage`; browser не передаёт shell string.
- Firewall/proxy allow-list: validate → diff → confirm → backup → atomic apply → syntax check → reload → verify → rollback.
- Secrets через OS secret store/protected service config; не коммитить реальные значения.
- Separate kiosk/browser profile; no public administrative port.
- Sensitive cloud backups encrypt before upload.
- Audit/logs redacted.

Перед security-sensitive кодом читать `docs/SECURITY_MODEL.md`.

## 7. Backup rules

Backup profile обязан определить:

- source adapter;
- scope/consistency;
- local destination;
- optional destinations;
- encryption;
- retention/quota;
- checksum/archive verification;
- restore-test policy.

Правила:

- HTTP 200 или существующий файл не доказывают успешный backup;
- local laptop copy — baseline, но не единственная надёжная копия;
- cloud/external sync может быть optional per run;
- `partial` state обязателен при неуспешной optional destination;
- no universal `backup whole server` action;
- allow-listed paths/handlers only;
- no copying live database files без consistency contract;
- never delete the only verified copy;
- restore test tracked отдельно;
- HA native backup и AliceTG Bot runtime/source backups — разные artifacts.

Перед backup-кодом читать `docs/BACKUP_STRATEGY.md` и `config/backups.example.yaml`.

## 8. Home Assistant rules

- Remote HA authoritative в первом этапе.
- Локально реализуются только подтверждённые LAN-capable edge actions.
- Warm standby не запускается рядом с primary без fencing/явного переключения.
- Не дублировать automations на двух active HA instances.
- UI различает HA host, HA app, Internet, LAN, device и AliceTG Bot failures.
- Laptop используется как UI/edge/backup/standby-test node, но не sole permanent HA primary.
- Future dedicated compact HA host проектируется отдельно.

## 9. Health contract

Для принадлежащих пользователю сервисов:

```http
GET /health/live
GET /health/ready
GET /health/details
```

- `live`: процесс отвечает.
- `ready`: primary function доступна.
- `details`: protected dependencies/version/storage/backup/deployment state.

Public health не раскрывает secrets, internal IPs, private content или raw traces.

## 10. Weather rules

- Multiple saved locations mandatory.
- Search supports city/district/address through geocoder adapter.
- User confirms normalized address and coordinates.
- Cache is isolated per location.
- District/address forecast may proxy nearest provider grid point; UI shows location and freshness.
- Default location drives ambient weather and optional solar theme schedule.
- Provider/geocoder replaceable; secrets remain in Panel Agent.

## 11. Development workflow

Перед кодом читать соответствующие документы и обновлять их при изменении решений.

Каждая новая integration должна включать:

- adapter interface and capabilities;
- config schema/migration;
- timeout/retry/cache/stale policy;
- degraded/offline behavior;
- health mapping;
- actions independently, if any;
- backup support independently, if any;
- secret boundary;
- tests/fixtures without production secrets;
- documentation;
- performance impact.

Не добавлять крупную dependency без обоснования RAM, CPU, startup time, security and maintenance cost.
