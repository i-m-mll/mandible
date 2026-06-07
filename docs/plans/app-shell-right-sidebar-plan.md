# Shared app header and right sidebar shell

Issue: `4fb8d9b`  
Umbrella: `41d22a6`

## Problem

Mandible currently has app identity in the left rail and view-owned right
sidebars. Timeline owns its inspector column and its sidebar toggle. This makes
cluster drilldown feel like a separate sidebar mechanism rather than ordinary
app chrome, and at intermediate widths the Timeline inspector can stop spanning
the full content height.

The app needs one shared header/title bar and one shared right-sidebar shell.
Views still own their detail content and persisted view state, but the
presentation, resize edge, collapse affordance, and responsive behavior must be
consistent across the app.

## Current State

- `ui/src/app.tsx` renders `.app-shell`, then `.app-layout`, with the left rail
  and `.app-content` as grid columns. Route views render directly inside the
  main content.
- The Mandible mark is currently only inside `.app-rail__brand`.
- `ui/src/views/timeline.tsx` renders a Timeline-specific toolbar toggle,
  `timeline-grid` inspector column, resize handle, and `timeline-inspector`
  aside.
- `ui/src/types/timeline.ts` already persists the right state for Timeline:
  `panes.inspector`, `panes.inspectorWidth`, selections, and `selectedClusterId`.
- `ui/src/style.css` has a Timeline-specific `max-width: 1050px` inspector
  overlay rule. That conflicts with the desired contract: desktop and normal
  tablet widths should keep a persistent full-height right sidebar below the
  header; only narrow/mobile widths should switch to a modal/drawer surface.

## Contract

Add an app-level right-sidebar descriptor:

```ts
export type AppRightSidebarDescriptor = {
  id: string;
  title: string;
  ariaLabel: string;
  open: boolean;
  width: number;
  minWidth?: number;
  maxWidth?: number;
  onOpenChange(open: boolean): void;
  onWidthChange(width: number): void;
  content: JSX.Element | null;
};
```

`App` owns presentation:

- full-width header/title bar;
- app identity and current route title;
- shared sidebar collapse/expand icon in the header;
- shared right-sidebar column, resize edge, and mobile drawer/modal behavior.

Views own content and state:

- Timeline keeps `TimelineViewState.panes.inspector` and
  `panes.inspectorWidth`;
- Timeline still opens the inspector on event, row, or cluster selection;
- Timeline supplies `TimelineInspector` as sidebar content;
- no backend refetch or projection refresh should collapse/reset the sidebar.

## Responsive Behavior

- Desktop and normal tablet widths: shared right sidebar is a grid column that
  spans the full height below the app header.
- Narrow/mobile widths only: shared sidebar content presents as a modal/drawer
  overlay instead of squeezing the workspace.
- The open/collapsed state and width contract remains the same stateful
  mechanism across presentation modes.

## Implementation Steps

1. Add a small shared app shell/context module for registering a controlled
   right-sidebar descriptor from the active view.
2. Update `App` to render a full-width header above the rail/content/sidebar
   layout. The header should show Mandible identity, current route title, and
   the shared right-sidebar toggle when a view registers sidebar content.
3. Update `.app-layout` styles so the open shared right sidebar is an app-level
   third column. The sidebar spans below the header. Add mobile drawer styles at
   the genuine small-screen breakpoint.
4. Move Timeline's inspector outer chrome to the app shell:
   remove the Timeline toolbar sidebar button, Timeline inspector grid column,
   and Timeline resize handle; register `TimelineInspector` as the shared
   sidebar content.
5. Keep Timeline selection behavior intact: selecting events, rows, or clusters
   sets `panes.inspector: true`, while manual collapse from the header persists
   until a user action opens it again.
6. Convert Timeline layout to one main content column. Preserve the existing
   inspector content styles, but let `.app-right-sidebar` own the outer panel.

## Tests

- Update Timeline UI tests so the collapse/expand action uses the shared header
  toggle and still persists `state.panes.inspector === false`.
- Add coverage that event, row, and same-time cluster selection open the shared
  sidebar and render the expected inspector content.
- Add shell/layout coverage for the header identity, current route title, and
  registered sidebar toggle if practical in existing test infrastructure.
- Verify mobile/desktop behavior with targeted CSS/DOM checks and live IAB
  inspection.

## Verification

Run:

```bash
npm test -- test/ui.test.ts test/timeline-ui.test.tsx
npm run build
git diff --check
git ls-files dist ui/dist node_modules | wc -l
```

Then restart the IAB preview on port `19421` from the latest branch commit and
verify:

- header spans the app width and contains app identity/current route;
- Timeline inspector is controlled by the header toggle;
- cluster drilldown appears in the shared sidebar;
- right sidebar spans the full content height below the header at normal widths;
- no sync banner or console errors.

## Non-goals

- Do not redesign the entire navigation rail.
- Do not migrate every existing side panel in the app in this slice. The shared
  mechanism should be available for future views, but Timeline is the required
  first consumer.
- Do not move Timeline view state into global app state.
