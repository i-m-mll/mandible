# P3 Integration Plan: GraphView App Wiring

Partition: `feature__graphview__integration`
Issue: 7628f7e
Date: 2026-03-09

---

## Overview

This partition wires the GraphView component (delivered by P2 at `ui/src/views/graph.tsx`) into
the Mandible app shell. Changes are confined to three files:

- `ui/src/app.tsx` — route type, parse, nav button, render case, handleGraphNavigate, SSE handlers
- `ui/src/api.ts` — GraphQueryParams type + getGraph() function
- `ui/src/state.ts` — no changes needed (see state decision below)

Estimated total lines changed: ~65–80 lines (net additions).

---

## File: ui/src/api.ts

### What to add

Two additions at the end of the file, before the closing (after line 808):

1. **`GraphQueryParams` type** — query parameters for GET /api/graph
2. **`getGraph()` function** — fetches `{ nodes, edges }` from the API

These types must be defined in `api.ts` because they are shared between the API layer and the
GraphView component itself. The GraphView (P2) will import `GraphNode` and `GraphEdge` from
wherever P2 defines them; `getGraph` is imported and called by the GraphView component internally
(preferred) OR passed in as a prop. See the interface contract section below.

### Exact additions (insert after line 808, end of file)

```typescript
// ── Graph API ──

export type GraphQueryParams = {
  repo?: string;
  since?: string;
  limit?: number;
  status?: 'open' | 'all';
};

export type GraphNode = {
  id: string;
  type: 'session' | 'issue' | 'auth_request' | 'branch';
  label: string;
  status?: string;
  repo_id?: string;
  metadata?: Record<string, unknown>;
};

export type GraphEdge = {
  source: string;
  target: string;
  type: string;
};

export async function getGraph(
  params: GraphQueryParams = {},
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const query = new URLSearchParams();
  if (params.repo) query.set('repo', params.repo);
  if (params.since) query.set('since', params.since);
  if (params.limit != null) query.set('limit', String(params.limit));
  if (params.status) query.set('status', params.status);
  const qs = query.toString();
  const response = await apiGet(`/api/graph${qs ? '?' + qs : ''}`);
  return (await parseMaybeJson(response)) as { nodes: GraphNode[]; edges: GraphEdge[] };
}
```

**Note on GraphNode type ownership:** P2 will define its own internal node/edge types for
rendering. The `GraphNode` and `GraphEdge` types here are the API wire types. P2 may re-export or
re-use these, or define its own. Coordinate at merge time: if P2 already defined these types in
`graph.tsx`, do NOT duplicate — remove them from `api.ts` and import from the view, or vice versa.
One canonical definition; zero duplication.

---

## File: ui/src/app.tsx

### Change 1 — Route type union (line 92)

Current line 92:
```typescript
  tab: 'sessions' | 'auth' | 'chat-history' | 'work' | 'review' | 'issues' | 'settings' | 'switchboard' | 'inbox' | 'console' | 'logs';
```

Change to:
```typescript
  tab: 'sessions' | 'auth' | 'chat-history' | 'work' | 'review' | 'issues' | 'settings' | 'switchboard' | 'inbox' | 'console' | 'logs' | 'graph';
```

### Change 2 — parseHashRoute() recognized paths array (line 112)

Current line 112:
```typescript
  const tab = ['sessions', 'auth', 'chat-history', 'work', 'review', 'issues', 'settings', 'switchboard', 'inbox', 'console', 'logs'].includes(normalizedPath)
```

Change to:
```typescript
  const tab = ['sessions', 'auth', 'chat-history', 'work', 'review', 'issues', 'settings', 'switchboard', 'inbox', 'console', 'logs', 'graph'].includes(normalizedPath)
```

### Change 3 — Import GraphView and GraphNode type

At line 56 (after the `import { LogsView }` line), add:
```typescript
import { GraphView } from './views/graph';
import type { GraphNodeType } from './views/graph';
```

Also add `getGraph` to the existing `api.ts` import block (lines 4–38). Insert `getGraph` into the
named imports list:
```typescript
  getGraph,
```

