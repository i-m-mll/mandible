# Post-consolidation abstraction design review

Mandible-Issue: 88e6aeb

## Executive decision

The post-consolidation codebase does not need a general repository layer, generic entity browser,
handler DSL, or a campaign to split every large file. Those abstractions would add indirection
without enforcing a shared behavioral contract.

Ten narrower proposals are justified. Each isolates a policy that is currently duplicated or
interleaved with orchestration: issue-reference resolution, artifact-list filters, three auth
proof/replay engines, issue-route domains, artifact identity resolution, keyed UI detail loads,
ingestion persistence states, and graph projection. Their combined value is fewer bugs involving
ambiguity, authority, ordering, stale data, and commit/publication boundaries. Most add explicit
type or wiring code; that cost is accepted where it turns an implicit invariant into a testable
boundary.

## Scope and method

This review evaluates Mandible at integrated commit `b690305`, after the code-consolidation
lanes had landed. It asks whether the surviving code is factored at the right abstraction
level. The standard is behavioral: a proposal is accepted only when it prevents named bug
classes or makes a risky change materially more local. Moving code or reducing file size for
its own sake is not a benefit.

The measurements below come from the checked-in TypeScript and TSX sources at that commit.
Six independent read-only archaeology passes covered entity persistence, auth queue behavior,
issue HTTP routes, artifact identity, UI list/detail composition, and cross-cutting seams. The
worker session rechecked their evidence and decisions against the source before filing any
follow-on work.

## Decision summary

| Area | Decision | Production-code estimate | Primary behavioral benefit |
| --- | --- | ---: | --- |
| Entity handling | Accept canonical issue-ref resolver | −70 to −95 lines | One ambiguity, prefix, alias, and project-scope policy |
| Artifact lists | Accept filter contract with two storage adapters | −60 to −100 lines | Canonical/legacy filter parity |
| Auth merge checking | Accept `AuthMergeChecker` | +25 to +45 lines | Stable queue/target fingerprints and error classes |
| Deferred auth actions | Accept `DeferredActionExecutor` | +20 to +35 lines | Independent, idempotent outcomes and replay |
| Work-unit merge proof | Accept `MergeWorkUnitResolver` | +25 to +45 lines | Correct repository, branch-containment, and archive attribution |
| Issue HTTP surface | Accept domain-first route decomposition | +85 to +140 lines | Route-order, file-RPC, and umbrella semantic parity |
| Artifact identity | Accept strict discriminated resolver boundary | −30 to −90 lines | Canonical target completeness and explicit resolution mode |
| UI detail loading | Accept `useKeyedAsyncDetail` | −30 to +30 lines | Key coherence and stale-response rejection |
| Ingestion | Accept explicit plan/persist/commit outcomes | +80 to +130 lines | Atomic append/full state and post-commit publication |
| Graph backend | Accept domain projection outside HTTP module | +50 to +90 lines | One endpoint-closure/filter/count contract |

## 1. Entity and repository patterns

### Current shape

`src/provider-artifacts.ts` is 7,231 lines. It contains 55 module-level functions whose
names begin with `get`, `list`, or `resolve`, plus 16 explicit `*FromRow` mappers. The
artifact families share verbs but not one data contract: canonical logical artifacts,
blobs, versions, compatibility series and drafts, aliases, links, project associations,
providers, and manifests differ in identity and enrichment behavior.

`src/ledger/store.ts` is 2,795 lines with 18 read-shaped methods. The issue/comment read
section at lines 1877–2093 owns canonical issue resolution, issue detail, aliases, branches,
checkpoints, events, revisions, and comment lookup. Another 67 direct issue/comment SQL reads
appear in 20 modules. Those reads are mostly specialized batch, graph, timeline, and head
projections rather than accidental repository bypasses.

The repetition therefore has two different causes. Artifact rows need JSON parsing,
compatibility defaults, aliases, and canonical projection. Ledger rows lean on database
`CHECK` and `NOT NULL` constraints. Primitive coercion is already centralized in
`src/row-coerce.ts`; a universal mapper would abstract field names while hiding policy.

