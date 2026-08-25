# Extended browser gate

Tests in this directory launch a real headless Chromium, and
`app-shadow-gutter-geometry.test.ts` additionally shells out to ImageMagick
`magick` for per-pixel sampling. They **throw** rather than skip when those
binaries are missing, which is correct for a gate you invoke deliberately and
wrong for a suite that must be green on an unprovisioned CI runner.

They are therefore excluded from the default suite. `vitest.config.ts` includes
`test/*.test.{ts,tsx}` — a single star — so anything in a subdirectory is out of
`npm test` by construction.

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
| `app-shadow-gutter-geometry.test.ts` | App chrome boundary shadow/gutter geometry, divider hit zones, real pointer-driven sidebar resize over CDP, and the painted shadow falloff sampled per pixel | `magick` |
| `app-header-geometry.test.ts` | Shared `AppHeader` rendered geometry, route-name truncation, and high-DPI translation past the optional left boundary | — |
| `briefing-detail-shell-transition.test.ts` | Briefing detail shell keeps the outer pane non-scrollable with the document body as scroll owner across a route transition | — |
| `briefing-sidebar-ownership-depth.test.tsx` | Briefings sidebar renders group ownership legibly: a group-owned subgroup indents past an ungrouped bundle, and the group's drawn extent excludes it | — |

These assert real browser layout and paint that jsdom cannot compute, so they
were moved rather than deleted. This directory settles only *where* they run;
whether each one earns its keep is a separate judgement under the repo's test
inclusion criteria.