### Change 4 — handleGraphNavigate function

Insert after line 791 (after `handleSelectInboxItem`, before the `if (rebuilding)` guard at
line 794). This keeps all handlers together:

```typescript
  const handleGraphNavigate = (type: GraphNodeType, id: string, repoId?: string) => {
    switch (type) {
      case 'issue':
        navigate({ tab: 'issues', params: { ...(repoId ? { repo: repoId } : {}), issue: id } });
        break;
      case 'session':
        navigate({ tab: 'sessions', params: { session: id } });
        break;
      case 'auth_request':
        navigate({ tab: 'auth', params: { request: id } });
        break;
      case 'branch':
        navigate({ tab: 'work', params: { ...(repoId ? { repo: repoId } : {}), branch: id } });
        break;
      default:
        break;
    }
  };
```

**Note on `navigate` function:** The codebase uses `window.location.hash` assignment for
navigation (e.g., `window.location.hash = '#/sessions'`). There is NO standalone `navigate()`
helper function in `app.tsx` — navigation happens through hash changes and the `setRoute`/
`parseHashRoute` machinery. The correct implementation for `handleGraphNavigate` is therefore:

```typescript
  const handleGraphNavigate = (type: GraphNodeType, id: string, repoId?: string) => {
    switch (type) {
      case 'issue': {
        const params = new URLSearchParams({ issue: id });
        if (repoId) params.set('repo', repoId);
        window.location.hash = `#/issues?${params.toString()}`;
        break;
      }
      case 'session':
        window.location.hash = `#/sessions?session=${encodeURIComponent(id)}`;
        break;
      case 'auth_request':
        window.location.hash = `#/auth?request=${encodeURIComponent(id)}`;
        break;
      case 'branch': {
        const params = new URLSearchParams({ branch: id });
        if (repoId) params.set('repo', repoId);
        window.location.hash = `#/work?${params.toString()}`;
        break;
      }
      default:
        break;
    }
  };
```

This triggers the `hashchange` event listener (line 144–148), which calls `setRoute(parseHashRoute())`,
which re-renders the view correctly. No separate `navigate()` helper is needed.

### Change 5 — Graph nav button in header

The gear button (lines 899–904) is a standalone `<a>` element in the nav, NOT inside a
`tab-twin` div. The graph button goes immediately to the LEFT of the gear button — i.e., insert
it between the closing `</div>` of the second `tab-twin` (line 898) and the gear `<a>` tag
(line 899).

Insert after line 898:

```tsx
          <a
            href="#/graph"
            className={route.tab === 'graph' ? 'active' : ''}
            aria-label="Graph"
            title="Graph"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
              style={{ verticalAlign: 'middle', display: 'inline-block' }}
            >
              {/* Three nodes as circles */}
              <circle cx="8" cy="3" r="2" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="2.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="13.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
              {/* Edges connecting them */}
              <line x1="8" y1="5" x2="2.5" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <line x1="8" y1="5" x2="13.5" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <line x1="4.5" y1="12" x2="11.5" y2="12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </a>
```

**SVG design:** Three circles arranged as a triangle (top-center node at (8,3), bottom-left at
(2.5,12), bottom-right at (13.5,12)), connected by three lines forming a graph. The circles use
`r="2"` to match the gear button's visual weight. Strokes use `currentColor` so it inherits the
nav link color and goes active with CSS.

**Visual pattern:** The gear button (line 899–904) uses an `<a href="#/settings">` with an SVG
child and `style={{verticalAlign:'middle', display:'inline-block'}}` on the SVG. Match this
exactly: same element type (`<a>`), same SVG attribute pattern, same inline style. The `.active`
class matches how the gear button handles its active state.

### Change 6 — Render switch: graph case

After line 1054 (after the `{route.tab === 'logs' && <LogsView />}` block, before `</main>`),
add:

```tsx
        {route.tab === 'graph' && (
          <GraphView onNavigate={handleGraphNavigate} />
        )}