### Accepted: canonical issue-reference resolver

Issue resolution is independently implemented in about 160 production lines:

| Consumer | Current implementation | Approximate lines |
| --- | --- | ---: |
| Ledger | `LedgerStore.resolveIssueRef` | 74 |
| Artifact graph/link resolution | `issueMatches` | 48 |
| Repo artifact scanner | `resolveIssueId` | 18 |
| Auth closure | exact-only local variant | remainder |

The accepted seam is ledger-owned and returns a match set plus a discriminated single-result
wrapper. Prefix policy (`exact`, `exact-or-prefix`, and minimum prefix length) and canonical
`project_id` scope must be explicit. It is expected to add 60–75 shared lines, remove 135–165
duplicated lines, and add 70–100 matrix-test lines: a net production reduction of roughly
70–95 lines at low migration complexity.

This prevents alias/prefix disagreement, ambiguity being treated as absence, wildcard escaping
drift, project-scope and case drift, and different auth/scanner behavior from CLI behavior.

### Accepted: artifact-list filter contract with storage adapters

`listCanonicalArtifactCompatibility`, `listLegacyArtifacts`, and their merge occupy 338 lines
and separately implement 11 filter dimensions: text, hash prefix, repository, provider, role,
custody, availability, scheme, location, linked entity, and canonical link target. The accepted
design is one declarative filter contract with explicit canonical and legacy SQL adapters and
capability requirements. It is not a generic ORM.

Expected cost is 120–160 contract/compiler lines and 100–140 parity-test lines, replacing
210–250 conditional query-building lines for a net production reduction of about 60–100 lines.
It prevents one-sided filter additions, wildcard-escaping differences, silently ignored
capability-dependent filters, cross-store pagination mismatch, and divergent link semantics.

### Rejected entity abstractions

- A generic `Repository<T>` is rejected. Identity, tombstones, compatibility projection, graph
  enrichment, transactions, and event behavior differ. It would add an estimated 150–300
  infrastructure lines with no unique reliability benefit.
- A reflective `fromRow<T>` mapper is rejected. The 16 artifact mappers encode policy, while
  ledger row validity is enforced by schema constraints. Reflection would move field drift to
  runtime.
- Separate issue and comment repository classes are rejected. Ledger mutations deliberately
  coordinate bodies, revisions, events, relationships, outbox rows, and SSE within transaction
  boundaries.
- Forcing all 67 specialized projections through `LedgerStore` is rejected because it would
  hide query shape and likely degrade batch performance.
- A cross-entity issue/artifact resolver is rejected. Artifact identity/version/blob/living-link
  semantics and issue project/alias/prefix semantics only share a verb.

## 2. Auth queue decomposition

### Current shape and dependency map

`src/auth-queue.ts` has grown to 2,939 lines. `AuthQueue` holds 14 state fields, 81 ordinary
methods, a constructor, a getter, and eight file helpers. The meaningful clusters are:

| Cluster | Methods | Lines |
| --- | ---: | ---: |
| Queue state and API | 20 | 599 |
| Execution | 10 | 328 |
| Merge check | 9 | 340, plus 59 helper lines |
| Deferred ledger actions | 10 | 264, plus a 7-line helper |
| Work-unit resolution | 8 | 319 |
| Successful-merge orchestration | 8 | 207 |
| Recovery and expiry | 3 | 192 |
| Lifecycle, archive facade, and common guards | 14 | 199 |

```text
routes/auth.ts
    |
    v
AuthQueue facade / lifecycle / execution
    |-- AuthMergeChecker --------> queue snapshot + Git
    |
afterSuccessfulMerge (stays visible in AuthQueue)
    |-- AuthMergeChecker --------> post-merge revalidation
    |-- DeferredActionExecutor --> DB + LedgerStore
    |-- MergeWorkUnitResolver ---> DB + Git
    |-- codex-thread-archive.ts --> existing extracted service
    `-- finalization marker

