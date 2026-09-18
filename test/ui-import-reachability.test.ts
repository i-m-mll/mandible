// Guard for issue 048c7e2: the UI ships from one esbuild entry
// (`ui/src/app.tsx`), so a module that falls off that import graph is dead
// weight. Its JS is tree-shaken away, but any CSS it owns keeps shipping in the
// eager `app.css` — that is how ~4,350 lines of unreachable modules and a
// 1,542-line dead stylesheet accumulated unnoticed.
//
// This test walks static imports, re-exports and literal dynamic `import()`
// calls from the entry and fails on anything under `ui/src/` it never reaches.
// Deliberate exceptions live in `ALLOWED_UNREACHABLE` in the walker, each with
// a reason.

import { describe, expect, it } from 'vitest';

import { computeReachability } from '../scripts/ui-reachability.mjs';

describe('ui import-graph reachability', () => {
  it('reaches every module under ui/src from the app entry', () => {
    const report = computeReachability();

    expect(report.entry).toBe('ui/src/app.tsx');
    // Fail with the offending paths rather than a bare count.
    expect(report.unreachable).toEqual([]);
  });

  it('still walks a meaningful share of the tree (walker did not silently break)', () => {
    const report = computeReachability();

    expect(report.totalCount).toBeGreaterThan(100);
    expect(report.reachedCount).toBeGreaterThan(report.totalCount * 0.9);
  });
});