```

### Change 7 — Graph refresh ref and SSE-triggered refresh

The graph component manages its own data fetching internally (see state decision below). To allow
SSE events to trigger a re-fetch without reaching into the component's internals, use a
`graphRefreshToken` counter in the App component. The GraphView receives this as a prop and
re-fetches when it changes.

Add a state variable near the top of the `App` function (after the existing state declarations,
around line 143):

```typescript
  const [graphRefreshToken, setGraphRefreshToken] = useState(0);
```

In the SSE handler registration block (lines 367–389), add a `graphRefreshHandler` and register
it for the relevant events. The handler only does work if it will be visible (but since SSE
subscriptions are app-level and always active, we simply increment the token regardless — the
GraphView will ignore re-fetches when it's not mounted):

```typescript
    const graphRefreshHandler = (_payload: SSEPayload) => {
      setGraphRefreshToken((n) => n + 1);
    };
```

Add these subscriptions to the `unsubscribes` array (after line 388, before
`client.on('mandible:rebuilding', rebuildingHandler)`):

```typescript
      client.on('session:registered', graphRefreshHandler),
      client.on('session:updated', graphRefreshHandler),
      client.on('session:ended', graphRefreshHandler),
      client.on('auth:new', graphRefreshHandler),
      client.on('auth:updated', graphRefreshHandler),
      client.on('auth:resolved', graphRefreshHandler),
      client.on('work:branch:updated', graphRefreshHandler),
```

**Important:** These are additional subscriptions on top of the existing `handler` subscriptions.
The `SSEClient.on()` method uses a `Set<SSEHandler>`, so registering the same event type twice
with different handler functions is fine — both handlers will be called. The existing `handler`
continues dispatching to global app state; `graphRefreshHandler` additionally triggers a graph
re-fetch.

Update the `GraphView` render call to pass the token:

```tsx
        {route.tab === 'graph' && (
          <GraphView onNavigate={handleGraphNavigate} refreshToken={graphRefreshToken} />
        )}
```

---

## State Decision: Local vs Global

**Decision: local component state in GraphView, not global app state.**

Reasoning:

1. **Graph data is view-local.** No other tab reads or depends on graph node/edge data. Putting
   it in global state (`AppState`) would pollute the state shape and `appReducer` for zero benefit.

2. **Filtering is view-local.** The graph has its own filter controls (repo, status, since). These
   filter params belong in the component, not in the URL params or global state.

3. **Always fresh-fetched.** Unlike sessions or auth queue (which are bootstrapped at startup and
   kept current via SSE upserts), graph data is a derived view of existing state — it is cheap to
   re-fetch on demand and doesn't need a persistent cache.

4. **SSE-driven updates via refresh token.** Rather than maintaining graph data in the reducer
   (which would require new action types, reducer cases, and cache logic), we use a
   `graphRefreshToken` integer prop. When relevant SSE events fire, the App increments the token;
   `GraphView` has a `useEffect([refreshToken])` that calls `getGraph()` again. This is the
   same pattern the Console view uses for its own isolated data management.

5. **No `state.ts` changes needed.** The `AppState` type, `appReducer`, `initialState`, and
   `loadCachedState`/`saveCachedState` are all unchanged.

---

## SSE Events and Refresh Triggers

| SSE event            | Why it triggers graph refresh                              |
|---------------------|------------------------------------------------------------|
| `session:registered` | New session node may appear                               |
| `session:updated`    | Session status change may affect node styling             |
| `session:ended`      | Session ended — node status changes                       |
| `auth:new`           | New auth_request node                                     |
| `auth:updated`       | Auth request field change                                 |
| `auth:resolved`      | Auth request resolved — node status changes               |
| `work:branch:updated`| Branch node status changes (dirty, merged, etc.)          |

Events NOT triggering a graph refresh (not graph-relevant):
- `auth:output` — streaming text, no graph topology change
- `conversation:new`, `conversation:updated` — conversations are not graph nodes
- All `console:*` events — console sessions are not in the graph
- `daemon:reloaded` — existing `daemonHandler` handles this
- `mandible:rebuilding` — existing `rebuildingHandler` handles this

---

## Interface Contract with P2

P2 (partition `feature/graphview__renderer`) delivers `ui/src/views/graph.tsx`. The integration
seam requires agreement on these exported names:

### Expected P2 exports from `ui/src/views/graph.tsx`

```typescript
// The type used for the onNavigate callback's first argument
export type GraphNodeType = 'session' | 'issue' | 'auth_request' | 'branch';