recovery --> queue lookup + resolved payload + broadcast + afterSuccessfulMerge
```

The ordering at `auth-queue.ts:1630` is load-bearing: dismiss duplicates, revalidate queued
requests, apply ledger completion, resolve work units, archive worker threads, then mark the
merge finalized. The decomposition keeps that sequence visible.

### Accepted: `AuthMergeChecker`

Move roughly 399 lines of merge-check methods and exclusive helpers behind a checker that sees
a narrow queued-merge snapshot but never calls back into `AuthQueue`. Wiring and explicit types
add an estimated 35–55 lines, for net repository growth of 25–45 lines. The seam prevents stale
target or queue fingerprints, queue-order simulation errors, and Git infrastructure failures
being classified as merge conflicts. Existing cache, invalidation, conflict, error, and
revalidation tests provide a migration harness.

### Accepted: `DeferredActionExecutor`

Move roughly 271 lines of execution, outcome, and idempotency behavior beside
`src/auth-actions.ts`. Keep staged-action CRUD and overall ledger-completion ordering in the
facade. The new API adds about 25–40 lines, or 20–35 net repository lines. It prevents one failed
action from suppressing later actions, replayed comments/checkpoints, vetoed closes retaining
`resolves` links, stale-digest closes applying unintentionally, and legacy close behavior
diverging from staged actions.

### Accepted: `MergeWorkUnitResolver`

Move the eight-method, 319-line proof-and-update cluster to a DB/Git service returning a typed
resolution summary. Explicit types and wiring add about 30–50 lines, or 25–45 net repository
lines. This prevents cross-repository work-unit resolution, attributing an already-landed
abandoned unit to the wrong request, losing integration-child containment, dropping the auth
request on explicit closure, and archiving the wrong worker task.

Together, these three extractions move about 989 lines and 27 methods out of `AuthQueue` for
70–125 net new lines. The cost is justified by isolating three independently testable proof and
replay engines, not by reducing the facade's line count.

### Rejected AuthQueue extractions

- A recovery service is rejected for now. Its 192 lines call queue lookup, payload construction,
  broadcast, and successful-merge finalization; extraction would create callbacks or a cycle and
  add about 40–70 lines for only three methods.
- A monolithic post-merge finalizer is rejected. The 27-line orchestrator is valuable precisely
  because its ordering is visible.
- Further archive extraction is rejected. Selection already lives in the 456-line
  `codex-thread-archive.ts`; the remaining facade is policy and logging, not duplicated logic.

## 3. Issue-route decomposition

### Current shape

`src/routes/issues.ts` is 2,595 lines. `registerIssueRoutes` spans lines 1222–2580: 1,359 lines
with 32 handlers (15 GET, 15 POST, and two PATCH). A separate 840-line block at lines 315–1154
contains 35 umbrella/head/status helpers. Two of those helpers,
`batchLedgerIssueHeads` and `buildUmbrellaStatus`, are exported and unit-tested as domain APIs,
which is an ownership inversion rather than route-local support.

The handler clusters are:

| Route family | Approximate handler lines | Endpoints |
| --- | ---: | ---: |
| Core list/create/find/detail/projection | 181 | 6 |
| Umbrella, parent role, and heads | 195 | 7 |
| Content and state | 348 | 10 |
| Relationships and conflicts | 151 | 3 |
| Context, resolutions, sessions, and spawn | 479 | 6 |

There are 17 repeated calls to `resolveLedgerIssueId` and 32 calls to `getDb()` inside handlers.
Those counts do not justify a generic handler DSL, but they make shared route context useful.

### Accepted: domain-first route decomposition

```text
issues.ts compatibility facade
    |-- issue-core-routes
    |-- issue-content-routes
    |-- issue-relationship-routes
    |-- issue-umbrella-routes
    `-- issue-context-routes
             |
             +--> shared route context/resolution helpers
             +--> ledger/umbrella-coordination
             +--> existing ledger/store, projection, operational-links
```

