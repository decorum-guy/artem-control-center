# Штатный выпуск Control Center на Samsung

Кандидат `codex/youtube-music-release` включает принятую цепочку #372–#374 и актуальные правила доступа из #371. Исследование и независимые предыдущие результаты остаются в своих отчётах. SHA устанавливаемого дерева фиксируется в PR и проверяется по CI перед установкой. Последние фактически прочитанные `main` и основной runtime на 8787 — `2b361918f11ba2ae40805fa65bcdbe1b3f6f99d8`. Сверить `last-known-good.txt`, ветку и HTTP-версию повторно непосредственно перед работами.

## Подготовка под пользователем задачи Windows

1. Сверить [карту доступа](../INFRASTRUCTURE_ACCESS.md), [Windows runtime](../WINDOWS_PRODUCTION_RUNTIME.md), [голосовые сценарии и пульт](../TV_ACCESS.md). Установочной машиной остаётся Samsung. Проверить версию установленного Edge, доступность Happ на `127.0.0.1:10809`, существующий приватный HA-маршрут, TV Executor и задачу `Artem Control Center Runtime` с интерактивным входом штатного Windows-пользователя. Updater сам устанавливает версионную Python-среду, в которой на Windows появится Playwright. Команда установки браузеров для этой функции не требуется.
2. Сделать защищённую локальную копию runtime.env, политики доступа, capability overrides, раскладок, видимости устройств, настроек календаря, пользовательских данных/кэшей, истории удержания, текущих vault и маркеров last-known-good. Список фактических путей брать из runtime.env и конфигурации; отдельно учесть checkout-пути, например настроенный `PANEL_OVERVIEW_LAYOUT_PATH`. Planning и напоминания Яндекса обслуживаются существующими внешними источниками. Проверка доступности и сверка данных не требуют изменения или очистки их хранилищ.
3. Основной корень — `%LOCALAPPDATA%\ArtemControlCenter`. Подготовить под тем же Windows-пользователем защищённый каталог `station-credentials` c ACL владельца и SYSTEM. В runtime.env использовать **абсолютные развёрнутые пути**. Перенос с preview возможен на этой же машине и только под тем же пользователем DPAPI. Сначала сверить читаемость тестовым открытием без вывода содержимого. Копировать только четыре vault. Выделенный профиль Edge создаётся помощником рядом с browser vault. При подготовке использовать проверенную сессию из vault или обычное «Подключить YouTube Music» под основным процессом; следующий автоматический recovery станет доступен после входа в его собственном профиле. Kiosk-профиль `edge-profile` хранится отдельно.

| Подключение | Файл в закрытом каталоге | Постоянная переменная |
| --- | --- | --- |
| Station / Яндекс Музыка | `oauth.dpapi` | `PANEL_STATION_PLAYBACK_CREDENTIAL_FILE` |
| Нативные напоминания | `reminders.dpapi` | `PANEL_STATION_REMINDER_CREDENTIAL_FILE` |
| Лайки и подтверждение канала YouTube Data API | `youtube-music.dpapi` | `PANEL_YOUTUBE_MUSIC_CREDENTIAL_FILE` |
| Каталоги, плейлисты и обложки YouTube Music | `youtube-library.dpapi` | `PANEL_YOUTUBE_LIBRARY_CREDENTIAL_FILE` |

## Конфигурация выпуска

| Функция | Настройки |
| --- | --- |
| Основной режим | `PANEL_AGENT_MODE=production`. Сохранить утверждённый профиль доступа, общие и узкие write gates, рабочие HA и Alice подключения. |
| Станция | `PANEL_STATION_PLAYBACK_HOST`, `PANEL_STATION_PLAYBACK_CERT_SHA256`, `PANEL_STATION_PLAYBACK_DEVICE_ID`, `PANEL_STATION_PLAYBACK_VOICE_ENTITY` по проверенной конфигурации Mini 2. `PANEL_STATION_RETENTION_ENABLED=true`. |
| Напоминания | Фактические `PANEL_STATION_REMINDER_DEVICE_ID` и `PANEL_STATION_REMINDER_HOME_ID` из проверенного дома и Mini 2. `PANEL_STATION_REMINDER_WRITES_ENABLED=true` для утверждённой записи. |
| Музыка | `PANEL_MUSIC_LIBRARY_ENABLED=true`, `PANEL_YOUTUBE_BROWSER_CONNECT_ENABLED=true`, `PANEL_YOUTUBE_MUSIC_HTTP_PROXY=http://127.0.0.1:10809`, `PANEL_YOUTUBE_MUSIC_ENABLED=true`, `PANEL_YOUTUBE_MUSIC_STATION_ENTITY` с уже проверенной entity. Сохранить `PANEL_ALICE_STATION_ACTIONS_ENABLED`. |
| ТВ и голос | `PANEL_TV_VOICE_ENABLED=true`, `PANEL_TV_VOICE_STATION_ENTITY`, `PANEL_ALICE_VOICE_FEEDBACK_ENABLED=true` и существующий `PANEL_TV_EXECUTOR_TOKEN_FILE`. Сохранить существующие сценарии в Яндексе. |
| Ленты и климат | `PANEL_LIGHT_STRIP_PROVIDER=both`, проверенный `PANEL_BLE_STRIP_ADDRESS` спальни, действующие `PANEL_LIGHT_STRIP_ACTIONS_ENABLED` и `PANEL_HOME_CLIMATE_ACTIONS_ENABLED`. |

