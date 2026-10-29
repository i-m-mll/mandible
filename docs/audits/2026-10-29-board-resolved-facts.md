# Board resolved facts

Issue: [issue:3a82d98], implementation contract [issue:3a82d98#2].
Branch: `feature/3a82d98-board-facts`, based on reviewed `d4cd46f`.

## Audit and repair

- Board's serial resolve-once effect recorded attempted item IDs before reads
  succeeded. Packet replacement could discard completed results permanently;
  issue, label and work-unit changes never refreshed those stored facts.
  Distinct ref/context identities now have one Query owner, shared across
  duplicate items and observers. Packet membership drives observers; facts
  never write authored titles, placement, metadata, or occurrence state.
- Board and Collection shared the same unsupported ordinary issue URI behavior.
  Their shared formatter now produces `issue:<ref_id>` while preserving an
  explicit `ref_uri`. Context comes from the containing Space. The lightweight
  resolver reuses active-label reads and effective work-unit-derived status.
- Canonical issue IDs reuse the 60-second freshness policy. Short refs require
  a successful read during the current activation before displaying cached
  identity facts. Identity-changing events recheck short refs that can become
  ambiguous, including formerly resolved aliases. Missing/ambiguous responses
  replace prior facts authoritatively; transport errors retain verified facts
  and expose a retry action without automatic retries.
- QueryClient-scoped transport admission permits four concurrent resolver reads.
  Cancellation reaches queued admission and fetch. The extracted shared read
  deadline begins after admission. `p-queue` is pinned to 9.0.1; version 10's
  native EventTarget integration failed under the existing jsdom runtime.
- Source invalidation targets canonical/requested identities. Identity-less
  work-unit envelopes invalidate the facts family. Ordinary Space movement,
  heartbeats, auth output and unrelated session events do not refresh facts.
  The shared projection scheduler dispatches eligible keys independently of
  slow cohort members while retaining per-key trailing reconciliation.
- Selection, collapse, filter, rename/filter drafts and scroll remain browser
  local. Mounted Space switches use the current persistence key. Source title
  updates do not replace an unfinished rename. Filter token and chip updates
  are functional, so clearing a submitted token cannot discard its new chip.
  Column scroll restoration remains pending while delayed content clamps the
  scroll range, and user scrolling ends that pending restoration.

## Verification

Pinned Bun, worktree-owned frozen dependencies, then:

- 12 focused files / 112 tests passed: Board model/view, issue Query lifecycle,
  real work-unit/resolver integration, Space packet/Collection, resolver refs,
  resource invalidation, shared projection lifecycle, and API cache.
- `bun run typecheck` and `bun run check` passed.
- `git diff --check` passed; no tracked or newly generated `dist`/`ui/dist` files.

The behavior tests include actual no-override Board/Collection refs against a
private migrated resolver; project-context ambiguity; live status/kind/label
projection and explicit placement; pending-read replacement and retargeting;
cold/background failures and retry; real work-unit claim/resolve/release
emissions; transport concurrency/cancellation/deadlines; independent healthy-key
refresh during a stalled cohort; and mounted/remounted intent with clamped
cold-scroll semantics. Existing consecutive metadata edits remain covered.
No issue-detail request is used for Board facts.

## Delivery boundary

The coordinator owns the stable combined full default gate, build, auth request
and exact-candidate runtime acceptance. This worker has not run or substituted
for those gates. Relationship predicates and full issue-detail enrichment remain
outside this finite repair, as specified in [issue:3a82d98#2]. No instruction or
workflow-policy change is required.

Co-Authored-By: Codex (GPT) <codex@openai.com>