First move the 840-line/35-helper block to `ledger/umbrella-coordination.ts`, adding about 15–30
lines of public types or re-exports. Then move handlers into the five route-family registrars,
leaving a 30–50 line compatibility facade that still creates and returns `IssueScanner`. The
route split adds an estimated 70–110 orchestration/import lines. This is a medium-complexity,
roughly two-to-four-day change with no intended schema or HTTP contract change.

The behavioral gate is a route-inventory and order regression test. Mandible's router is
first-match ordered (`src/server.ts:338–349`). Today `POST /api/issues/:repoId` is registered at
line 1650, before `POST /api/issues/resolutions` at line 2102; the generic route therefore
appears to shadow the resolution endpoint despite a nearby comment claiming the opposite.
Other prevented bug classes are file-RPC policy drift, batch/single umbrella digest divergence,
compatibility-merge drift across context/session/auth/work-unit projections, and silent loss of
optional PATCH registration.

### Rejected route abstractions

- One file per endpoint is rejected: about 32 files and 250–400 new import/boilerplate lines
  without behavioral protection.
- A generic resolve/validate/send handler DSL is rejected: 100–180 estimated lines, more opaque
  type and error flow, and little benefit beyond appearance.
- Splitting only the registrar is rejected because it would leave the 840-line umbrella domain
  block owned by an HTTP module.
- Endpoint or response changes during the move are rejected because they would obscure parity
  review with an unrelated API migration.

## 4. Artifact identity seam

### Migration lesson

A prior identity boundary would not have made the canonical migration literally one-file. The
main projection change (`0133f0d`) touched four production files; later authority and cleanup
commits concentrated in `provider-artifacts.ts` but still required `db-migrations.ts`. Preset
attachment columns also represented a real consumer schema transition that no resolver could
hide. A better boundary could plausibly have reduced five unique production files to three by
shielding route/content projections.

The useful lesson is not “all artifact work belongs in one service.” It is that authority
generation, reference interpretation, and compatibility projection should be one typed policy,
while custody, content, associations, presets, drafts, and export remain separate transactional
aggregates.

### Current identity dependencies

The identity/ref core occupies about 733 lines in two regions of `src/provider-artifacts.ts`
(4231–4560 and 6351–6753). The module contains 37 identity/resolution/projection-shaped
functions and five overlapping public resolver entries. `ArtifactResolveResult` is duplicated
in `src/types.ts` and `src/contracts.ts`; it has optional `target_type` and `target_id` fields
rather than resolved variants that guarantee a canonical target.

Fifteen direct getter/resolver calls remain outside the module: six in routes, seven in presets,
and two in issue-detail code. Compatibility policy also leaks through a route fallback
(`target_id ?? artifact.id`), direct canonical-to-legacy joins in Space export, and preset
translation between old and canonical attachment columns.

### Accepted: strict artifact identity-resolution boundary

Create a focused module, not a stateful service class, with:

- discriminated logical-artifact, pinned-version, blob, alias, unresolved, ambiguous, and
  unsupported results;
- explicit modes for strict read-only, surface compatibility, link compatibility, and
  materializing registration;
- mandatory `target_type` and `target_id` for every resolved result;
- canonical-to-compatibility projection helpers, including fail-closed unique-owner lookup for
  shared blobs;
- temporary wrappers preserving existing public resolver names.

Moving 600–700 lines, adding 90–140 lines of variants and wrappers, and removing 120–180 lines
of duplicate dispatch/fallback logic should yield a net production reduction of about 30–90
lines. Add 150–220 focused test lines. The seam prevents read-only requests from materializing
state, compatibility IDs entering canonical links, floating logical refs where a pinned version
is required, arbitrary owner selection for shared blobs, “resolved” results without a target,
and caller-specific precedence drift during the next authority transition.

### Rejected artifact identity abstractions

- One service owning ingest, custody, content, associations, drafts, presets, and export is
  rejected; it would be a 1,500-plus-line aggregate with incompatible transaction boundaries.
- A generation plugin interface is rejected until a third authority exists. It would add
  120–200 speculative lines.
- Moving all artifact SQL into identity is rejected because list, content, association, and
  export queries have distinct performance and transaction needs.
