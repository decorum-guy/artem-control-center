# Widget image assets

Place the user-supplied transparent coffee-machine PNG at:

```text
coffee-machine.png
```

The `home.coffee-machine` manifest references that filename. Vite discovers it
at build time; the widget reserves a stable image area and falls back to neutral
text when the file is absent or fails to load.
