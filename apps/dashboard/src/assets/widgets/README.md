# Widget image assets

Place owner supplied transparent PNG/WebP artwork in this directory under these
canonical filenames:

```text
coffee-machine.png
station-mini-2.png
```

The `home.coffee-machine` and `home.station-mini-2` widgets reference these
assets through the bounded `resolveWidgetAsset(...)` registry. Vite discovers
matching PNG and WebP files at build time, so widgets only use assets included
in the application bundle. Images are never loaded from arbitrary runtime URLs
or filesystem paths.

The artwork stays inside its reserved slot with `contain` sizing. The Coffee
widget uses its neutral text fallback when its image is absent or fails to
load; the Station widget uses its neutral SVG outline in those cases.
