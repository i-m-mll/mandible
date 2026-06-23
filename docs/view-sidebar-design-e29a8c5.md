# `<ViewSidebar>` — shared view-sidebar container (issue e29a8c5)

READ-ONLY design pass. No code was changed. This doc is implementation-ready: a
component API, a CSS consolidation plan, a per-view migration plan, the Spaces
content fold-in, risks, and an ordered implementation sequence.

Base branch for the refactor: `feature/spaces-view-render-fix` (current Spaces
render fix, commit `8debd17` "Spaces view uses shared sidebar slot + real theme
tokens + app-content--spaces layout").

---

## 0. Survey of the four hand-rolled sidebars

All four render the left rail of a `VIEW_SIDEBAR_TABS` view (`ui/src/app.tsx`
~162). The host threads a single `sidebarHidden` prop into each
(`viewSidebarHidden`, app.tsx ~1341–1449) and adds
`app-layout--view-sidebar-open` to `.app-layout` when a view sidebar is open
(app.tsx ~1273). The shared resize behavior comes from one hook,
`useSidebarResize` (`ui/src/hooks/useSidebarResize.ts`): it owns width state,
localStorage persistence (`storageKey`), the mobile breakpoint that returns
`width: null` so CSS media queries take over, and `handleMouseDown` (rAF-batched
drag, max clamped to 50% viewport).

The differences that the container must absorb without behavior change:

| Aspect | issues | graph | timeline | spaces |
|---|---|---|---|---|
| File | `ui/src/views/issues.tsx` ~733 | `ui/src/views/graph.tsx` ~1174 | `ui/src/views/timeline.tsx` ~1620 | `ui/src/views/spaces/SpacesSidebar.tsx` ~505 |
| Frame element | `<div className="issues-tree">` | `<aside className="graph-sidebar" aria-label="Graph controls">` | `<aside className="timeline-sidebar" aria-label="Timeline controls">` | `<div className="spaces-tree">` |
| Resize handle placement | **inside**, first child: `<div className="sidebar-drag-handle issues-tree__resize-handle">` | **sibling after** `</aside>`: `<div className="sidebar-drag-handle">` | **sibling after** `</aside>`: `<div className="sidebar-drag-handle">` | **inside**, first child: `<div className="sidebar-drag-handle spaces-tree__resize-handle">` |
| Hidden handling | `!sidebarHidden ? (<div…/>) : null` — sidebar **and** handle unmount; rest of view stays | `<div className="graph-view{ graph-view--sidebar-hidden}">` wrapper variant; `!sidebarHidden` unmounts `<aside>`+handle | `<div className="timeline-layout{ timeline-layout--sidebar-hidden}">` variant; `!sidebarHidden` unmounts `<aside>`+handle | component returns `null` when `hidden` (`if (hidden) return null`), wrapped by shell |
| Width default / min | 420 / 280 | 320 / 260 | 320 / 260 | 300 / 220 |
| **localStorage key** | `sidebar-width:issues` | `mandible_graph_sidebar_width:v1` | `mandible_timeline_sidebar_width:v1` | `sidebar-width:spaces` |
| Inline width style | `{ width, flexShrink: 0 }` | `{ width, flexShrink: 0 }` | `{ width, flexShrink: 0 }` | `{ width, flexShrink: 0 }` |
| Header / toolbar region | `.issues-filter` (sticky-ish filter) | `.graph-spec-row` rows + `.graph-toolbar` | `.timeline-toolbar` | `.spaces-tree__header` (fixed, `flex:0 0 auto`) |
| Scroll body region | `.issues-list` / `.issues-tree__empty` (whole `.issues-tree` scrolls, `overflow-y:auto`) | toolbar + `.graph-display-summary` (whole `<aside>` scrolls) | toolbar (whole `<aside>` scrolls) | `.spaces-tree__scroll` (only this scrolls; header fixed) |
| Padding-zeroing mechanism | **negative-margin breakout** `.issues-view { margin:-28px -32px -48px }` (style.css ~5726) — no `app-content--issues` | `.app-content--graph { padding:0 }` (style.css ~1008) | `.app-content--timeline { padding:0 }` (style.css ~1004) | `.app-content--spaces { padding:0 }` — **misplaced in component CSS** `ui/src/views/spaces/SpacesViewShell.css` ~24, not in global style.css |

### The global coupling in `ui/src/style.css`

1. **Enumerated positioning rule** (~1012–1023): hard-codes eight sidebar class
   names and gives them `position: relative; z-index: 2; box-shadow:
   var(--shadow-rail)` when the layout is `app-layout--view-sidebar-open`:
   ```
   .app-layout--view-sidebar-open .auth-sidebar,
   .app-layout--view-sidebar-open .inbox-sidebar,
   .app-layout--view-sidebar-open .issues-tree,
   .app-layout--view-sidebar-open .artifacts-sidebar,
   .app-layout--view-sidebar-open .chat-history-sidebar,
   .app-layout--view-sidebar-open .graph-sidebar,
   .app-layout--view-sidebar-open .spaces-tree,
   .app-layout--view-sidebar-open .timeline-sidebar { … }
   ```
   Every new sidebar must be added here by hand or it loses its rail shadow —
   this is the recurring-bug surface.

2. **Base content padding + per-view overrides**: `.app-content { padding: 28px
   32px 48px }` (~974); per-view `padding:0` overrides for console (~995),
   timeline (~1004), graph (~1008), and Spaces (in component CSS). Issues opts
   out via negative margins instead. Four different views, two different
   mechanisms → the padding bug that the Spaces fix just chased.

3. **Shared resize-handle CSS**: `.sidebar-drag-handle` + `::before` hit-area
   (~3895–3913, `width:0; cursor:col-resize`, the `::before` paints a 10px hover
   strip). Plus per-view `.issues-tree__resize-handle { position:absolute; … }`
   (~5738) and `.spaces-tree__resize-handle` (`SpacesSidebar.css` ~23). Graph and
   timeline use the bare `.sidebar-drag-handle` as a flex sibling (no absolute
   positioning); issues and spaces overlay an absolute handle on the right edge.

These three couplings are what `<ViewSidebar>` collapses into one owner.

---

## 1. `<ViewSidebar>` component API

New file: `ui/src/components/ViewSidebar.tsx`. It owns the **frame element**, the
**resize handle + `useSidebarResize` call**, the **inline width style**, the
**hidden contract**, and the shared `.view-sidebar` class. Views supply only
their content and a per-view storage key + dimensions + an optional content
className.

```tsx
import type { ComponentChildren, JSX } from 'preact';
import { useSidebarResize } from '../hooks/useSidebarResize';

export type ViewSidebarProps = {
  /**
   * Per-view localStorage key for width persistence. REQUIRED and must equal the
   * view's existing key so widths do not reset on migration (Dataful UX state):
   *   issues   → 'sidebar-width:issues'
   *   graph    → 'mandible_graph_sidebar_width:v1'
   *   timeline → 'mandible_timeline_sidebar_width:v1'
   *   spaces   → 'sidebar-width:spaces'
   */
  storageKey: string;

  /** Width defaults — preserve each view's current values exactly. */
  defaultWidth: number;
  minWidth: number;

  /**
   * When true the sidebar is removed from layout. The container owns the hidden
   * contract: it renders nothing (returns null) AND drops the resize handle, so
   * a hidden sidebar can never leave an orphaned drag strip. The host keeps
   * threading its single `viewSidebarHidden` value in unchanged.
   */
  hidden?: boolean;

  /** Accessible name for the rail. e.g. "Graph controls", "Issues". */
  ariaLabel: string;

  /**
   * Frame tag. Defaults to 'aside' (semantically correct for a complementary
   * controls rail). Issues/Spaces historically used <div>; passing 'div' keeps
   * byte-identical DOM for those two if any selector or test depends on it.
   * Recommendation: migrate all four to the default <aside>; see Risks.
   */
  as?: 'aside' | 'div';

  /**
   * Optional view-specific class added ALONGSIDE the shared `.view-sidebar`
   * class, for content-level tweaks only (NOT for container/resize/position —
   * those belong to `.view-sidebar`). e.g. 'issues-tree', 'graph-sidebar',
   * 'timeline-sidebar', 'spaces-tree'. Kept during migration so each view's
   * existing CONTENT CSS (`.issues-filter`, `.graph-toolbar`, …) still matches.
   */
  className?: string;

  /**
   * Optional fixed (non-scrolling) header slot. When provided, the container
   * renders it as `.view-sidebar__header` (flex:0 0 auto) above a
   * `.view-sidebar__body` (flex:1; min-height:0; overflow:auto) wrapping
   * `children`. When omitted, `children` fill the frame directly and the frame
   * itself scrolls (the issues/graph/timeline pattern). This single switch
   * captures the only real structural difference: spaces has a fixed header +
   * separately-scrolling body; the other three scroll as one block.
   */
  header?: ComponentChildren;

  /** Scrollable body content (or the whole frame content when `header` omitted). */
  children: ComponentChildren;
};

export function ViewSidebar(props: ViewSidebarProps): JSX.Element | null {
  const { width, handleMouseDown } = useSidebarResize({
    defaultWidth: props.defaultWidth,
    minWidth: props.minWidth,
    storageKey: props.storageKey,
  });

  if (props.hidden) return null;

  const Frame = props.as ?? 'aside';
  const cls = props.className ? `view-sidebar ${props.className}` : 'view-sidebar';
  const style = width !== null ? { width: `${width}px`, flexShrink: 0 } : undefined;

  return (
    <Frame className={cls} aria-label={props.ariaLabel} style={style}>
      {/* Handle is the FIRST child and absolutely positioned on the right edge
          (via `.view-sidebar__resize-handle`), so it never participates in flex
          layout and never orphans when hidden. This unifies the inside-vs-sibling
          split (issues/spaces had it inside; graph/timeline had it as a sibling). */}
      <div
        className="sidebar-drag-handle view-sidebar__resize-handle"
        onMouseDown={handleMouseDown}
      />
      {props.header !== undefined ? (
        <>
          <div className="view-sidebar__header">{props.header}</div>
          <div className="view-sidebar__body">{props.children}</div>
        </>
      ) : (
        props.children
      )}
    </Frame>
  );
}
```

### Why these choices

- **`hidden` returns null in the container.** Three views (issues, graph,
  timeline) currently conditionally unmount; spaces returns null internally. The
  container makes "hidden ⇒ nothing rendered, including the handle" the single
  contract. Graph/timeline keep their *layout wrapper variant* class
  (`graph-view--sidebar-hidden`, `timeline-layout--sidebar-hidden`) because those
  re-flow the remaining canvas; that wrapper stays in the view, the container
  just stops rendering the rail. See per-view steps.
- **Handle moves INSIDE, absolutely positioned.** Standardizing on the
  issues/spaces placement (absolute, right edge) means the handle never affects
  flex sizing and is identical across views. Graph/timeline lose their
  sibling-flex handle; the visual hit area is preserved by
  `.view-sidebar__resize-handle` (see CSS §2).
- **`storageKey` is a required prop, defaults are passed per view.** This is the
  Dataful UX-state guarantee: each view keeps its exact existing key so no user's
  saved width resets.
- **`header`/`children` two-slot shape** is the minimal expression of the only
  structural divergence (spaces' fixed header vs. one-block scroll). Views with
  no fixed header pass only `children`.
- **`className` is content-only.** All container/position/resize/padding CSS
  lives under `.view-sidebar`; the per-view class only keeps existing *content*
  selectors matching during migration and can be dropped later.

---

## 2. CSS consolidation plan (`ui/src/style.css`)

### 2a. Replace the enumerated positioning rule with one `.view-sidebar` rule

Delete the 8-selector block (~1012–1023) and replace with:

```css
/* One owner for every view-sidebar rail. New sidebars get this for free. */
.view-sidebar {
  position: relative;        /* anchor for the absolute resize handle */
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow: hidden;          /* header fixed; body scrolls (or single-block) */
}

.app-layout--view-sidebar-open .view-sidebar {
  position: relative;
  z-index: 2;
  box-shadow: var(--shadow-rail);
}
```

Note the existing enumerated rule also covered `.auth-sidebar`,
`.inbox-sidebar`, `.artifacts-sidebar`, `.chat-history-sidebar` — these are NOT
in scope for the four-view migration (auth/inbox/artifacts/history are separate
split-pane layouts, not `useSidebarResize` rails). **Keep those four selectors**
in a trimmed enumerated rule, OR add `.view-sidebar` as an additional selector
without removing them. Safest minimal diff: keep the existing rule but **remove
only** `.issues-tree`, `.graph-sidebar`, `.spaces-tree`, `.timeline-sidebar`
from it and add a single `.view-sidebar` selector. Verify auth/inbox/artifacts/
history rails visually unchanged.

### 2b. Standardize the resize handle

Add a shared positioned handle and retire the per-view variants:

```css
.view-sidebar__resize-handle {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
}
```

`.sidebar-drag-handle` + `::before` (~3895) stays as the hit-area paint. Remove
`.issues-tree__resize-handle` (~5738) and `.spaces-tree__resize-handle`
(`SpacesSidebar.css` ~23) once both views adopt `.view-sidebar__resize-handle`.
Graph/timeline gain an absolute handle where they previously had a flex sibling;
confirm the 10px `::before` hover strip still lands on the right edge (it will —
the handle now sits at `right:0` of the frame).

### 2c. One uniform content-padding mechanism (kills the recurring bug)

The root cause of the Spaces padding bug: the `.app-content` base padding (28/32/
48) must be cancelled for full-bleed split views, and four views did it three
different ways (graph/timeline/spaces via `app-content--<view> {padding:0}`,
issues via negative-margin breakout). Replace with a **single structural class
the host adds for any view-sidebar tab**, so a new full-bleed view can never
forget it:

```css
/* Any tab that hosts a split/rail layout is full-bleed: the inner layout owns
   its own gutters. Added by app.tsx for every VIEW_SIDEBAR_TABS route. */
.app-content--view-sidebar {
  padding: 0;
}
```

Then in `ui/src/app.tsx` (~1331), where the `app-content--<view>` classes are
composed, add `app-content--view-sidebar` whenever `VIEW_SIDEBAR_TABS.has(route.
tab)` (the same predicate already computed as `viewSidebarAvailable`, ~1171).
Remove the per-view `app-content--graph`/`--timeline`/`--spaces` padding:0
overrides (graph/timeline in style.css ~1004/~1008; spaces in SpacesViewShell.css
~24), and remove the `.issues-view { margin:-28px -32px -48px }` breakout
(style.css ~5726) — the layout now sits in a zero-padding content area, so
`.issues-view` should drop the negative margins and instead use `height:100%`.

Keep `.app-content--console` as-is (console is not a view-sidebar tab; its
padding:0 is independent).

> Architectural-reflection note (per project CLAUDE.md "Architectural
> reflection"): this is a pure UI-container refactor — no work-unit, issue,
> branch, merge, or auth-queue semantics change, so no `~/.claude/CLAUDE.md`
> update is implied. The Dataful UX-state rule is the binding constraint and is
> satisfied by preserving every persistence key.

### 2d. What stays per-view

Every view keeps its **content** CSS untouched: `.issues-filter`,
`.issues-list`, `.issues-tree__empty`; `.graph-spec-row`, `.graph-toolbar`,
`.graph-display-summary`; `.timeline-toolbar`, `.timeline-control`,
`.timeline-chip`; `.spaces-tree__header`, `.spaces-tree__scroll`,
`.spaces-tree__group*`, `.spaces-tree__space*`. These keep matching because the
per-view `className` is still applied alongside `.view-sidebar`.

---

## 3. Per-view migration plan (minimal diff, zero behavior change)

General shape for each view: delete the local `useSidebarResize` call, the
hand-rolled frame element, the inline width style, and the local resize-handle
div; wrap the existing content in `<ViewSidebar>` with that view's exact
`storageKey`/`defaultWidth`/`minWidth`/`ariaLabel`/`className`.

### 3.1 Issues (`ui/src/views/issues.tsx` ~725–735) — **migrate first (reference)**

- Remove the `useSidebarResize({ defaultWidth:420, minWidth:280, storageKey:
  'sidebar-width:issues' })` call (~725) and the `!sidebarHidden ? (<div
  className="issues-tree" style=…><div className="sidebar-drag-handle
  issues-tree__resize-handle"/> …` wrapper (~733–735).
- Replace with:
  ```tsx
  <ViewSidebar
    hidden={sidebarHidden}
    storageKey="sidebar-width:issues"
    defaultWidth={420}
    minWidth={280}
    ariaLabel="Issues"
    className="issues-tree"
    as="div"            /* keep <div> if any test/selector asserts it; else drop */
  >
    {/* existing .issues-filter + .issues-list/.issues-tree__empty content */}
  </ViewSidebar>
  ```
- Issues has **no fixed header** (the whole `.issues-tree` scrolls), so pass only
  `children`, no `header` slot. `.issues-tree { overflow-y:auto; padding:12px }`
  still applies via the kept className — but note `.view-sidebar` adds
  `overflow:hidden`; resolve by either (a) keeping issues as single-block scroll
  via a `header`-less body that scrolls, or (b) letting `.issues-tree`'s
  `overflow-y:auto` win. Cleanest: when `header` is omitted, `.view-sidebar`
  should let the frame scroll — see Risk R3; the reference migration must settle
  this and it becomes the pattern for graph/timeline.
- Drop `.issues-tree__resize-handle` from style.css after this lands. Remove
  `.issues-view` negative margins per §2c.

### 3.2 Graph (`ui/src/views/graph.tsx` ~949, ~1174–1293)

- Remove `useSidebarResize({ defaultWidth:320, minWidth:260, storageKey:
  'mandible_graph_sidebar_width:v1' })` (~949).
- Keep the outer wrapper variant: `<div className="graph-view{ sidebarHidden ?
  ' graph-view--sidebar-hidden' : ''}">` (~1174) — it re-flows the canvas. Inside
  it, replace the `!sidebarHidden ? (<><aside …>…</aside><div
  className="sidebar-drag-handle"…/></>) : null` (~1175–1293) with:
  ```tsx
  <ViewSidebar
    hidden={sidebarHidden}
    storageKey="mandible_graph_sidebar_width:v1"
    defaultWidth={320}
    minWidth={260}
    ariaLabel="Graph controls"
    className="graph-sidebar"
  >
    {/* existing .graph-spec-row / .graph-toolbar / .graph-display-summary */}
  </ViewSidebar>
  ```
- Net behavior change to verify: the drag handle moves from a flex sibling to an
  absolute right-edge handle. Visual hit area preserved by §2b. `<aside>` tag
  preserved (default).

### 3.3 Timeline (`ui/src/views/timeline.tsx` ~730, ~1617–1742)

- Same shape as graph. Keep `<div className="timeline-layout{
  timeline-layout--sidebar-hidden}">` (~1617). Replace the
  `!sidebarHidden ? (<><aside className="timeline-sidebar"…>…</aside><div
  className="sidebar-drag-handle"…/></>) : null` (~1618–1742) with:
  ```tsx
  <ViewSidebar
    hidden={sidebarHidden}
    storageKey="mandible_timeline_sidebar_width:v1"
    defaultWidth={320}
    minWidth={260}
    ariaLabel="Timeline controls"
    className="timeline-sidebar"
  >
    {/* existing .timeline-toolbar content */}
  </ViewSidebar>
  ```

### 3.4 Spaces (`SpacesSidebar.tsx` ~198, ~505–615; `SpacesViewShell.tsx` ~129)

- Remove `useSidebarResize({ defaultWidth:300, minWidth:220, storageKey:
  'sidebar-width:spaces' })` (~198), the outer `<div className="spaces-tree"
  style=…>` (~505), and the inner `<div className="sidebar-drag-handle
  spaces-tree__resize-handle"…/>` (~512). Also remove the early `if (hidden)
  return null` (~397) — the container owns `hidden` now.
- Spaces is the **one view that uses the `header` slot** (fixed
  `.spaces-tree__header` + separately-scrolling `.spaces-tree__scroll`):
  ```tsx
  <ViewSidebar
    hidden={hidden}
    storageKey="sidebar-width:spaces"
    defaultWidth={300}
    minWidth={220}
    ariaLabel="Spaces"
    className="spaces-tree"
    as="div"
    header={/* existing .spaces-tree__header: filter input + top-level + button */}
  >
    {/* existing .spaces-tree__scroll content (groups, rows, empty states) */}
  </ViewSidebar>
  ```
  The `containerRef` used for the popover outside-click handler (~196, ~232) must
  still wrap the whole sidebar. Either forward a ref through `<ViewSidebar>`
  (add an optional `containerRef` prop) or keep the popover/chooser/seed overlays
  rendered inside the body and scope the outside-click check to the rendered
  `.view-sidebar` node (e.g. `event.target.closest('.spaces-tree')`). Forwarding
  a ref is the smaller behavioral risk.
- `.spaces-tree__header` keeps `flex:0 0 auto`; map it onto the container's
  `.view-sidebar__header`. `.spaces-tree__scroll` keeps its own `overflow:auto`;
  it sits inside `.view-sidebar__body`. Confirm no double scrollbar (the body
  wrapper and `.spaces-tree__scroll` should not both scroll — give the body
  `display:flex; flex-direction:column` and let `.spaces-tree__scroll` own the
  scroll, or drop `.spaces-tree__scroll`'s overflow in favor of the body's).
- Drop `.spaces-tree__resize-handle` from `SpacesSidebar.css`; drop
  `.app-content--spaces { padding:0 }` from `SpacesViewShell.css` (now covered by
  `.app-content--view-sidebar`, §2c).

---

## 4. Spaces content fold-in (from the two-eyes review)

The padding/whitespace fix comes free from §2c/§3.4 (Spaces now lives in the
uniform `.app-content--view-sidebar` zero-padding area). Do these polish items
**during the Spaces migration**, not as a separate pass:

### 4a. Empty-project noise + duplicate-name disambiguation

- **"No spaces yet" under every project:** `listSpacesGrouped`
  (`src/ledger/spaces.ts` ~325) already emits a group **only when it has ≥1
  space** (the comment at ~322 confirms: "A group is emitted only when it has at
  least one Space, so empty projects do not appear"). So in steady state the
  `.spaces-tree__empty-group` "No spaces yet" branch (`SpacesSidebar.tsx` ~592)
  only fires when a filter strips a project's spaces but the project name still
  matches the needle. Fix: in the filter path (~278–290) a project whose name
  matches but has zero matching spaces should still render the header without the
  misleading "No spaces yet" — show a muted count or nothing under it. Minimal:
  change ~592 to render the empty line **only when not filtering**
  (`!needle`) — and since unfiltered empty groups don't occur, that effectively
  removes the noise. Confirm with a test that a name-matched, space-filtered
  group shows no "No spaces yet".
- **Duplicate project names:** `project_name` comes from
  `ledger_projects.display_name`, which is not unique; same-named projects are
  indistinguishable in the rail. The ledger has `remote_identity` /
  `upstream_identity` on `ledger_projects` (`src/db.ts` ~1001) — a stable
  disambiguator. Plan: extend `SpaceGroup` (`src/contracts.ts` ~603 and
  `src/ledger/spaces.ts` ~309) with an optional `project_hint` (derived from
  `remote_identity`, e.g. the repo/owner slug) **only when a display_name
  collides** within the result set. In `SpacesSidebar.tsx` ~581
  (`.spaces-tree__group-name`), render the hint as a small muted suffix
  (`.spaces-tree__group-hint`) next to duplicate names. This is a backend
  contract change → file/keep it on issue e29a8c5's plan; gate it behind the
  collision check so non-duplicate projects render unchanged.

### 4b. `.spaces-shell__empty` flex whitespace bug

`SpacesViewShell.tsx` ~169 renders `Select a space, or create one with the
<strong>+</strong> in the sidebar.` and `.spaces-shell__empty`
(`SpacesViewShell.css` ~100) sets `display:flex; align-items:center;
justify-content:center`. Flex makes each text run + the `<strong>` flex items,
collapsing the spaces around `+` ("with the**+**in the sidebar"). Fix: wrap the
message text in a single inline element and center *that*, e.g.
`.spaces-shell__empty { display:flex; … }` containing one `<p
className="spaces-shell__empty-text">…</p>` that is `text-align:center` and not a
flex container — so normal inline whitespace renders. Same applies to the second
empty state at ~174 ("No **{renderer}** renderer is available yet.").

### 4c. Replace hardcoded `rgba(77,163,255,0.14)` with theme tokens

The Spaces active-row color is `.spaces-tree__space--active { background:
var(--accent-soft, rgba(74, 141, 240, 0.16)) }` (`SpacesSidebar.css` ~177) — it
already uses `--accent-soft` with a fallback, so it themes correctly; verify
`--accent-soft` is defined (it is referenced widely). The literal
`rgba(77,163,255,0.14)` the review flagged corresponds to the project's info/
selected token: `--status-info-bg` is `rgba(77,163,255,0.15)` and
`--overlay-selected: var(--status-info-bg)` (`style.css` ~41, ~81), with light-
theme variants (~169). Any remaining hardcoded `rgba(77,163,255,…)` inside the
Spaces component CSS (audit `SpacesSidebar.css`, `SpacesViewShell.css`,
`SpaceSeedDialog.css` ~59, `SpaceExportDialog.css`, `RepoFileRegisterDialog.css`)
should use `var(--overlay-selected)` / `var(--status-info-bg)` for
selected/active backgrounds and `var(--accent)` / `var(--accent-soft)` for accent
fills, so both light and dark themes track. Keep this scoped to Spaces files in
this issue; the ~150 hardcoded occurrences elsewhere in `style.css` are out of
scope.

---

## 5. Risks + verification

### Risks

- **R1 — rail shadow loss.** Editing the enumerated `app-layout--view-sidebar-
  open` rule (§2a) can drop the rail shadow on a sidebar if its class is removed
  without `.view-sidebar` taking over. Mitigation: keep auth/inbox/artifacts/
  history selectors; verify all eight rails still show `--shadow-rail`.
- **R2 — width reset (Dataful UX violation).** A mistyped `storageKey` resets a
  user's saved width. Mitigation: the keys are enumerated in §1; assert each in
  the migration diff and in a test that reads localStorage.
- **R3 — scroll/overflow regression.** `.view-sidebar` adds `overflow:hidden`;
  issues/graph/timeline previously scrolled the frame directly. The `header`-less
  branch must keep the frame (or a single body) scrollable. Settle this in the
  issues reference migration; re-use for graph/timeline. Spaces must avoid a
  double scrollbar between `.view-sidebar__body` and `.spaces-tree__scroll`.
- **R4 — handle placement behavior.** Graph/timeline move from a flex-sibling
  handle to an absolute right-edge handle. The drag math is identical (same
  hook); only the hit-area element changes. Verify the cursor strip lands on the
  rail's right edge and dragging still resizes smoothly (rAF + 50% clamp).
- **R5 — `<aside>` vs `<div>` semantics/tests.** Switching issues/spaces frames
  to `<aside>` changes the tag. Use `as="div"` to keep them byte-identical if any
  test or selector asserts the tag; otherwise standardize on `<aside>` and update
  selectors. Grep tests for `.issues-tree`/`.spaces-tree` tag assertions first.
- **R6 — Spaces popover outside-click.** The chooser/seed outside-click handler
  depends on `containerRef` wrapping the whole sidebar. Forward a ref through
  `<ViewSidebar>` (preferred) or scope the check to `.spaces-tree`. Test: open
  chooser, click outside, it closes; click inside, it stays.
- **R7 — spaces empty-state filtering change (4a).** Verify a name-matched,
  space-filtered project no longer shows "No spaces yet" and that genuinely empty
  unfiltered state ("No spaces yet. Use + to create one.") still renders.

### Verification plan

- **Tests:** add/extend vitest specs — (a) `ViewSidebar` renders frame +
  handle, returns null when `hidden`, applies `storageKey`/width, renders
  `header` vs single-block; (b) per-view width persistence reads the exact
  legacy key from localStorage; (c) Spaces popover outside-click; (d) Spaces
  empty-group filtering (4a) and `.spaces-shell__empty` text (4b).
- **Build hygiene** (project CLAUDE.md): `npm run build` from a worktree with
  copied `node_modules` (never `npm ci`); confirm `git ls-files dist ui/dist`
  returns nothing before delivery.
- **Manual / screenshot — all four views × light + dark** (8 shots), each
  checked for: width persists across refresh; resize feel (smooth, min/max
  clamps); hidden toggle removes rail + handle and re-flows canvas
  (graph/timeline); rail shadow present when open; scroll body behaves; Spaces
  fixed header stays put while body scrolls; Spaces empty-state whitespace and
  active-row color correct in both themes. Use the IAB preview launcher
  (`npm run iab-preview -- --json`) per project convention.

---

## 6. Ordered implementation sequence

1. **Add `<ViewSidebar>`** (`ui/src/components/ViewSidebar.tsx`) + the
   `.view-sidebar`, `.view-sidebar__header/__body`, `.view-sidebar__resize-handle`
   CSS (§2a/§2b) and the `.app-content--view-sidebar` padding rule (§2c) wired in
   `app.tsx`. No view migrated yet; both old and new CSS coexist.
2. **Migrate Issues first (reference).** It has the simplest content, no fixed
   header, and the negative-margin breakout to retire — settling R3 (scroll) and
   §2c (padding) here defines the pattern. Verify width key `sidebar-width:issues`
   preserved.
3. **Migrate Graph**, then **Timeline** (near-identical: `<aside>` + wrapper
   variant + single-block scroll). Confirm R4 (handle) on both.
4. **Migrate Spaces** using the `header` slot, fold in §4 (empty-state filtering,
   `.spaces-shell__empty` whitespace, theme tokens) and forward `containerRef`
   (R6). This is the view that motivated the issue; doing it last lets it inherit
   the now-proven container.
5. **Remove dead CSS:** the four enumerated sidebar selectors, the per-view
   `app-content--graph/--timeline/--spaces` padding overrides, the `.issues-view`
   negative margins, and `.issues-tree__resize-handle` /
   `.spaces-tree__resize-handle`.
6. **Full verification** (§5): tests green, 8 screenshots, build hygiene clean.

Optional follow-up (defer): once all four views use `.view-sidebar`, the
per-view `className` exists only to keep *content* selectors matching; a later
pass could rename content classes to `view-sidebar__*` and drop the per-view
class entirely. File as a `deferred` issue, not part of e29a8c5.