Updater устанавливает код и обновляет сборку. Изменения `runtime.env` готовятся и применяются отдельно под защищённым ACL с резервной копией.

## Передача управления и критерии приёмки

1. По отдельной команде владельца принять один итоговый PR против `main`. Перед обновлением сверить чистый Samsung checkout, CI точного кандидата и равенство дерева итогового `origin/main` принятому кандидату, включая workflow. Промежуточные PR со старыми workflow на `main` не устанавливать.
2. Остановить процесс preview через файл `stop` в `%LOCALAPPDATA%\ArtemControlCenter\autonomous-2026-11-24`. Дождаться закрытия 8797, завершения процесса и освобождения BLE. Если зарегистрирована временная задача `Artem Control Center Music Release Preview`, удалить её после остановки. На этом шаге допустима пауза голосовых функций. Основной обработчик запускается только после остановки preview.
3. Перенести завершённые наблюдения из `autonomous-2026-11-24\profile\ArtemControlCenter\station-retention.json` в корневой `station-retention.json`, пока записывающие процессы остановлены. Валидировать обе копии по `StationRetention`, объединить законченные строки без дублей по `startedAt/endedAt/seconds/outcome`, отсортировать по новизне и сохранить до 100 последних. Если shutdown завершил активный интервал как `signal_lost`, сохранить это состояние. Сравнить счётчики и атомарно заменить целевой JSON, сохранив обе исходные копии. Активный интервал между процессами не переносится.
4. Применить защищённый runtime.env и запустить штатный `Update Control Center.cmd` из чистого `main`. Чистота предохраняет от отката поверх чужих изменений. Проверить `/health/ready`, точный SHA в `http://127.0.0.1:8787/api/v1/system/production-build`, состояние задачи `Artem Control Center Runtime` и единственный обслуживающий процесс. Изолированный 8797 должен оставаться закрытым.
5. С Samsung проверить `/music` в киоске, Яндекс-плейлисты, YouTube-каталог и догрузку, ожидаемый канал OAuth без нового лайка, тихое чтение напоминаний, историю, существующие Planning/раскладки, два виджета лент и климат. Проверить одно подтверждённое действие ТВ и короткое «Сохраняю» на уже понравившемся треке, с одним получателем. Проверить автозапуск при согласованном цикле входа Windows. Повторить чтение через локальный Samsung после отключения диагностического клиента Mac. HA, внешний пульт и Happ должны продолжать работать по существующей схеме.

Если штатный updater остановится на ошибке, проверить его автоматический откат версии и readiness. Для регрессии после установки отключить новый обработчик или остановить runtime через `scripts/windows/stop-production.ps1 -ForUpdate`, восстановить копию runtime.env и проверенную предыдущую ревизию по [штатному сценарию](../WINDOWS_PRODUCTION_RUNTIME.md#update-and-automatic-rollback), собрать зависимости и production-профиль, запустить `scripts/windows/start-production.ps1` и сверить ревизию на 8787. Перед восстановлением данных сохранить новые записи и историю. Возвращать резервные данные только при необходимости. Preview можно возобновить только при подтверждённом выключении соответствующих обработчиков в основном процессе. Отключение одного browser helper — `PANEL_YOUTUBE_BROWSER_CONNECT_ENABLED=false` и штатный перезапуск. Существующий vault и официальный OAuth сохраняются.

## Отдельные задачи

- Push напоминаний на iPhone, включая «На оба».
- Выбор ленты спальни для виджета в «Обзоре».
- Причина изменения fan `five → one`.
- Поиск по всему музыкальному списку. Сейчас фильтруются загруженные строки.
