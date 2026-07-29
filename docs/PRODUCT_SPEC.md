# Product Specification

## 1. Product vision

Artem Control Center превращает Samsung Notebook 9 Pro 13" в персональный стационарный и переносной touch-пульт:

- информационный экран на столе;
- панель умного дома;
- центр мониторинга личных и рабочих сервисов;
- календарь и список задач;
- безопасный launcher автоматизаций;
- обычный ноутбук для более длительных действий.

## 2. Host usage modes

### Ambient mode

Используется большую часть времени, когда ноутбук стоит на столе.

Обязательные элементы:

- часы и дата;
- текущая погода и краткий прогноз;
- ближайшее событие календаря;
- ближайшие/просроченные задачи;
- состояние кофемашины;
- агрегированный статус сервисов;
- питание, батарея и сеть;
- критичные предупреждения.

Поведение:

- минимальная визуальная плотность;
- сниженная яркость и интенсивность motion;
- отсутствие постоянных отвлекающих циклических анимаций;
- пробуждение полного UI касанием.

### Control mode

Главный интерактивный режим:

- крупные touch targets;
- быстрые действия;
- подробные состояния;
- переходы между Home, Services, Calendar, Tasks, Automations и Apps.

### Desktop mode

Кнопка `Рабочий стол` сворачивает kiosk и открывает обычную Windows/Linux-сессию. Возврат в панель должен быть доступен одной кнопкой/ярлыком.

### Handheld mode

Когда ноутбук берут в руки:

- элементы не должны быть привязаны к точному положению курсора;
- поддерживаются свайпы, но все действия имеют видимую альтернативу;
- интерфейс корректно работает при изменении ориентации;
- опасные кнопки не размещаются рядом с краями, за которые держат устройство.

## 3. Main navigation

### Overview

- погода;
- часы и дата;
- next event;
- focus tasks;
- summary cards Home/Services;
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

Для каждого сервиса:

- status;
- latency;
- last successful check;
- version/commit where available;
- environment;
- dependencies;
- incident history;
- allowed actions;
- audit history.

### Calendar

- day/week/agenda modes;
- ближайшие события на Overview;
- агрегирование нескольких источников;
- визуальное различение календарей;
- read-only режим как безопасный baseline;
- создание/изменение событий только через source adapter с явной поддержкой write.

### Tasks

- today;
- overdue;
- upcoming;
- quick complete;
- quick create;
- TickTick adapter;
- graceful fallback на read-only feed/открытие официального приложения, если API не покрывает нужную операцию.

### Automations

- n8n workflows;
- backup jobs;
- deployment/verification workflows;
- scheduled maintenance;
- Wake-on-LAN;
- повторные health checks.

### Apps

- Android loyalty card;
- Home Assistant UI;
- TickTick official app/web;
- Uptime Kuma;
- selected admin panels.

### System

- питание от сети;
- заряд батареи;
- health диска;
- свободное место;
- CPU/RAM/temperature;
- Internet/LAN/VPN;
- Panel Agent status;
- kiosk restart;
- reboot/shutdown with confirmation;
- logs and audit.

## 4. Weather

Погода обязательна в MVP.

Требования:

- current conditions;
- feels-like temperature;
- precipitation probability;
- next hours summary;
- daily high/low;
- location and data freshness;
- cached last-known response;
- explicit stale state when source is unavailable.

Источник погоды должен быть сменным adapter-ом. Секреты поставщика хранятся только в Panel Agent.

## 5. Day and night themes

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
- более спокойный ambient motion.

Переключение:

- автоматически по локальному времени/солнечному циклу;
- ручной override;
- сохранение выбора;
- мягкая анимированная смена токенов темы.

## 6. Animation quality bar

Продукт должен быть приятно наблюдать и трогать.

Обязательные паттерны:

- morph карточки при смене состояния;
- spring response на нажатие;
- shared-layout переходы между summary и detail;
- live progress для разогрева кофемашины и выполнения команд;
- animated number transitions;
- incident pulse без агрессивного мигания;
- мягкая смена day/night;
- weather ambience, ограниченная по CPU/GPU;
- skeleton/loading только при первом отсутствии данных;
- optimistic UI допускается только для неопасных действий и всегда помечается как pending до подтверждения.

## 7. Safety UX

Классы действий:

- `instant`: свет, открытие экрана, повторная проверка;
- `confirm`: включение/выключение устройств с последствиями;
- `hold`: restart сервиса, backup restore, deployment;
- `double-confirm`: firewall/allow-list, выключение сервера, failover HA.

Каждое действие показывает фактический результат, а не только успешную отправку запроса.

## 8. Non-functional requirements

- полноценная работа интерфейса при потере Internet;
- локальные функции не зависят от внешнего CDN;
- UI assets поставляются локально;
- восстановление kiosk после падения;
- cold start после входа в систему без ручных действий;
- низкая фоновая нагрузка;
- поддержка Windows на первом этапе и Linux как target;
- отсутствие production secrets в frontend bundle;
- аудит управляющих действий.
