# Security Model

## 1. Threat model

Ноутбук будет постоянно подключён к домашней сети и часто обращаться к Internet, удалённому Home Assistant, рабочим сервисам, GitHub, календарю, задачам, погоде и backup destinations.

Главные риски:

- компрометация браузера/веб-интерфейса;
- утечка административных токенов;
- произвольное выполнение команд на серверах;
- публично доступный Panel Agent;
- вредоносный или подменённый backup;
- неограниченный SSH key;
- устаревшая Windows/Linux и браузер;
- физический доступ к ноутбуку;
- потеря/кража внешнего диска;
- чрезмерные права cloud sync;
- supply-chain compromise зависимостей;
- случайное опасное touch-действие.

Сам факт большого количества исходящих запросов не является основной угрозой. Критичнее права, inbound exposure, секреты, обновления и границы действий.

## 2. Trust boundaries

### Chromium

Chromium считается presentation layer с минимальным доверием.

Он не получает:

- SSH private keys;
- Home Assistant long-lived token;
- proxy credentials;
- cloud-drive credentials;
- encryption keys;
- arbitrary filesystem access;
- raw shell executor.

Даже XSS во frontend не должен превращаться в доступ к серверам.

### Panel Agent

- запускается от отдельного непривилегированного пользователя;
- по умолчанию слушает только localhost;
- имеет только scoped credentials;
- валидирует schemas и policies;
- не принимает произвольную командную строку;
- журналирует actions без secrets;
- вызывает privileged helper только для узких локальных операций.

### Privileged helper

Нужен только для действий вроде restart local service, reboot, shutdown, mount/unmount external drive.

- фиксированный allow-list;
- no shell interpolation;
- typed arguments;
- OS ACL;
- timeouts;
- audit;
- минимальный набор прав.

### Remote host agent

Для server-managed проектов без repository, включая proxy-server:

- отдельный restricted agent/API либо forced-command SSH key;
- только named operations;
- no interactive shell из Control Center;
- source restriction/private overlay when possible;
- per-action verification and rollback.

## 3. Network exposure

- Panel Agent не публикуется напрямую в Internet.
- Dashboard и API bind на `127.0.0.1` по умолчанию.
- Доступ с телефона допускается через private overlay/VPN или отдельный authenticated reverse proxy после threat review.
- На роутере не открываются administrative ports ради панели.
- Windows Firewall/Linux nftables/ufw: deny unsolicited inbound, allow only explicitly required local/private paths.
- Remote services используют TLS и hostname validation.
- Local device access ограничивается домашней LAN и конкретными ports/hosts.
- Uptime Kuma/public probes отделяются от protected details/control plane.

## 4. Accounts and privilege separation

На host должны быть раздельные роли:

- `panel` — kiosk и frontend;
- `panel-agent` — backend/adapters;
- administrator — только maintenance;
- optional backup worker — ограниченный доступ к backup root и destinations.

Windows-first может использовать отдельную local account для панели. После Linux migration применяются отдельные users/systemd units.

Не запускать Chromium, Panel Agent или Waydroid от administrator/root.

## 5. Secrets

- secrets не коммитятся;
- frontend получает только opaque refs и presentation data;
- secret store: Windows Credential Manager/DPAPI на первом этапе, Linux Secret Service/system credentials or protected files на Linux;
- environment files доступны только service account;
- отдельные tokens по integration и по environment;
- tokens revocable и с минимальными scopes;
- rotation metadata хранится без значения secret;
- sensitive values redacted from logs/errors;
- clipboard и debug endpoints не должны раскрывать secrets.

## 6. Browser and kiosk hardening

- отдельный Chromium profile только для панели;
- никакой повседневной авторизации в почту/банки в kiosk profile;
- отключить ненужные extensions;
- запретить installation сторонних extensions;
- local assets, без обязательных CDN;
- CSP, trusted origins, no inline script where practical;
- строгая CORS/CSRF/session policy;
- автоматические security updates Chromium;
- открыть external admin page в отдельном controlled context, не смешивая credentials с dashboard origin;
- kiosk escape/Desktop mode требует локального пользовательского действия.

