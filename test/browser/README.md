# Extended browser gate

Tests in this directory launch a real headless Chromium. They **throw** rather
than skip when it is missing, which is correct for a gate you invoke deliberately and
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
`CHROME_BIN` pointing at one.

## What is here

| File | Covers | Extra binary |
| --- | --- | --- |
| `app-right-sidebar-geometry.test.ts` | Production app right sidebar with Chat, Graph, Timeline, and Console content at wide/narrow widths and in both themes: toggle/focus lifecycle, tabs, scroll ownership, pointer/keyboard resize, persistence, inertness, composer geometry, stream stability, and title-error presentation | — |
| `auth-detail-responsive.test.ts` | Auth action panels stack by detail-pane width, split at the container threshold, and never reserve a single-layout right column | — |
| `briefing-detail-shell-transition.test.ts` | Briefing detail shell keeps the outer pane non-scrollable with the document body as scroll owner across a route transition | — |

These assert real browser layout and paint that jsdom cannot compute, so they
were moved rather than deleted. This directory settles only *where* they run;
whether each one earns its keep is a separate judgement under the repo's test
inclusion criteria.
