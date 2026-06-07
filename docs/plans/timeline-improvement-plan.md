# Project Timeline Improvement Plan

Date: 2026-06-07

Issue: [issue:41d22a6]

## Purpose

This plan turns the Timeline MVP, browser annotation pass, overlap research
packet, and 5.5 Pro critique into an implementation sequence for the next
Timeline iterations.

The current branch already has the MVP workspace, baseline zoom, inspector
collapse/resize, diagnostics badge, cleaner row gutter, and a fix for the
transient ref-expansion regression reported during annotation. The remaining
risk is not a single missing control. It is the density model: event marks can
overlap, dense bursts can become unreadable, and aggregation can hide important
content unless it has stable contracts.

## Non-Negotiable Product Principles

### Truthful Time

The primary Timeline view must keep horizontal position tied to timestamp. The
default x-axis remains linear UTC time. If a future view ever displaces an item
horizontally, the true timestamp anchor must remain explicit with a connector or
anchor marker.

Preferred collision hierarchy:

1. Keep x exactly tied to timestamp.
2. Use vertical lanes.
3. Change representation: full box, compact glyph, same-time badge, range
   cluster.
4. Drill down by zooming to range, expanding local vertical space, or opening a
   list/detail surface.
5. Avoid adaptive or nonlinear time in the default view.

### State Stability

Timeline state remains dataful UX state. Zoom, time window, selected event,
selected row occurrence, selected cluster/list item, expanded refs, expanded
clusters, diagnostics visibility, inspector visibility, inspector width, and
stable lane preferences must survive refetches, project switches, refreshes,
and app restarts unless the user changes them.

Layout recomputation must not cause visible flicker, auto-select replacements,
or reset panes. If rows or events leave the current projection, preserve the
missing selection state instead of silently choosing another item.

State ownership decisions:

- URL-shareable state remains limited to project, filters, explicit roots,
  expanded refs/paths, and time window.
- Browser-local state owns inspector visibility/width, diagnostics visibility,
  density, zoom bucket, expanded cluster IDs, selected cluster/list child, and
  previous lane preferences.
- Derived layout caches are keyed by project, filter hash, row ID, time window,
  quantized zoom bucket, and projection revision.
- If a selected event merges into a cluster, selection remains on the event and
  the cluster advertises `containsSelected`; clicking away is the user's action,
  not a side effect of recomputation.

### Aggregates Are First-Class

Clusters and badges are not rendering leftovers. They need stable IDs, explicit
time semantics, summary data, accessible labels, keyboard behavior, and
selection/focus contracts.

A cluster must tell the user what it is hiding and how to inspect it.

### Important Events Must Not Disappear

Aggregation must obey an importance policy. Some events may be unclusterable;
some may be clustered only if the cluster visibly advertises their presence;
some routine events may cluster freely.

## Density Cases

Treat these as separate layout cases rather than one generic overlap problem.

### Near-Time Collisions

Events have distinct timestamps but labels overlap at the current zoom.

Default response:

- keep timestamps fixed;
- estimate or measure mark intervals in pixels;
- pack marks into stable vertical lanes;
- reduce mark detail with semantic zoom when needed;
- cluster only once lane budget is exceeded.

### Identical-Timestamp Multiplicity

Multiple events have the exact same timestamp.

Default response:

- render a multiplicity badge anchored at that timestamp;
- do not imply a time range;
- accessible label should say, for example, "17 events at 12:03:10";
- drill-down opens the event list or a local expansion, not a range zoom unless
  neighboring non-identical events also matter.

### Burst-Range Density

Many events occupy a short but nonzero interval.

Default response:

- render a range capsule/bracket spanning first to last event;
- show count and time span;
- include severity/category summary where available;
- optionally show tiny internal rug/density ticks;
- drill-down can zoom to the range or open a child list.

## Proposed Data Model Additions

Add frontend layout models first. Avoid changing the backend projection until
the UI contract is proven.

```ts
type TimelineImportance = 'critical' | 'normal' | 'routine';

type TimelineLayoutMark =
  | TimelineEventMark
  | TimelineSameTimeCluster
  | TimelineRangeCluster;

type TimelineEventMark = {
  kind: 'event';
  id: string;
  eventId: string;
  rowId: string;
  timestamp: number;
  importance: TimelineImportance;
  category: string;
  lane: number;
  widthPx: number;
};

type TimelineSameTimeCluster = {
  kind: 'same_time_cluster';
  id: string;
  rowId: string;
  timestamp: number;
  eventIds: string[];
  count: number;
  highestImportance: TimelineImportance;
  categorySummary: Record<string, number>;
  containsSelected: boolean;
  expanded: boolean;
  lane: number;
};

type TimelineRangeCluster = {
  kind: 'range_cluster';
  id: string;
  rowId: string;
  minTime: number;
  maxTime: number;
  anchorTime: number;
  eventIds: string[];
  count: number;
  highestImportance: TimelineImportance;
  categorySummary: Record<string, number>;
  containsSelected: boolean;
  expanded: boolean;
  lane: number;
};

type TimelineLayoutState = {
  zoomBucket: string;
  expandedClusterIds: string[];
  selectedClusterId: string | null;
  selectedClusterChildEventId: string | null;
  previousLaneByMarkId: Record<string, number>;
};
```