// The component itself
export function GraphView(props: {
  onNavigate: (type: GraphNodeType, id: string, repoId?: string) => void;
  refreshToken?: number;  // increment to trigger re-fetch
}): JSX.Element;
```

### GraphView internal responsibilities (P2 owns these, P3 does not):

- Calling `getGraph(params)` from `api.ts` to fetch data
- Local state for filter params (repo, since, limit, status)
- Rendering the canvas/SVG graph
- Calling `props.onNavigate(type, id, repoId)` when the user clicks a node
- Watching `props.refreshToken` in a `useEffect` dependency array to re-fetch when it changes

### Merge-time coordination

When the integration branch merges P2 and P3, check:

1. Does P2 export `GraphNodeType` and `GraphView` with the signatures above? If P2 used different
   names, update the imports in `app.tsx` accordingly.
2. Does P2 define its own `GraphNode`/`GraphEdge` types? If so, remove the duplicate definitions
   from `api.ts` and have `getGraph()` return P2's types (or use a type alias).
3. Does P2 expect `refreshToken` as a prop? If P2 instead uses a ref callback or imperative
   handle, update Change 7 accordingly.
4. Does P2 call `getGraph()` directly from `api.ts`, or does it accept a data prop? This plan
   assumes P2 fetches internally. If P2 accepts data as props, the App component would need to
   fetch and pass data instead — update Changes 5/6/7 accordingly.

---

## Ordering Concerns

- P3 changes to `app.tsx` and `api.ts` can be committed independently of P2.
- The TypeScript compiler will error on the `GraphView` import until P2's `graph.tsx` exists in
  the same branch. During development on the integration branch, stub `graph.tsx` if needed:
  ```typescript
  // ui/src/views/graph.tsx — stub for integration branch build
  export type GraphNodeType = 'session' | 'issue' | 'auth_request' | 'branch';
  export function GraphView(_props: { onNavigate: (type: GraphNodeType, id: string, repoId?: string) => void; refreshToken?: number }): JSX.Element {
    return <div>Graph (stub)</div>;
  }
  ```
- Do NOT commit the stub as part of the integration branch dist — it should be replaced by P2's
  real implementation before building dist.

---

## Estimated Lines of Change

| File | Additions | Modifications | Net |
|------|-----------|---------------|-----|
| `ui/src/api.ts` | ~35 lines | 0 | +35 |
| `ui/src/app.tsx` | ~50 lines | 3 one-line edits | +53 |
| `ui/src/state.ts` | 0 | 0 | 0 |
| **Total** | **~85 lines** | **3 edits** | **~88** |

---

## Checklist for Implementer

- [ ] Add `GraphNode`, `GraphEdge`, `GraphQueryParams`, `getGraph` to `api.ts` (after line 808)
- [ ] Add `'graph'` to `Route['tab']` union (line 92)
- [ ] Add `'graph'` to `parseHashRoute()` array (line 112)
- [ ] Add `import { GraphView } from './views/graph'` and `import type { GraphNodeType }` (after line 56)
- [ ] Add `getGraph` to the `api.ts` named import block (lines 4–38)
- [ ] Add `graphRefreshToken` state variable (~line 143)
- [ ] Add `handleGraphNavigate` function (~after line 791)
- [ ] Add graph nav button SVG between second tab-twin close tag and gear button (after line 898)
- [ ] Add `graphRefreshHandler` and 7 new `client.on(...)` subscriptions in the SSE block
- [ ] Add `{route.tab === 'graph' && <GraphView ... />}` render case (after line 1054)
- [ ] Coordinate with P2 on `GraphNodeType`, `GraphView` prop signature, and type ownership
