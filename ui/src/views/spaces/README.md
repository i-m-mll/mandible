# Spaces UI — styling and contract conventions

This directory holds the Spaces dashboard views (umbrella de56ffa). Two rules
apply to every Spaces UI child and are enforced here as the first exemplar.

## 1. Per-component CSS (do NOT edit the global stylesheet)

Each Spaces view/component owns its **own** `ui/src/views/spaces/*.css` and
imports it directly from its `.tsx` entry, e.g.:

```tsx
import './SpacesViewShell.css';
```

This mirrors how `ui/src/views/graph.tsx` imports
`@xyflow/react/dist/style.css` (line 9). esbuild bundles these CSS imports
(`bundle: true`, `.css: 'css'` loader in `ui/esbuild.config.js`), so a local
`import './foo.css'` is collected into the built bundle just like the
node-module stylesheet.

**Do NOT add Spaces rules to `ui/src/style.css`.** That global stylesheet is
~16k lines, imported once at `ui/src/app.tsx`, and shared by every other view;
piling Spaces rules into it makes every UI child collide on one file. Instead:

- One stylesheet per component (e.g. `space-canvas.css`, `space-board.css`,
  `space-collection.css`, `space-document.css`).
- Scope every selector under a component class (`.spaces-view`,
  `.space-canvas`, …). Avoid bare element selectors — co-bundled stylesheets
  share one global cascade once bundled.
- Use CSS custom properties (`var(--border)`, `var(--text-muted)`, …) so
  Spaces views inherit the existing theme tokens rather than re-declaring
  colors.

`SpacesViewShell.css` in this directory is the first exemplar of the rule.

## 2. Import contract types from `contracts`, view types from here

- **Wire / ledger records and request/response envelopes** (`Space`,
  `SpaceItem`, `SpaceOccurrence`, `SpaceEdge`, `SpaceBlock`, `SpaceExport`,
  `CreateSpaceRequest`, `SeedSpaceResult`, `ResolverResult`, …) live in
  `src/contracts.ts` and are re-exported from `ui/src/api.ts`. Import them from
  `../../api` (or `../../../src/contracts`). Do not re-declare them.
- **Typed client helpers** (`listSpaces`, `createSpace`, `addSpaceItem`,
  `batchWriteSpaceOccurrences`, `seedSpace`, `resolveSpaceRef`, …) live in
  `ui/src/api.ts`. Call those instead of hand-rolling `fetch`.
- **Browser-local view types** (pan/zoom, selection, filters, resolved
  view-models) live in `./types.ts`. Per the project Dataful UX State rule,
  keep this browser-local view state distinct from ledger-backed persisted
  state; never silently promote local view state into a canonical contract
  request without an explicit user action.