- A single-string canonical artifact ID is rejected because it erases floating logical,
  pinned-version, and immutable-blob semantics.
- A separate project-association layer and CLI-side authority are rejected. The existing
  association target gate is already sound, and the backend must remain authoritative.

## 5. UI list/detail scaffolds

### Current economics

The original “six shell-backed, five hand-rolled” count is stale. The integrated tree has three
direct entity detail types using `DetailPaneShell`: artifact, auth request, and ledger issue.
Conversation, Inbox, Graph, Work, and Logs have different scroll, interaction, or layout models.

Across the five conventional split browsers, outer components contain 70 state hooks and 39
effects; their primary detail components contain another 64 state hooks and 24 effects. The
numbers are large, but most state is domain-specific: artifact versions/content/drafts, auth
execution/readiness/actions, issue caching/scroll/persistence, conversation streaming and
composition, and Inbox polymorphism. Only asynchronous detail-key coherence repeats as one
behavioral contract.

### Accepted: `useKeyedAsyncDetail`

Add a narrow controller for request-key coherence, stale-response rejection, same-key hydration
retention, and key-scoped loading/error state. Selection, URL and persisted state, scroll,
actions, and rendering remain with each view. Initial clients are issue detail, graph-embedded
issue detail, and Space reference loaders.

The current graph loader demonstrates the bug: changing `ledgerIssueId` starts a new request but
retains `ledgerDetail` without checking that it belongs to the new key, so the prior issue can
render under the next selection until loading finishes. Existing issue and artifact loaders
already carry local coherence defenses.

The hook should move 100–150 lines of token/cancellation/loading guards, add 90–120 lines of
hook/types plus 12–18 lines per adapter, and land between 30 fewer and 30 more production lines.
Eight to twelve focused tests should cover late responses, wrong-key retained detail,
same-key refresh, error isolation, and refresh-driven selection/scroll stability.

### Rejected UI scaffolds

- A stateful `EntityBrowser<TList,TDetail>` is rejected. It would add an estimated 120–200 net
  lines and obscure URL, streaming, action, stale-data, and persistence ownership.
- A stateless split-layout wrapper is rejected. Only 60–90 structural lines repeat, while a
  useful API/CSS/test surface costs 85–125 lines and responsive breakpoints genuinely differ.
- A schema-driven Inbox/Graph/Work detail renderer is rejected. It weakens semantic headings,
  focus order, and domain labels for roughly +30 to +100 net lines.
- Forced `DetailPaneShell` adoption is rejected. Conversation, Inbox, Graph, Work, and Logs have
  different scroll owners. `ViewSidebar` and `DetailPaneShell` already centralize the reusable
  keyboard, persistence, resize, header, and scroll contracts.

## 6. Other high-value decomposition seams

### Accepted: ingestion as explicit plan, persistence, and committed outcome

`src/ingestion.ts` is 2,175 lines with 55 top-level functions and one class. `ingestFile` alone
is about 676 lines (1160–1835) and interleaves source disappearance, parser selection, empty
cache, incremental/full choice, hash no-op, delta calculation, compression staging,
transaction/upsert, unique-conflict recovery, append-state refresh, session activity, SSE,
workflow follow-up, and metrics.

```text
ingestion.ts scheduler/watcher
    -> ingest-planner.ts
         ExistingSourceState -> skip | empty | append | full | remove
    -> conversation-persistence.ts
         atomic persist/recover -> committed outcome + append state
    -> ingestion-events.ts
         publish only from committed outcome
```

Move 620–700 lines and add 100–150 lines of discriminated plan/outcome types and orchestration,
for 80–130 net new production lines. This medium-high-complexity change prevents append/full
fallback from deleting valid history, duplicate blocks after rewrites, unique-conflict recovery
from writing different metadata than the normal path, append-state advancement without durable
blocks, SSE for uncommitted data, and divergent missing-source/negative-cache ownership. The
existing 17 ingestion tests are a strong base, but unique-conflict recovery needs a focused test.

### Accepted: graph domain projection outside HTTP registration

