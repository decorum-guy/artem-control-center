# AGENTS.md

Инструкции для Codex и любых разработчиков, работающих с Artem Control Center.

## 1. Product intent

Это не обычный административный dashboard. Интерфейс должен ощущаться как персональная премиальная операционная панель, рассчитанная на постоянное присутствие на столе и управление пальцами.

Приоритеты по порядку:

1. Надёжность и понятная обратная связь.
2. Безопасность управляющих действий.
3. Высокое визуальное качество.
4. Touch-first UX.
5. Низкое потребление ресурсов на ноутбуке с 8 ГБ RAM.
6. Переносимость Windows → Linux без переписывания frontend.

## 2. Fixed decisions

Не менять без отдельного архитектурного решения:

- Chromium kiosk как основной runtime интерфейса.
- React + TypeScript + Vite для frontend.
- Локальный backend/Panel Agent как единственная точка выполнения системных и удалённых команд.
- Удалённый Home Assistant является primary.
- Локальный fallback не должен создавать два одновременно активных HA-контроллера.
- Погода, дневная/ночная темы, календарь и задачи входят в обязательный MVP.
- Motion design входит в Definition of Done.

## 3. Frontend requirements

- Интерфейс проектируется сначала для 13.3" touch display.
- Минимальная активная область обычной кнопки: 48×48 CSS px; для основных действий — больше.
- Навигация не должна зависеть от hover.
- Все важные состояния должны читаться без цвета: текст, иконка и форма обязательны.
- Поддерживать keyboard navigation и visible focus.
- Не использовать тяжёлые фоновые WebGL-сцены на постоянной основе.
- Анимации должны автоматически упрощаться при `prefers-reduced-motion`, низком FPS или battery saver.
- UI обязан переживать потерю backend/Internet: показывать last-known state, timestamp и явный stale/offline status.
- Никаких фейковых показателей и моков в production mode.

## 4. Motion rules

- 60 FPS — целевой показатель для обычных переходов.
- Анимации должны объяснять изменение состояния, а не просто украшать экран.
- Опасные действия используют hold-to-confirm с прогрессом.
- После команды UI показывает цепочку `requested → accepted → executing → verifying → success/failed`.
- Нельзя показывать success до подтверждённого health/state check.
- Предусмотреть calm ambient mode для постоянного отображения на столе.

## 5. Backend and security

- Frontend не хранит административные токены, SSH private keys и пароли.
- Panel Agent слушает localhost по умолчанию.
- Любое действие описано в allow-list и имеет стабильный action id.
- Запрещён endpoint вида `execute arbitrary command`.
- Действия должны поддерживать RBAC/policy, confirmation mode, cooldown, timeout и audit log.
- Перезапуск сервиса считается успешным только после health verification.
- Управление firewall/proxy allow-list должно быть транзакционным: validate → apply → verify → rollback on failure.
- Секреты только через environment/secret store; никогда не коммитить реальные адреса, токены и ключи в public examples.

## 6. Home Assistant rules

- Primary HA остаётся удалённым.
- Для локального offline-управления реализуются только явно выбранные edge actions, способные работать по LAN.
- Warm standby HA не запускается автоматически рядом с primary без fencing/явного переключения.
- Не дублировать автоматизации на двух активных HA-инстансах.
- UI различает `remote HA unavailable`, `Internet unavailable`, `LAN unavailable` и `device unavailable`.

## 7. Health contract

Для принадлежащих пользователю сервисов целевой endpoint:

```http
GET /health/live
GET /health/ready
GET /health/details
```

- `live`: процесс отвечает.
- `ready`: сервис способен выполнять основную функцию.
- `details`: защищённый диагностический ответ с зависимостями и версиями.

Публичный health не должен раскрывать секреты, внутренние IP, полные exception traces или персональные данные.

## 8. Development workflow

Перед кодом читать документы из `docs/` и обновлять их при изменении решений.

Каждая новая интеграция должна включать:

- adapter interface;
- timeout/retry policy;
- degraded/offline behavior;
- health mapping;
- action policy;
- tests;
- documentation.

Не добавлять крупную зависимость без обоснования влияния на RAM, CPU и startup time.
