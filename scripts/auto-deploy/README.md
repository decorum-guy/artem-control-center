# Автоматические обновления: исполняемый координатор

Связано с [issue #382](https://github.com/decorum-guy/artem-control-center/issues/382).
Это код для установки на хостах; наличие этих файлов в Git не включает обновления.
Архитектурный обзор: [AUTOMATIC_DEPLOYMENT.md](../../docs/AUTOMATIC_DEPLOYMENT.md).

## Как выбирается выпуск

`auto_deploy.py` использует только стандартную библиотеку Python 3.9+ и запускает
строго известные локальные исполнители. Для каждого разрешённого target он:

1. Перечитывает GitHub repo identity (имя **и числовой ID**) и точный `main` SHA.
2. Для каждого `required_workflows` выбирает последний run события **push main**
   именно этого SHA; зелёный PR или ручной старый запуск не подходят.
3. Требует успешные workflow и все jobs, включая ожидаемые имена. Skipped,
   cancelled, queued, failure и отсутствующий job блокируют выпуск. Читает jobs
   конкретного `run_attempt`, страницы и повторно сверяет receipts после всех
   workflows, чтобы не принять старый зелёный результат при начатом rerun.
4. Ещё раз читает `main` перед запуском, атомарно сохраняет намерение в SQLite и
   передаёт локальному исполнителю **только exact SHA** и фиксированный target.
5. Записывает успех только из проверенного результата исполнителя. Для Samsung
   необходимы request-bound terminal state штатного updater, readiness и реальный
   `/api/v1/system/production-build` с этим SHA и `accepted-v2`.

Один OS lock на `state_directory` исключает параллельные процессы и targets на
одном хосте. SQLite хранит попытки и last verified revision между рестартами.
`last_verified` означает последнее подтверждение при установке, **не свежий health**.
Текущее состояние устройства проверяется обычной диагностикой панели.

Список checks является защищённой локальной политикой, а не данными webhook.
Поэтому удаление или переименование обязательного job не превращается в
автоматический пропуск: выпуск будет ждать согласованного обновления политики.
В CI проверяется соответствие примеров policy именам и main-trigger workflows.

## Webhook и Samsung

На VPS `serve` слушает **только** `127.0.0.1:18765/hooks/github`. Существующий TLS
reverse proxy может открыть **ровно этот путь**, см. `Caddyfile.fragment`.
Здесь нет status/reset/admin endpoint и нет доступа к Panel Agent.

В каждом из двух GitHub repos добавить обычный repository webhook:

- `Content type: application/json`;
- `push` и `workflow_run`;
- отдельный сильный секрет для этого repo;
- HTTPS URL уже установленного reverse proxy с суффиксом `/hooks/github`.

Секрет сохраняется в соответствующем файле `webhook_secrets`. Приёмник проверяет
HMAC-SHA256 сырых bytes, allowlist repo+ID, event и branch. Delivery ID хранится
31 день для дедупликации. Payload ограничен 512 KiB. Payload не назначает
устанавливаемый SHA, команды, URL или пути: даже старое подписанное событие может
лишь разбудить новое чтение GitHub. Настроить ограничение частоты на существующем
TLS ingress; не открывать порт 18765 наружу.

VPS просыпается по webhook и независимо сверяет GitHub каждые 60 секунд.
**Samsung не принимает входящих webhooks**: Task Scheduler выполняет исходящую
сверку раз в минуту и при входе пользователя. Это даёт автоматическое обновление
при выключенном Mac без нового домашнего порта/туннеля. После отсутствия сети
выбирается актуальный green main; промежуточные коммиты устанавливать по одному
не требуется. 60 секунд — интервал запуска проверки, не обещанное время установки.

GitHub read token требует `Contents: read`, `Actions: read`, metadata read для
разрешённых репозиториев. Права записи и Actions artifact storage не нужны.
Секреты никогда не помещаются в JSON examples, argv, stdout или Git.

## Samsung: первичная установка

1. Локальный агент на Mac проверяет `ssh control-panel-pc`, актуальные runtime SHA,
   checkout `main`, здоровье, отсутствие текущего updater/preview и сохранённый
   rollback. Эти значения нельзя брать из примерного пути без проверки.
2. Код должен быть принят и установлен в основной checkout до включения задачи.
   Использовать стабильный системный Python 3.9+ вне `.venv` и versioned runtime
   `venvs`. Координатор не является дочерним процессом supervisor панели.
3. Скопировать `panel.example.json` в защищённый каталог Windows пользователя
   runtime, заменить пути реальными. Создать файл read token. Пример изначально
   содержит `enabled: false`; первым запуском проверить `status`.
4. Однократно включить `targets[0].enabled: true` и выполнить в пользовательской
   сессии этого же runtime:

   ```powershell
   .\scripts\windows\install-auto-deploy.ps1 `
     -PythonPath '<stable Python executable>' `
     -ConfigPath '<protected coordinator.json>' -Enable
   ```

   Установщик ограничивает ACL, сохраняет независимые копии координатора и adapter
   в `%LOCALAPPDATA%\ArtemControlCenterAutoDeploy\agent`, устанавливает задачу
   `Artem Control Center Auto Deploy` (одна минута + logon, IgnoreNew).
   Установка не запускает deployment немедленно; ближайшее срабатывание уже
   работает автоматически. Без `-Enable` задача остаётся отключённой и config
   обязан иметь `enabled: false`.
5. Проверить задачу и первый проход, затем отдельно выполнить протокол
   успешного/ошибочного выпуска. Новый вход Windows/reboot, физический экран и
   rollback не считаются проверенными по облачным unit tests.

Windows executor сохраняет manual-stop: намеренно остановленную панель он не
включает. Активный updater также приводит к `deferred` и следующей проверке.
Он использует штатные staging, maintenance lease, preflight exact revision,
продолжение целевого updater, проверку UI artifact и rollback. Никакого второго
механизма копирования production build нет. Если `main` изменился между CI и
каноническим preflight, новая непроверенная версия не устанавливается.

## VPS: первичная установка

`server.example.json` задаёт оба target, изначально disabled. Реальные серверные
пути и права подтверждаются через `ssh ha-vps`; см. инструкции
[серверного исполнителя](../../integration-patches/auto-deploy/README.md).

- Стабильный координатор: `/opt/artem-auto-deploy/auto_deploy.py`.
- Защищённая config/secrets: `/etc/artem-auto-deploy/` (root/служебный владелец,
  без доступа посторонних; обычно 0750 каталог и 0640/0600 файлы).
- Состояние и результаты: `/var/lib/artem-auto-deploy/` (0700).
- `artem-auto-deploy.service` — шаблон. Выбрать реального служебного пользователя,
  исполнителей и узкие `ReadWritePaths` для их подтверждённых каталогов. Default
  template намеренно не выдаёт запись во все HA paths и не выполняет deploy.
- Docker socket даёт широкие права на сервере; существующий runner должен иметь
  ровно доступ, необходимый проверенному серверному adapter. Не добавлять
  привилегии пользователю или публичный socket автоматически.
- Сначала проверить `status`, `reconcile` с disabled targets, затем включить
  target и unit после проверки конфигурации, backup/rollback и ingress.
- Для `telegram-bot` требуется main-push CI в `AliceTG_Bot`; обязательный job
  `validate`. Пока prerequisite не merged и exact main CI не green, target ждёт.
- Для HA обновляется только проверенная repo-owned область. Это не команда
  `docker pull :stable` при любом push панели.

После первичного включения нового подтверждения на каждый main push нет.

## Диагностика, остановка и восстановление

```text
python <installed>/auto_deploy.py status --config <protected.json>
python <installed>/auto_deploy.py reconcile --config <protected.json>
```

`status` выводит только target, candidate `revision`, last verified
`installed_revision`, outcome/reason и timestamp. Не выводит CI payload,
credentials, private paths, stderr или содержимое сервисов.

- `waiting`: CI/сеть/временный host gate; следующий проход снова проверит.
- `deployed`, `up_to_date`, `last_verified`: подтверждённый результат предыдущей
  установки; success history не является live readiness monitor.
- `blocked/revision_already_attempted`: этот SHA уже имел проверенную неудачу или
  rollback. Новый SHA допустим после **подтверждённого здорового отката**.
- `uncertain`: outcome неизвестен, child мог продолжить работу, worker/host
  прерывался. **Все target этого хоста заморожены**, даже если проблемный target
  отключить в config. Нельзя автоматически повторять или перекрывать мутацию.

Для неизвестного исхода локальный агент проверяет штатный updater/контейнеры,
точную фактическую ревизию, здоровье и rollback. Только после восстановления и
отсутствия ещё работающего child можно сбросить конкретную попытку:

```text
python <installed>/auto_deploy.py reset --config <protected.json> --target panel --sha <failed-candidate-40hex>
```

`reset` отсутствует в HTTP и не устанавливает код; следующий проход вновь
проверяет main и CI. Останавливать систему автоматизации: отключить Scheduled
Task на Windows либо остановить VPS unit, не прерывая выполняемую установку.
Config `enabled: false` прекращает новые запуски после текущей транзакции.
Не удалять SQLite как способ обхода неопределённого результата.

Координатор и adapter сохраняются вне заменяемого checkout. Их собственное
обновление — отдельная явная операция установки из принятого проверенного SHA,
после завершения активной транзакции. Они не загружают/запускают новый updater
из непроверенного webhook URL. Обычные новые версии панели/бота/HA-owned config
обновляются без повторной установки координатора. Изменение его протокола,
CI policy или host paths требует адресного обновления установленной копии.

## Кодовая проверка и физическая граница

```text
python -m unittest discover -s scripts/auto-deploy/tests -v
```

Тесты используют синтетические ответы GitHub/исполнителя: чужой repo, PR/branch,
старый SHA/attempt, missing/skipped/failing jobs, пагинация, rerun, main race,
подпись/повторы webhook, durable deduplication, host lock, crash/timeout freeze,
проверенный rollback, очередь новых SHA и deferred-повтор без мутации.
Живой deployment, Windows task/reboot, TLS ingress и реальный серверный rollback
требуют отдельной проверки на установленных хостах. Облачные тесты этого не доказывают.