## 7. OS security

### Windows-first

- поддерживаемая и обновляемая Windows configuration;
- automatic security updates с maintenance window;
- Defender/SmartScreen включены;
- Windows Firewall;
- disk encryption where available;
- Secure Boot where supported;
- separate panel account;
- recovery admin credentials хранятся отдельно;
- AnyDesk unattended access защищён strong unique password, 2FA и allow-list where supported.

### Linux target

- LTS distribution;
- unattended security updates with controlled reboot policy;
- LUKS/full-disk encryption where operationally acceptable;
- Secure Boot if stable on hardware;
- systemd sandboxing: `NoNewPrivileges`, filesystem restrictions and capability drop where compatible;
- nftables/ufw;
- AppArmor/SELinux where practical;
- Waydroid/container isolation;
- package sources limited to trusted repositories.

## 8. Updates and supply chain

- lock dependency versions;
- Dependabot/Renovate-like review optional, but no blind auto-deploy;
- CI runs lint, tests, type checks, secret scanning and dependency audit;
- build artifacts traceable to commit;
- production update requires verification and rollback path;
- external adapter update cannot silently gain write capability;
- downloaded backup/artifact is treated as data and never auto-executed;
- scripts on remote hosts are versioned or checksummed even if the host has no Git repository.

## 9. Action security

Every write action requires:

- stable action id;
- target and environment shown clearly;
- strict input schema;
- risk class;
- confirmation mode;
- authorization/policy;
- lock/cooldown/idempotency;
- timeout;
- verification;
- audit;
- rollback where possible.

High-risk examples:

- deploy main;
- proxy allow-list/firewall;
- HA failover/restore;
- server reboot;
- backup restore;
- delete backup/secret.

`Restart`, `Deploy`, `Backup` and `Restore` are separate capabilities. Наличие одной не означает разрешение остальных.

## 10. Backup security

- confidential backup encrypted before cloud sync;
- checksum verified after transfer;
- archive path traversal rejected;
- backup source handler allow-lists paths;
- external drive can be encrypted;
- restore key stored separately;
- cloud credentials scoped to backup destination/folder;
- retention deletion audited;
- backup browser cannot execute files;
- restore is never triggered automatically from a newly downloaded archive.

## 11. Physical security and mobility

Поскольку ноутбук иногда берут в руки:

- critical services не должны зависеть от того, что ноутбук физически стоит на столе;
- lid close/suspend policy зависит от host role;
- если ноутбук станет HA primary, suspend, перенос и случайное отключение питания должны быть запрещены или существенно ограничены;
- automatic screen lock for Desktop mode;
- kiosk can remain visible, but sensitive details require local unlock/re-authentication;
- external HDD disconnect must be safe and visible.

## 12. Logging and privacy

Audit stores:

- who/where initiated;
- action id and target;
- sanitized parameters;
- timestamps and lifecycle;
- result and verification;
- rollback result;
- correlation id.

Do not log:

- tokens/passwords;
- email/task/calendar bodies;
- backup encryption keys;
- full proxy credentials;
- raw private SSH output without redaction;
- unnecessarily detailed home occupancy data.

Retention for audit and incident logs is configurable.

## 13. Recovery

Required recovery paths:

- restart Chromium without restarting OS;
- restart Panel Agent through helper;
- local Desktop mode;
- remote recovery through private channel;
- export config without secrets;
- restore Panel Agent database from backup;
- disable all remote actions while keeping monitor-only mode;
- revoke one integration token without rebuilding system;
- emergency safe mode: local UI + read-only cached status only.

## 14. Security acceptance for MVP

- no public Panel Agent port;
- no arbitrary shell endpoint;
- no secret in frontend bundle or Git;
- separate kiosk profile/account;
- firewall enabled;
- browser/OS security updates active;
- actions schema-validated and audited;
- monitor-only projects cannot accidentally expose action controls;
- cloud backup is encrypted for sensitive profiles;
- external project adapter failure cannot crash whole dashboard;
- security scan in CI;
- documented token revocation and safe-mode procedure.