`src/routes/graph.ts` is 1,465 lines with 58 top-level functions. Its only route registrar is
about 65 lines at the end; roughly 1,400 lines are graph specification, filtering, database
projection, selection, legends/counts, and metadata. Eight domain exports are imported directly
from the route file by 15 focused graph tests.

```text
graph/spec.ts          query compatibility, presets, normalized GraphSpec
graph/selection.ts     endpoint closure, capping, legends and counts
graph/operational.ts   ledger/session/auth/work-unit projection
routes/graph.ts        request parsing and payload assembly
```

Move 1,300–1,400 lines and add 50–90 lines of contracts/re-exports. The medium-cost change
prevents provider and operational modes from applying different endpoint rules, query aliases
from drifting from normalized specs, counts/legends from describing pre-filter rather than
visible data, dangling edges after capping, and an HTTP module becoming the public domain API.

### Rejected size-driven splits

- `src/ledger/timeline-projection.ts` is 1,504 lines and 55 functions, but it is one cohesive
  projection boundary with 23 focused tests. Splitting loaders, expansion, events, and
  diagnostics would add 60–100 lines and obscure the global-time-axis invariant.
- `SessionManager` is about 1,000 lines, but lifecycle, retention, permissions, streaming,
  persistence, and backend ownership share one live backend map. No clean cut or duplicated
  transition engine was found; method-family splitting would be aesthetic indirection.

## Accepted follow-on work

Duplicate search reused one existing issue and created nine focused issues. Each is linked from
the design-review issue with a deliberate `references` relationship.

| Issue | Accepted proposal | Disposition |
| --- | --- | --- |
| [issue:2322726] | Canonical issue-reference resolver | Reused the open provider-resolution issue and extended its implementation boundary |
| [issue:093cd54] | Canonical/legacy artifact-list filter contract | New focused issue |
| [issue:17d34a0] | `AuthMergeChecker` | New focused issue |
| [issue:4ddefaf] | `DeferredActionExecutor` | New focused issue; related completed behavior is [issue:05966a5] |
| [issue:ba10046] | `MergeWorkUnitResolver` | New focused issue; related completed behavior is [issue:5f95d77] |
| [issue:dd2a266] | Issue coordination and route-family decomposition | New focused issue |
| [issue:020d93d] | Strict artifact identity-resolution boundary | New focused issue |
| [issue:5d5296e] | `useKeyedAsyncDetail` | New focused issue |
| [issue:dd12c79] | Ingestion planner, persistence, and committed outcome | New focused issue |
| [issue:22a54d4] | Graph domain projection outside route registration | New focused issue; deliberately related to [issue:b45f19b] |

## Explicit rejections

The detailed sections reject 18 candidates. The recurring reasons are consistent:

- the shared surface is only vocabulary (`get`, `list`, `resolve`, or “detail”), not semantics;
- the proposed layer would hide transaction, ordering, query-shape, scroll, or authority
  differences;
- splitting would add interfaces and adapters without preventing a demonstrated bug class; or
- the abstraction anticipates a future third implementation that does not exist.

File size and state-hook count are discovery signals, not acceptance criteria. No follow-on
issue should be filed for the generic repository, universal row mapper, handler DSL,
one-file-per-endpoint split, recovery/finalizer/archive wrappers, artifact god service or
generation plugin, generic entity browser, layout/detail renderers, forced shell adoption,
timeline split, or `SessionManager` split.

## Verification and limitations

The six archaeology passes were read-only and independently scoped. The worker session checked
their principal measurements and behavioral claims against the integrated source, including the
first-match route shadow, issue resolver variants, auth finalization order, optional artifact
target fields, canonical/legacy export joins, wrong-key graph detail retention, ingestion
transition boundaries, and graph route/domain ownership inversion.

All line estimates are implementation-planning ranges, not promises of deletion. They exclude
test additions unless explicitly stated. No production code was changed, and this review does
not authorize contract, schema, or user-visible behavior changes beyond the named acceptance
criteria in the follow-on issues.

---

Co-Authored-By: Codex (GPT-5) <codex@openai.com>
