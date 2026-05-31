# Compatibility-Preserving Cleanup Audit

## Scope

Use the `/unfuck` audit categories for the whole repo, with `/unfrack` preservation for the external surfaces inventoried in `external-surface.md`.

## Findings

1. Route helpers are duplicated across route modules.
   - Evidence: repeated `sendJson`, `readBody`, `getParam`, and query parsing helpers in `src/routes/*.ts`.
   - Risk: response behavior can drift and `any`-typed route shims hide internal type regressions.
   - Batch: consolidate internal-only route helpers while preserving HTTP paths, payloads, and status codes.

2. Several large route/UI files exceed the digestibility target.
   - Evidence: `ui/src/views/conversations.tsx`, `src/provider-artifacts.ts`, `ui/src/views/auth.tsx`, `src/db.ts`, `ui/src/api.ts`, and others are above 1,000 lines.
   - Risk: future feature work keeps adding local helpers and state branches instead of moving concepts to home modules.
   - Batch: defer broad file splits unless a touched behavior requires it; splitting these files safely needs route/view-specific contract tests.

3. Tests contain weak existence assertions.
   - Evidence: scan found multiple `toBeTruthy`, `toBeDefined`, and `not.toBeNull` assertions in UI, registry, auth queue, channel server, ledger, and work tests.
   - Risk: some tests pass without checking the behavior users care about.
   - Batch: tighten assertions only when touching the covered surface.

4. Daemon startup discovery blocked health readiness on busy machines.
   - Evidence: baseline `npm test` reached 386/387 passing; `test/core.test.ts` failed waiting for auto-start health once.
   - Risk: full-suite signal was noisy because daemon auto-start could race with local process/session discovery.
   - Batch: defer startup discovery until after the daemon is healthy and clear the timer during shutdown.

5. Generated build artifacts remain intentionally untracked.
   - Evidence: `git ls-files dist ui/dist` returned `0`.
   - Risk: committing generated artifacts would reintroduce merge noise.
   - Batch: keep `dist` and `ui/dist` out of commits; build only for verification.

## Batch Plan

1. Consolidate internal route helpers in a shared module and migrate a small first slice.
2. Run typecheck and targeted tests for the migrated route slice.
3. Fix daemon startup discovery timing without changing health, registry, or discovery contracts.
4. Reassess remaining duplicate helper clusters and either migrate low-risk modules or defer with evidence.
5. Run final cloc, full verification as practical, commit, and submit one protected-branch auth request.

## Verification

- `npm run build:server`
- `npm test -- test/core.test.ts`
- `npm test` (31 files, 387 tests)
- `cloc` before: 293 files, 102561 code lines
- `cloc` after: 293 files, 102496 code lines
