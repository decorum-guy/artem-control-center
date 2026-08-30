# Jarvis knowledge contract

The first Jarvis knowledge document is owner-maintained local runtime data. On
Windows, its trusted root is derived from the existing runtime convention:

`%LOCALAPPDATA%\ArtemControlCenter\knowledge`

The fixed mapping is:

- document ID: `coffee-guide`
- file: `knowledge/coffee-guide.md`
- HTTP read surface: `GET /api/v1/knowledge/coffee-guide`

The Panel Agent owns the narrow `KnowledgeReader.read_coffee_guide()` reader.
The endpoint and future Jarvis code use that server-owned reader; callers do
not provide a path, filename, directory, extension, or document selector.
There is no directory listing or write/upload surface.

Reads are bounded to 64 KiB (65536 bytes), use strict UTF-8 decoding, and
accept and strip a UTF-8 BOM. A missing document is normal and returns
`status: "missing"`; an unresolved production root returns
`status: "unavailable"`. Other semantic statuses are `available`,
`invalid_utf8`, and `too_large`. Responses use `Cache-Control: no-store`.

The actual owner file has not been physically provisioned by this change.
Real coffee advice remains owner-maintained and is not supplied through model
defaults or a generated template.