Cluster identity should be deterministic: row ID, quantized zoom bucket,
cluster kind, child event ID hash, and time bucket. Do not key clusters by array
position.

The first implementation should derive `importance` and `category` from current
event fields only. No backend projection change is required to distinguish
body/comment/state, issue priority, issue labels, selected/pinned state, and
diagnostic-backed events.

## Implementation Sequence

### Phase 1: Extract Timeline Layout Engine

Owns: [issue:ada1e43], [issue:1a45727]

Create a pure layout module, likely `ui/src/views/timeline-layout.ts`, with
focused unit tests.

Inputs:

- visible rows and events;
- current time window;
- canvas width;
- density mode;
- selected event ID;
- selected cluster ID and selected cluster child event ID;
- expanded cluster IDs;
- previous lane assignment cache;
- quantized zoom bucket;
- mark sizing policy;
- lane budget.

Outputs:

- row layout by row ID, including `heightPx` and lane count;
- event marks;
- same-timestamp clusters;
- range clusters;
- lane assignments;
- accessible summaries.

Acceptance:

- all x positions derive from the shared linear time scale;
- no event mark overlaps another event mark in the same lane;
- output is deterministic for stable input;
- selected events preserve stable mark/cluster identity across recomputation;
- `rowLayoutById.heightPx` drives both the gutter row stack and timeline row
  stack so lanes cannot desynchronize row labels from marks;
- scroll anchoring preserves the selected or top visible row when row heights
  change;
- the minimal deterministic importance/category mapping exists before any
  visual cluster rendering uses it;
- no DOM measurement is required for the first version; use conservative width
  estimates by density mode.

### Phase 2: Stable Lane Packing

Owns: [issue:ada1e43]

Implement interval partitioning for visible event marks.

Algorithm:

1. Convert each event to a screen-space interval using timestamp, estimated
   width, and minimum gap.
2. Sort by interval start, timestamp, importance, stable event ID.
3. Reuse previous lane assignment when possible.
4. Otherwise choose the first lane whose right edge is free.
5. Allocate another lane only when needed.

Tune for stability, not only minimum lane count:

- keep previous lane if legal;
- quantize layout decisions into zoom buckets;
- add hysteresis around representation changes;
- keep selected/focused marks stable when neighboring items change.

Acceptance:

- current overlapping comment boxes become non-overlapping lanes;
- rows grow vertically up to the configured lane budget;
- keyboard traversal still follows time order, not lane order;
- zoom/pan changes do not make marks jump lanes unless necessary.

### Phase 3: Early Density Detection

Owns: [issue:ada1e43]

Before measuring or packing every full label, run a cheap density scan.

Process:

1. Map visible events to pixel x positions.
2. Group exact timestamp collisions.
3. Scan bins/runs where local overlap depth clearly exceeds lane budget.
4. Convert extreme regions into cluster candidates before full packing.
5. Pack remaining individual marks and cluster marks together.

Acceptance:

- thousands of events in a short interval do not require thousands of measured
  full labels;
- same-timestamp clusters are distinct from range clusters;
- sparse rows can still show full labels while dense rows cluster.
- this phase does not implement global gap compression or nonlinear time.

### Phase 4: Cluster Marks and Drill-Down

Owns: [issue:ada1e43], [issue:1a2fcce]

Render two aggregate types:

- same-time badge: point-like, anchored to one timestamp;
- range capsule: spans first-to-last time and shows count.

Drill-down actions:

- Zoom to range: changes the time window.
- Expand here: increases local vertical allocation if lane budget allows.
- Open list: shows children in the inspector/list model without changing time.

Acceptance:

- clusters communicate count and time semantics visually and accessibly;
- clicking a range cluster can zoom to a range where children split if space
  permits;
- same-time clusters do not imply a false duration;
- selected events inside clusters are advertised and discoverable.
- cluster children are inspectable through the synchronized list/inspector in
  the same implementation slice, with keyboard equivalents for zoom, expand,
  and open-list actions.

### Phase 5: Importance and Category Policy

Owns: [issue:304aefa], [issue:4a0b3df], [issue:0cf5b13]

Extend the deterministic event importance/category mapping from Phase 1:

- state transitions and issue bodies default above routine comments;
- diagnostics can mark problematic expansions as important;
- future manual annotations can pin or promote events.

