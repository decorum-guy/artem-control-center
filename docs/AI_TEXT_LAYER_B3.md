# B3 — provider-neutral text AI

This layer is text only. It receives a bounded, canonical Planning projection
and returns normalized text. It has no tools, mutation actions, browser
automation, arbitrary endpoint configuration, audio, or voice functionality.

## Provider registry and settings

The server-owned provider registry has stable IDs: `gigachat`, `yandex`,
`deepseek`, and `local`. Cloud model choices are fixed registry entries. Local
selection persists only the owner’s provider preference: its model and
endpoint are deployment configuration, never browser-controlled values. The
browser cannot supply a URL, hostname, headers, or provider request body.

Provider selection and credentials live in the atomic, schema-versioned
`ai-provider-settings.json` under `%LOCALAPPDATA%\ArtemControlCenter` in the
production runtime (or an explicit server-side path). Its read API contains
only `credentialPresent`, configuration state, model, and selection metadata.
Credentials are never returned, logged, placed in diagnostics, URL parameters,
or browser storage. The runtime directory is owner-local and the newly written
file is created with owner-only POSIX permissions where applicable; production
Windows configuration remains guarded by the existing protected runtime root
and runtime.env ACL convention.

Settings writes require both the narrow `PANEL_AI_SETTINGS_WRITES_ENABLED` and
`PANEL_AI_TEXT_ENABLED` feature gates, global `PANEL_WRITES_ENABLED`, and the
registered `settings.ai.providers` Standard-access capability. A disabled
feature reports `disabled`; compiling an adapter never makes it active.

## Providers

- **GigaChat** is the first production path. The stored authorization key is
  exchanged only server-side at Sber's OAuth endpoint; the 30-minute access
  token is held only in process memory and refreshed before expiry. Generation
  uses the official fixed `https://api.giga.chat/v1/chat/completions` endpoint.
  Sber requires the MinTsifry Russian trusted root CA for both OAuth and
  generation. Production must install that certificate through the normal
  deployment process and set the server-only
  `PANEL_AI_GIGACHAT_CA_BUNDLE_PATH` to the local PEM/CRT bundle. The Panel
  Agent validates that bounded path and constructs a verified `ssl.SSLContext`
  for httpx; it never downloads certificates and never disables TLS
  verification. Missing or invalid trust is reported only as the bounded
  `configuration_error` category.
- **Yandex** has a concrete adapter with the fixed Foundation Models endpoint
  and API-key authorization; it is intentionally unconfigured until its typed
  deployment credential/model configuration is supplied.
- **DeepSeek** uses its direct fixed chat-completions endpoint with the current
  official models `deepseek-v4-flash` and `deepseek-v4-pro`. The default is
  `deepseek-v4-flash`, selected for this low-latency short-summary layer.
  DeepSeek V4 Chat Completions enables thinking by default, so the normal
  summary request explicitly sends `"thinking": {"type": "disabled"}`. No
  tools or function-calling fields are sent.
- **Local** is a fixed server-configured localhost boundary. Its trusted model
  comes from `PANEL_AI_LOCAL_MODEL` and is used for both direct Local requests
  and fallback requests; the normalized result reports that exact model. It is
  unavailable until the narrow local feature gate is enabled, never runs a
  shell, and never accepts a browser-supplied endpoint or model.

References: [Sber authorization](https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/gigachat-api),
[Sber model selection](https://developers.sber.ru/docs/ru/gigachat/guides/selecting-a-model),
[Sber MinTsifry certificates](https://developers.sber.ru/docs/ru/gigachat/certificates),
[Yandex text generation REST reference](https://yandex.cloud/en/docs/foundation-models/text-generation/api-ref/),
[DeepSeek chat completions](https://api-docs.deepseek.com/api/create-chat-completion/),
[DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/),
[DeepSeek V4 release](https://api-docs.deepseek.com/news/news260424/).

## Projection, response, and fallback

`planning_today` projects only title, date/time, all-day semantics, location,
open/completed state, priority, delivery state, and source freshness. It does
not project IDs, provider identities, notes, sync fields, ETags, credentials,
or runtime data. `unavailable` and stale Planning domains are explicit facts,
not empty lists.

Responses contain text, actual provider/model, status, safe error category,
fallback flag, bounded latency, and context warning. Raw provider payloads and
provider IDs/tokens never reach React.

Only `timeout`, `transport_error`, `provider_error`, and `rate_limited` may use
the local fallback. Authentication and configuration failures stay explicit.
Tier-1 phrases (`acknowledged`, `completed`, `command_failed`) bypass every
provider transport.
