# YouTube Music: подключение без JSON и выпуск кандидата

## Основание и текущая граница

Срез от 24.11.2026. Проверены GitHub main, PR #371–374, код кандидата `e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef`, актуальные первичные источники ytmusicapi/Google и отчёты исполнителя. Этот раунд — исследование и документация. Оркестратор и агенты не подключались к Samsung, ASUS, HA или аккаунтам, не повторяли живые пробы и не запускали тестовые наборы заново. Аппаратные результаты ниже принадлежат исполнителю и владельцу.

### Что находится в main и что запущено

| Объект | Подтверждение |
| --- | --- |
| GitHub main | `2b361918f11ba2ae40805fa65bcdbe1b3f6f99d8`; проверено API |
| PR #372 | draft/open, `de472a8`, база main |
| PR #373 | draft/open, `a811660`, база #372 |
| PR #374 | draft/open, `e26e8e0`, база #373 |
| Основной runtime Samsung | По отчёту `2b36191` на 8787 |
| Изолированный preview | По отчёту `e26e8e0` на 8797, до 26.11.2026 17:47 МСК |
| Документация #371 | Открытая ветка `docs/tv-access-autonomous-2026-11-24`; карта SSH/AGENTS ещё не в main |

[Compare main…кандидат](https://github.com/decorum-guy/artem-control-center/compare/2b361918f11ba2ae40805fa65bcdbe1b3f6f99d8...e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef) показывает 102 коммита вперёд, 0 назад, 119 изменённых файлов; merge base совпадает с main. Верхний кандидат уже содержит #372/#373. Установка preview не меняет main или штатный киоск. Обычное обновление панели пока получит прежнюю main.

## 1. Четвёртый раунд YouTube принят в проверенном объёме

Исполнитель обнаружил HTTP 200 с явным `GFEEDBACK/logged_in=0`, отсутствующим активным каналом и гостевым состоянием в браузере. Установлено, что Google перестал признавать прежнюю browser session. **Почему это произошло — срок, отзыв, ротация или иная причина — неизвестно.** Не называть это доказанным фиксированным сроком cookies.

На новом head:

- явный выход из аккаунта даёт auth_required; неизвестная схема меню остаётся ошибкой источника;
- проверяется активный канал, имя и фото не требуются;
- произвольное сообщение и неизвестная строка grid больше не считаются пустым каталогом;
- ошибочный refresh сохраняет прежние данные; удачное чтение треков не скрывает ещё не исправленную ошибку каталога;
- незнакомый ID допускается только в распознанной карточке с явным типом плейлиста; запрос треков ограничен источниками принятого каталога.

Прежний P2 закрыт чтением фактического кода и добавленных регрессий; новых подтверждённых блокеров в этом адресном объёме не найдено.

[Реализация](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/apps/panel-agent/src/panel_agent/youtube_library.py) · [регрессии](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/apps/panel-agent/tests/test_youtube_library.py) · [диагностика сессии](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/docs/plans/YOUTUBE_MUSIC_SESSION_RECOVERY_2026_11_24.md).

По [актуальному описанию PR #374](https://github.com/decorum-guy/artem-control-center/pull/374), свежая сессия получена из Яндекс Браузера на ASUS, проверена на Samsung и затем помещена в DPAPI preview. Прочитаны 41 пункт каталога (25+16), LM 100+100 с дальнейшим курсором, обычный список из 20 и список с новым ID из 46 треков. Повторены сверка после 120 секунд, перезапуск и чтение через 10 минут; обложки и сохранение просмотра проверены на Edge в обеих ориентациях. Эти результаты не доказывают многодневную долговечность сессии.

GitHub API подтвердил 4 workflow / 6 jobs success и 0 артефактов. [CI](https://github.com/decorum-guy/artem-control-center/actions/runs/45417424273), [Runtime](https://github.com/decorum-guy/artem-control-center/actions/runs/45417424294), [Presence](https://github.com/decorum-guy/artem-control-center/actions/runs/45417424440), [Edge](https://github.com/decorum-guy/artem-control-center/actions/runs/45417424305). 11 Music/Climate на Ubuntu — результат отчёта исполнителя; API подтверждает успешный соответствующий шаг. Windows пропускает этот шаг по платформенному условию.

## 2. Восстановление чтения не завершает авторизацию как функцию продукта

Сейчас существуют два независимых подключения:

| Подключение | Текущее поведение |
| --- | --- |
| Официальный YouTube OAuth | `YouTubeMusic.sign_in()` использует refresh token и автоматически получает новый access token; выполняет проверку канала |
| Browser session для Music | Однократный захват разрешённых headers из Chromium fetch; запись защищённого файла; последующее чтение этого файла |

Повторная сверка канала через 120 секунд **не продлевает browser session**. DPAPI защищает сохранённые секреты, но не поддерживает Google-вход. Постоянного профиля Music, помощника автоматического захвата/обновления и рабочего сценария кнопки подключения в кандидате нет. Сообщение «Нужно подключить аккаунт» само авторизацию не запускает.

Источники: [OAuth](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/apps/panel-agent/src/panel_agent/youtube_music.py), [браузерный адаптер](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/apps/panel-agent/src/panel_agent/youtube_library.py), [capture_headers](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/apps/panel-agent/src/panel_agent/youtube_library_credentials.py), [provisioning](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/scripts/diagnostics/station-credential-store.py).

### Почему нельзя просто обещать полноценный Music на OAuth

Инструкция [ytmusicapi OAuth](https://ytmusicapi.readthedocs.io/en/stable/setup/oauth.html) опубликована, однако [issue #813](https://github.com/sigma67/ytmusicapi/issues/813) открыт и рекомендует browser auth. В [комментарии владельца 01.09.2026](https://github.com/sigma67/ytmusicapi/issues/813#issuecomment-5491110689) сообщается об ограничении прежнего TV OAuth пути и отсутствии известной полноценной замены. В tag 1.12.4 [интеграционный тест OAuth](https://github.com/sigma67/ytmusicapi/blob/1.12.4/tests/auth/test_oauth.py) отключён со ссылкой на эту проблему.

Прежняя проба проекта с Bearer + Content-Type была режимом OAUTH_CUSTOM_FULL без стандартных headers и request-time, поэтому она сама по себе не доказывает отказ всех корректно собранных OAuth-запросов. Допустим один ограниченный read-only контроль с уже имеющимся Desktop access token, штатными headers, тем же Happ и тем же каналом. Это гипотеза для проверки, не основной обещанный путь и не повод открывать неограниченное исследование клиентов TV/IOS/Android. Новые Google clients и scopes для такой пробы не нужны. Для Windows официальный Google flow — [Desktop/system browser/PKCE](https://developers.google.com/identity/protocols/oauth2/native-app).

### Почему официальный Data API — лишь частичная альтернатива

[playlists.list(mine=true)](https://developers.google.com/youtube/data/reference/rest/v3/playlists/list) документирует собственные плейлисты; это не полный перечень сохранённых чужих списков Music. [playlistItems.list](https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/list) читает известный доступный список. [videos.list(myRating=like)](https://developers.google.com/youtube/data/reference/rest/v3/videos/list) ограничен последними 1000 видео; это ограничение данного метода, не доказательство общего лимита всех способов чтения likes. [Справка Music](https://support.google.com/youtubemusic/answer/7205933?hl=en) поясняет, что в Music из обычного YouTube-плейлиста показывается музыкальное содержимое. Полная эквивалентность LM, каталога и метаданных не доказана. Нельзя молча заменить нынешнюю библиотеку урезанной.

## 3. Рекомендуемая реализация без ручного JSON

**Это предложение следующей разработки, не уже работающий механизм.**

Сценарий владельца: «Подключить YouTube Music» → обычное окно входа Google/Music на Samsung → при необходимости вход и 2FA → панель сама проверяет канал и подключает библиотеку. Ни терминал, ни копирование JSON пользователю не нужны.

Технически:

1. Отдельный постоянный профиль обычного установленного браузера на Samsung, принадлежащий пользователю панели. Всё обращение к YouTube идёт через существующий Happ. Mac/ASUS не нужны для повседневной работы.
2. Ограниченный локальный помощник получает только нужный запрос/минимальные credentials из этого профиля. Конкретный механизм сначала проверить на установленном браузере. Обычная страница панели не имеет доступа к cookies другого origin.
3. Сначала проверить кандидата сессии: активный канал совпал с ожидаемым, разрешённое чтение прошло. Затем атомарно заменить DPAPI vault. Старое рабочее подключение не удалять при неудачной попытке.
4. При явной потере авторизации один процесс восстановления пытается получить пригодную сессию из этого же профиля. Если браузер тоже требует входа/2FA, показать «Переподключить». Не повторять авторизацию бесконечно и не запускать параллельные браузеры из нескольких вкладок.
5. Сетевой отказ, проблема Happ и неизвестный renderer не должны автоматически объявляться выходом из аккаунта или стирать credentials. Понятный статус и последние данные сохраняются.
6. Локальный канал и разрешённые назначения фиксированы; секреты не передаются dashboard, в логи, историю команд или Git. Пароли и коды 2FA остаются в обычном входе Google. Чужие браузерные профили не сканируются.
7. Помощник не должен постоянно нагружать Samsung или держать лишние браузеры. Нужны ограничение времени, отмена, корректное завершение и измерение памяти/CPU на устройстве.

[Модель browser auth ytmusicapi](https://ytmusicapi.readthedocs.io/en/stable/setup/browser.html) связывает пригодность credentials с действительностью браузерной сессии. Можно убрать ручное копирование; гарантировать отсутствие любого повторного входа Google нельзя. Причина короткой жизни прежней копии не установлена.

### Сохранение просмотра при обновлении credentials

Сейчас `YouTubeLibrary.version()` зависит от файлов обоих vault; `Feed.sync()` инвалидирует каталог, страницы и курсоры при изменении версии. Автоматическое обновление той же сессии будет восприниматься как смена аккаунта.

При реализации разделить изменение секрета и изменение подтверждённой идентичности канала. Обновление для того же канала не должно постоянно сбрасывать выбор, фильтр и прокрутку. При этом нельзя публиковать запоздалый ответ старой версии или переносить данные/ключи запуска между разными аккаунтами. Реальную смену канала подтвердить и очистить привязанные данные. Проверить это отдельными регрессиями.

Источники: [version](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/apps/panel-agent/src/panel_agent/youtube_library.py), [Feed.sync](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/apps/panel-agent/src/panel_agent/music_library.py).

### Долговечность официального OAuth

Проверить фактический статус текущего Google Cloud проекта: [External/Testing](https://developers.google.com/identity/protocols/oauth2#expiration) с YouTube scopes выдаёт refresh token на 7 дней. Статус проекта здесь неизвестен. Это отдельный риск лайков, не объяснение текущего browser logout.

Google описывает [Personal mode](https://support.google.com/cloud/answer/15549945) для одного создавшего приложение аккаунта, без семидневного тестового срока. Его выбирают при создании нового приложения; существующий External/Internal проект нельзя переключить в Personal. Не предписывать ненужную миграцию и не менять рабочий Cloud-проект автоматически. Сначала установить его реальные настройки.

## 4. Выпуск на основную панель

Рекомендация — подготовить единый совокупный выпуск верхней ветки, например PR #374 с базой main, после проверки полного diff и согласования документов #371. Это предложение; base PR и main в этом раунде не изменялись.

Не проводить промежуточные состояния последовательно через main без оценки: в [ci.yml #372](https://github.com/decorum-guy/artem-control-center/blob/de472a808df864167e0e8a014c7c278809155a82/.github/workflows/ci.yml) ещё 26 upload-artifact шагов, в [текущем кандидате](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/.github/workflows/ci.yml) их 0. Старые #368/#370 уже перенесены в #372; не применять их повторно без сравнения.

При подготовке выпуска:

- Согласовать полный итоговый diff, сохранить ancestry и принятые исправления, актуальные отчёты и правила доступа из #371. Запустить CI для итоговой базы main без загрузки артефактов.
- Зафиксировать точный кандидат, текущий last-known-good и резервные копии runtime.env, прав, раскладок и пользовательских данных.
- Составить точный manifest постоянных путей, флагов и четырёх credentials: Station/Yandex, reminders, официальный YouTube OAuth, браузерная Music. DPAPI остаётся под тем же Windows-пользователем. Штатный updater не меняет runtime.env.
- Перенести историю удержания трека без дублей и ложных завершений.
- При установке оставить одного владельца голосовых событий и BLE. Перед включением основного обработчика остановить preview: внутрипроцессная дедупликация не защищает от двух процессов.
- Проверить фактически отдаваемую ревизию на 8787, readiness, обычный киоск, краткий smoke принятых функций, автозапуск, независимость от Mac и адресный откат.

Порядок: [Windows runtime](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/docs/WINDOWS_PRODUCTION_RUNTIME.md), [основной план переноса](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/docs/plans/SAMSUNG_AUTONOMOUS_RESULTS_2026_11_24.md#порядок-штатной-установки-и-отката), [добавления Music](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/docs/plans/MUSIC_LIBRARY_PREVIEW_2026_11_24.md).

Вопрос владельца о состоянии main сам по себе не является командой merge/deploy. Подготовка reviewable выпуска разрешена; фактическая штатная установка остаётся отдельным решением. Остальные функциональные хвосты не превращать в новые безусловные критерии выпуска уже принятого объёма.

## 5. Остаток работ

| Пункт | Состояние | Следующее действие |
| --- | --- | --- |
| Основная панель | Старые main/8787, новый кандидат в preview | Подготовить и отдельно выполнить штатный выпуск |
| Подключение YouTube без JSON | Автоматического capture/recovery пока нет | Реализовать §3 |
| Push напоминаний на iPhone и «На оба» | Три теста панели не доставили push; из официального приложения push пришёл | Исследовать различие payload и доставки; origin_device_id пока только гипотеза |
| fan five → one | После изменения температуры, отдельной команды fan в проверенном интервале нет | Отдельная диагностика; не выполнять слепой возврат температуры |
| Лента спальни в «Обзоре» | Обе ленты доступны в «Доме», выбор спальни для Overview оставлен | Добавить выбор источника слота без смешения двух устройств |
| Эксплуатация после установки | Кандидат ещё не прошёл штатный cutover | Проверить автозапуск, одного обработчика, отсутствие прежнего мерцания |

Источники открытых пунктов: [Samsung](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/docs/plans/SAMSUNG_AUTONOMOUS_RESULTS_2026_11_24.md), [fan](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/docs/plans/MUSIC_LIBRARY_ROUND3_2026_11_24.md).

Осознанные ограничения для следующего развития:

- Поиск Music фильтрует только загруженные позиции. Полного поиска по всей огромной LM-библиотеке нет; это отдельное полезное расширение. [UI](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/apps/dashboard/src/features/music/MusicPage.tsx).
- Повторяющиеся напоминания доступны для просмотра; перенос серии отклоняется. Создание и перенос разовых работают. [Backend](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/apps/panel-agent/src/panel_agent/station_reminders.py).
- Глубокий сон/обесточивание ТВ не равны принятому погашению экрана. Проверку независимости от Mac провести в рамках установки. [TV pilot](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/docs/plans/TV_VOICE_PILOT.md).

Уже реализовано:

- Счётчик удержания метаданных Станции есть в Настройках, сохраняет наблюдения и различает естественную очистку, возобновление, другой трек и потерю сигнала. Вывод «фиксированный срок или плавает» требует накопленных достоверных завершений; сам счётчик заново разрабатывать не нужно. [UI](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/apps/dashboard/src/features/settings/StationRetentionSettings.tsx).
- BLE on/off, RGB, аппаратная яркость и восстановление после iPhone подтверждены прежними проверками. Чтение состояния изначально не требовалось. [Пилот](https://github.com/decorum-guy/artem-control-center/blob/e26e8e0d5453cf01a3257cbadcc7f2b74ada32ef/docs/plans/STATION_AND_BLE_PILOT.md).
- Ранняя озвучка «Сохраняю», Яндекс-плейлисты, исправления R1–R5 и текущий P2 пустого каталога не возвращаются в общий backlog без конкретной регрессии.