Cluster rules:

- critical events are not hidden unless the aggregate explicitly exposes them;
- badge/capsule summaries include highest importance;
- selected or pinned events split out when possible;
- routine comments cluster freely under density pressure.

Acceptance:

- a dense routine burst can collapse cleanly;
- a critical or selected event remains findable without opening every cluster;
- cluster labels expose important contents in text and aria labels.

### Phase 6: Accessibility/List Contract

Owns: [issue:1a2fcce], [issue:ada1e43]

Harden the synchronized list/table model from Phase 4 as part of the primary
Timeline, not as an afterthought.

Requirements:

- current viewport marks and clusters are keyboard navigable;
- cluster children are inspectable in a list;
- accessible names include count, timestamp/range, category summary, and
  highest importance;
- zoom, expand, and list actions have keyboard equivalents;
- focus survives split/merge transitions.

Acceptance:

- keyboard-only users can find, open, and drill into dense clusters;
- screen readers receive truthful time semantics;
- visual selection and accessible focus stay in sync.

### Phase 7: Hierarchical Caching and Large Data

Owns: [issue:ada1e43]

Once the local layout contract works, add hierarchy and caching.

Approach:

- quantize zoom levels into layout buckets;
- cache cluster trees per project, row, filter state, and zoom bucket;
- compute expansion zoom/range for each cluster;
- invalidate by projection revision and view filters;
- virtualize rows and marks for large timelines.

Acceptance:

- panning and small zoom deltas reuse stable clusters;
- cluster split/merge animation can use stable IDs;
- large projects stay interactive.
- caching preserves the default linear UTC time scale and does not implement
  gap compression.

## Explicitly Deferred

- Nonlinear, adaptive, fisheye, or compressed time as the default Timeline.
- Global gap compression, including [issue:a4b049c], remains outside the default
  overlap/density lane unless it is redesigned as an explicit expert mode with
  visible distortion markers.
- Row-specific time scales.
- Spiderfy as the primary drill-down interaction.
- Backend-persisted named timeline workspaces.
- Project-canonical artifact/document row models.

Nonlinear/focus+context time can return later as an explicit expert mode with
visible distortion markers. It should not be used to solve default overlap.

## Immediate Next Work Units

1. Extract `timeline-layout.ts` with tests for linear scale, screen-space
   intervals, stable lane packing, deterministic IDs, prior-lane reuse, and
   row-height output.
2. Wire lane-packed marks into `TimelineView`, making `rowLayoutById.heightPx`
   drive both gutter and time rows while preserving scroll anchoring and the
   current view state.
3. Add same-time badges, range capsules, and synchronized cluster child list
   drill-down behind a lane-budget threshold.
4. Extend the deterministic importance/category policy and expose it in visual
   summaries and aria labels.
5. Add hierarchy/cache/virtualization only after the cluster and state contracts
   are stable.
6. Browser-verify with real Mandible data at dense windows and with synthetic
   fixture cases for identical timestamps and burst ranges.

## Verification Matrix

Unit tests:

- same timestamp: 1, 2, 10, 100 events;
- near-time collisions with distinct timestamps;
- burst-range density with one selected child;
- critical event inside routine cluster;
- lane stability under small zoom delta;
- prior lane reuse across refetch with stable inputs;
- gutter/time row height synchronization;
- cluster split after zoom-to-range;
- keyboard ordering and accessible labels.

Integration/browser checks:

- current Mandible `#/timeline?project=mandible` dense May 30 region;
- collapsed and expanded transient rows;
- inspector open/closed and resized;
- diagnostics panel open/closed;
- refresh/refetch while selected event is inside a cluster;
- Mac trackpad/Ctrl/Meta zoom plus toolbar zoom controls.

Build checks:

- `npm test -- test/timeline-ui.test.tsx`;
- new `test/timeline-layout.test.ts`;
- `npm run build`;
- `git diff --check`;
- generated output hygiene: `git ls-files dist ui/dist node_modules`.

## Planning Decisions

- Implement lane packing before clustering so the row layout has a truthful
  individual-mark baseline.
- Add early density detection before expensive full-label layout to keep large
  bursts cheap.
- Distinguish exact timestamp multiplicity from time-range clustering.
- Treat cluster objects as first-class stateful view entities, not ad hoc DOM
  fallbacks.
- Preserve the current shared-axis invariant from [issue:41d22a6].

## Open Questions

- What event fields should define initial importance beyond selected/pinned,
  issue body, state transition, and diagnostics?
- Should clusters be purely frontend-derived for the next iteration, or should
  projection metadata include event categories and importance hints?
- What is the default lane budget by density mode?
- Should "expand here" create temporary local lanes inside a row or open a
  child list first?
- How should row height changes animate without causing vertical context loss?
