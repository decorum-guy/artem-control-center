# Лента в зале

`LightStripControl` renders `home.light-strip.v1` in Home and in the Overview widget picker. The Overview slot is optional so existing owner layouts keep their positions.

The Panel Agent watches only `light.zal_lenta` through its existing Home Assistant REST and WebSocket adapter. The typed actions use `light.turn_on` and `light.turn_off`, are gated by `PANEL_WRITES_ENABLED` and `PANEL_LIGHT_STRIP_ACTIONS_ENABLED`, and report success only after a fresh HA read confirms the result. Control is disabled for stale, offline, locked, or read-only states. Color, effect, and white temperature require the strip to be on; the brightness slider sends one command when released.

The popup places the 22 static palette colors in a left-hand grid of filled squares without visible names. The 17 animated or contextual modes appear in a right-hand named list with small gradient previews. It also offers the full HS color picker and the device's reported white temperature range. A mode in the four most frequent selections is named in the widget instead of masquerading as a color swatch. Color squares have accessible names. Keyboard focus and reduced motion follow the panel's standard controls.

The four main swatches come from the Panel Agent's persisted selection counts in the HA state cache. A count increases for an observed transition to a different effect, HS color, or white temperature, or when the strip turns on. Brightness-only updates and repeated unchanged state events do not count. Equal counts sort by most recent selection. The history begins when this panel version starts observing the entity; it does not invent earlier usage or infer missed changes during downtime. No seeded favorites appear in production.

Fixture scenario: `home-light-strip`. Backend tests cover commands, rejection of unsupported values, sanitization, frequency ordering, and persistence.
