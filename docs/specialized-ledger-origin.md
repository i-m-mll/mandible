# Specialized ledger mutation origin

`request_origin` is the normalized native provider/session claim captured at request ingress. It does not grant authority and does not replace the authenticated author, approval credential, executing actor, or work-unit worker binding. Historical missing origins remain null. No daemon environment is consulted.

## Mutation coverage

| Authoritative mutation entry points | Persisted origin and read boundary |
| --- | --- |
| `provider-artifacts.ts`: `ensureArtifactSeries`, `appendArtifactVersion`, `commitArtifactVersion`, `commitArtifactVersionBatch` | Logical artifact, immutable blob and version `metadata.request_origin`; established artifact reads expose metadata. Blob reuse retains its initial metadata. Version identity/evidence excludes the reserved provenance key, preserving duplicate detection across sessions. |
| `provider-artifacts.ts`: `registerArtifactLink`, `associateProjectArtifact`, `saveArtifactDraft`, `deleteArtifactDraft`, draft rebase/publication | Current metadata plus canonical `ledger_events` for changed links, project associations and draft state. Event records contain target identity, operation and changed field names, without copying content. Rebase/publication reuse these boundaries. |
| `artifact-source.ts`: `commitArtifactSourceMove` | Existing immutable `artifact_source_move.request_origin_json`, inserted in the source-move transaction. |
| `feedback/briefings.ts`: recurring publication, publication from an artifact version, published-report rounds | Existing Briefing creation, round, creation override and run receipt rows gain nullable `request_origin_json`. Definitions/instances and frozen membership rows derive from their authoritative round/run/submission rather than duplicate provenance. Briefing detail and round reads expose normalized `request_origin`. |
| `feedback/briefings.ts`: title, description, archive/restore | Canonical `ledger_events`, transactionally with the mutation; creation origin remains unchanged. |
| `feedback/briefings.ts`: answers, annotations, submissions | Existing immutable response, annotation and submission events gain `request_origin_json`; retractions retain their own origin. Submission membership points to its original response/annotation events. |
| `feedback/briefing-bundles.ts`: creation, name, layout/member changes, empty deletion | Creation row origin and canonical mutation events for mutable state. Bundle reads expose creation origin. |
| `feedback/briefing-groups.ts`: creation, configuration, update insertion/removal, archive/restore, name, destination binding | Creation/update rows retain origin; canonical events cover mutable group state. Existing merge dispositions and human review dispositions retain their own immutable origin; group/history reads expose it. |
| `feedback/briefing-composer.ts`, `briefing-report-destinations.ts`, `briefing-placement.ts` | Existing composition runs/contributions/targets/report-publication receipts, destination mutation receipts and explicit placement override receipts retain origin. Route/template/policy reconciliation records canonical route mutation events; publication reuses artifact/Briefing boundaries. |
| `auth-lifecycle.ts`: `appendAuthLifecycleEvent` | Existing immutable lifecycle revisions retain `request_origin_json`, projected as `request_origin` by lifecycle reads. Direct requests retain their request origin; system transitions use the durable submitted origin and keep the actual executor actor/evidence/authority path. |
| `auth-actions.ts`: staged actions | `auth_request_actions.request_origin_json` captures each action's initiating origin. Auth snapshots include non-null origin, while omitting historical null values to preserve prior hashes. Action reads expose origin; application restores that saved origin after restart. |
| `auth-queue.ts`: queued execution, ledger completion, withheld closure recovery | Restores initiating origin from the submitted lifecycle revision. Deferred actions re-enter each persisted action's own origin; the executor/authorizer attribution remains independently recorded. No native identity is inferred from the daemon or shared principal. |
| `routes/work-units.ts`: claim, activate, patch, release, batch release, initial custody | Canonical work-unit events capture successful field changes in the same transaction. Existing immutable custody receipts gain `request_origin_json`. Worker identity and archive behavior are unchanged. |
| `work-unit-custody.ts`: custody transfer | Existing immutable custody event plus canonical work-unit mutation event. |
| `work-unit-reconciler.ts`, `registry.ts`, `auth-queue.ts`, `ledger/operational-links.ts` | Canonical events cover assignment clearing, branch-backed state changes, continuation transfer, merge resolution and first canonical issue linking. The ancestry scan's retirement timestamp is derived housekeeping, not an authored ledger mutation. |

Common issue/comment/revision/relationship mutation persistence belongs to the shared origin contract in `request-origin.md`. Spaces authoring, conversation annotations, project/access registry and reminder history have separate coverage lanes. Provider ingestion, graph/index projections, schema recovery/backfill, runtime telemetry and view preferences are derived or operational state, not authored ledger mutations.

## Transaction and attribution contract

`mutateLedgerRecord` compares explicit before/after snapshots, records an event only for changed fields, and uses `db.afterCommit` to publish after the outer transaction commits. Savepoint and outer rollback discard queued notifications. Snapshots are used only to detect changes; event payloads retain identity, operation and field names, not document content or credential material.

`withLedgerMutationActor` carries already resolved attribution to nested helpers. The store validates and freezes the event actor before mutation so an authorized self-retirement can commit its history; subsequent writes attributed to that retired user still fail. This history mechanism grants no mutation permission. Entities without an owning project use the existing unscoped event stream rather than a synthetic project.

Migration 219 adds nullable columns to existing authoritative rows and the managed-session lookup index. It does not backfill provider sessions or create an audit store. Fixtures cover two simultaneous native sessions, unknown/human origin, preserved artifact identity, rollback, self-retirement, work-unit writes without worker auto-binding, system executor separation, and interrupted queued closure recovery through both startup and idle sweeps.

Co-Authored-By: Codex (GPT) <codex@openai.com>
