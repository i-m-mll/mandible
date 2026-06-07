# Timeline Implementation Slices

Date: 2026-06-07

Parent issue: [issue:41d22a6]

Primary plan: repo://mandible@3f85f2d5e3327c45b1daa63a9f9c2d5711f9d8b1/docs/plans/timeline-improvement-plan.md

## Coordinator Contract

Implementation continues on `feature/41d22a6-timeline-annotation`.

No default Timeline behavior may horizontally dodge or displace individual
event anchors. Horizontal position means true linear UTC time. Collision
handling uses vertical lanes, then representation changes such as compact
marks, same-time badges, and true range capsules.

No intentional residuals are allowed unless a user decision is required.

## Serialized Surfaces

These files are shared and should not be edited by multiple workers at once:

- `ui/src/views/timeline.tsx`
- `ui/src/types/timeline.ts`
- `ui/src/style.css`
- `test/timeline-ui.test.tsx`

The first worker wave should avoid these files except where explicitly owned.
Pure helper modules and pure unit tests come first so UI wiring can consume
stable contracts.

## Slice 1: Time Domain Helpers

Issue: [issue:1989184]

Owned files:

- `ui/src/views/timeline-time.ts`
- `test/timeline-time.test.ts`

Responsibilities:

- Define frontend-only time helpers for data extent, padded render domain,
  viewport clamping, zoom, scroll mapping, date-boundary edits, and axis ticks.
- Keep `TimelineViewState.timeWindow` as exact viewport state, including
  sub-day timestamps.
- Use UTC math for tick generation and date edits.
- Generate scale-aware ticks from viewport duration and pixel width.

Acceptance:

- Fit/domain math keeps first and last event anchors inside edge padding.
- Max scroll maps exactly to the rendered domain edge.
- Zoom clamps to the padded project domain without trapping the user in a
  rounded day.
- Date-only boundary edits preserve the opposite boundary's sub-day state.
- Day-scale ticks produce hour labels rather than repeated identical dates.

## Slice 2: Layout Helpers

Issues: [issue:ada1e43], [issue:1a2fcce]

Owned files:

- `ui/src/views/timeline-layout.ts`
- `test/timeline-layout.test.ts`

Responsibilities:

- Define a pure `buildTimelineLayout` contract for lane packing, row heights,
  stable mark IDs, and cluster candidates.
- Keep event x positions derived from true timestamps; use lane changes only
  for collision handling.
- Enforce lane budgets: compact 2, comfortable 3, expanded 4, explicit local
  expansion 6.
- Emit event marks, same-time cluster marks, range cluster marks, row layout,
  and next lane cache.

Acceptance:

- No same-lane event interval overlap.
- Prior lane assignment is reused when legal.
- Row layout height is explicit and can drive both gutter and time rows.
- Same-time clusters anchor to the exact timestamp.
- Range clusters span true first-to-last event time.
- IDs are deterministic and never array-index based.

## Slice 3: Time Wiring

Issue: [issue:1989184]

Owned files after Slice 1 lands:

- `ui/src/views/timeline.tsx`
- `ui/src/style.css`
- `test/timeline-ui.test.tsx`

Responsibilities:

- Stop using viewport `from`/`to` as backend projection filters in the Timeline
  UI until the backend exposes an unfiltered `data_extent` contract.
- Compute frontend data extent from loaded projection events after visible event
  type filtering.
- Wire measured viewport width, padded render domain, scroll mapping, and
  scale-aware ticks into the UI.
- Ensure the rendered time surface, axis, row stack, and scroll extent share
  one width.

Acceptance:

- First and last marks are not clipped at fit or scroll extremes.
- Horizontal scroll bounds match the drawn axis/canvas surface.
- Zoom/pan can return from a sub-day viewport to neighboring project events.
- Day-scale zoom shows hour/minute ticks, not repeated date-only labels.
- Zoom/scroll state persists without refetching solely because the viewport
  changed.

## Slice 4: Lane Wiring

Issue: [issue:ada1e43]

Owned files after Slices 1 and 2 land:

- `ui/src/views/timeline.tsx`
- `ui/src/style.css`
- `test/timeline-ui.test.tsx`

Responsibilities:

- Render lane-packed event marks from `buildTimelineLayout`.
- Make `rowLayoutById.heightPx` drive both gutter and time rows.
- Preserve keyboard navigation in chronological order.
- Keep selected event and row state stable across refetches and layout
  recomputation.

Acceptance:

- Dense near-time events stop overlapping in the current Mandible Timeline.
- Gutter rows and time rows stay vertically synchronized.
- Row height changes do not reset inspector, selection, filters, or time window.

## Slice 5: Clusters and Drill-Down

Issues: [issue:ada1e43], [issue:1a2fcce]

Owned files after Slice 4 lands:

- `ui/src/views/timeline.tsx`
- `ui/src/types/timeline.ts`
- `ui/src/style.css`
- `test/timeline-ui.test.tsx`

Responsibilities:

- Render same-time badges and range capsules once lane budget is exceeded.
- Selecting a cluster opens the inspector/list surface with chronological
  children.
- Persist expanded cluster IDs and selected cluster child state as
  browser-local dataful view state.

Acceptance:

- Cluster labels and aria labels report count, timestamp or range,
  category/importance summary, and selected-child presence.
- Selected child events remain discoverable when merged into a cluster.
- Range cluster zoom-to-range uses the true child range with padding.

## Verification

Run at integration scope after worker merges:

- `npm test -- test/timeline-time.test.ts test/timeline-layout.test.ts test/timeline-ui.test.tsx`
- `npm run build`
- `git diff --check`
- `git ls-files dist ui/dist node_modules | wc -l`
- Browser verification on `#/timeline?project=mandible` for dense May 30 data,
  boundary events, sub-day zoom ticks, horizontal scroll bounds, inspector
  persistence, diagnostics, and refresh/refetch state stability.
