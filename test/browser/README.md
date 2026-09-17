# Extended browser gate

Tests in this directory launch a real headless Chromium, and
`app-shadow-gutter-geometry.test.ts` additionally shells out to ImageMagick
`magick` for per-pixel sampling. They **throw** rather than skip when those
binaries are missing, which is correct for a gate you invoke deliberately and
wrong for a suite that must be green on an unprovisioned CI runner.

They are therefore excluded from the default suite. `vitest.config.ts` includes
`test/*.test.{ts,tsx}` — a single star — so anything in a subdirectory is out of
`npm test` by construction.

The browser gate runs files sequentially and allows 30 seconds per test by default. Each file starts native Chromium processes; running files concurrently adds startup contention without improving layout evidence. Tests with longer journeys declare their own bounded deadline.

Run them on a provisioned machine with:

```bash
npm run test:browser
```

Provisioning: a Chromium at one of the absolute paths each file probes, or
`CHROME_BIN` pointing at one; plus ImageMagick at `/opt/homebrew/bin/magick`,
`/usr/local/bin/magick`, or `/usr/bin/magick` for the chrome-edge pixel gate.

## What is here

| File | Covers | Extra binary |
| --- | --- | --- |
| `app-right-sidebar-geometry.test.ts` | Production app right sidebar with Chat, Graph, Timeline, and Console content at wide/narrow widths and in both themes: toggle/focus lifecycle, tabs, scroll ownership, pointer/keyboard resize, persistence, inertness, composer geometry, stream stability, and title-error presentation | — |
| `app-shadow-gutter-geometry.test.ts` | App chrome boundary shadow/gutter geometry, divider hit zones, real pointer-driven sidebar resize over CDP, and the painted shadow falloff sampled per pixel | `magick` |
| `app-header-geometry.test.ts` | Shared `AppHeader` rendered geometry, route-name truncation, and high-DPI translation past the optional left boundary | — |
| `auth-detail-responsive.test.ts` | Auth action panels stack by detail-pane width, split at the container threshold, and never reserve a single-layout right column | — |
| `briefing-detail-shell-transition.test.ts` | Briefing detail shell keeps the outer pane non-scrollable with the document body as scroll owner across a route transition | — |
| `briefing-sidebar-ownership-depth.test.tsx` | Briefings sidebar renders group ownership legibly: a group-owned subgroup indents past an ungrouped bundle, and the group's drawn extent excludes it | — |
| `provider-picker-marks.test.ts` | New chat provider marks remain unboxed at rest and expose a darker mark, local surface, and visible keyboard focus treatment | — |
| `shared-header-title-colors.test.ts` | App, standard, compact, versioned, and legacy shared titles resolve to exact white in dark mode and exact black in light mode | — |

These assert real browser layout and paint that jsdom cannot compute, so they
were moved rather than deleted. This directory settles only *where* they run;
whether each one earns its keep is a separate judgement under the repo's test
inclusion criteria.
