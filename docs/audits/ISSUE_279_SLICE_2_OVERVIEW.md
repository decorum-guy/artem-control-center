# #279 Slice 2 — Overview polish

Base: `90cd102e66f35efb56013004c661aaebe0223cf7` (merged PR #281). Its post-merge run `36035365889` completed successfully on Linux and Windows before this slice was finalized.

## Current-main findings

- Coffee drew a permanently glowing amber left mark, including OFF. The Overview title also repeated the `Дом` category, and Ready repeated its meaning in the detail line.
- Planning put the overdue count in every overdue task title and repeated the same long category label. The selected tasks, events, reminders, due information and destinations were already truthful; no selection rewrite was needed.
- Climate's Overview wrapper already removed the inner border, so a literal double border was not present at 1280×720. The component still declared its own surface/background and stacked both mode and fan controls across the full width. This slice makes the single surface explicit and puts mode/fan beside one another where the registered widget has room.
- Services used a warning card background, warning aggregate and incident line for the same attention state. The healthy state also carried a separate `Критичных инцидентов нет` line. Backup freshness and the fixed recovery slot were already present.

## Presentation contract

Coffee sets `data-coffee-active` from `machine.available === true && machine.stale !== true && machine.state === "on"`. Presentation stage, timing policy and action pending state do not grant the glow. Thus Warming, Ready, Running and Running Too Long may glow only while canonical ON is live and fresh; OFF, stale, unavailable, turning on and turning off do not. Running Too Long retains a distinct warning border/surface and a quieter warning-tinted halo.

The Overview contour is a static diffused shadow with a short state transition. Day uses a lighter warm token; night uses a more visible amber token. There is no travelling border or repeated glow animation. OS and product reduced-motion modes suppress the transition without hiding the confirmed state.

The Overview grid, registry, safe size variants, persisted layout, editor, image positioning/scale controls, Coffee actions and delayed-start timer remain source-owned and unchanged. The timer remains icon-only. No Home Assistant thermal calculation or #278 work is included.

## Review evidence

The focused gate `tests/e2e/issue-279-overview.spec.ts` captures 1280×720 CSS px at DPR 1.5 in `artifacts/issue-279-overview-review/`:

- Overview day and night with Coffee OFF and confirmed active;
- night Coffee warning and stale;
- three distinct overdue tasks, including a two-line Russian title;
- service attention with backup and unavailable recovery;
- available Climate controls.

It checks the active semantic attribute, static contour, reduced motion, touch and containment geometry, icon-only timer, incident/recovery presentation and horizontal overflow. The CI artifact is `issue-279-overview-review-${{ github.sha }}`. Screenshots use deterministic fixtures for visual review; no fixture content is copied into production UI.

## Boundary and physical review

No Calendar Slice 3, Settings sliders, Weather assets, AliceTG_Bot, ROG behavior or #278 changes. CI visual review is a development gate. Final display balance and actual Home Assistant states still need physical Samsung review at 1280×720.
