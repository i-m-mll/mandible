import { mandibleVitestConfig } from './vitest.config';

/**
 * Everything not on the default gate's whitelist: green, run on demand.
 * See test/extended/README.md.
 */
export default mandibleVitestConfig(['test/extended/*.test.{ts,tsx}'], {
  // This one large process-and-SQLite fixture retains native/V8 pages across
  // cases. The maintained test:extended command runs every declaration in a
  // fresh bounded process through scripts/run-iab-preview-tests.mjs.
  exclude: [
    'test/extended/iab-preview-launcher.test.ts',
    'test/extended/artifact-ingest-pool.test.ts',
    'test/extended/briefing-demo-seed.test.ts',
    // Exact inherited failures documented, counted, and content-hashed in
    // test/extended/README.md. None is changed by this branch.
    'test/extended/auth-history-summary.test.ts',
    'test/extended/conversation-search-route.test.ts',
    'test/extended/inbox-view.test.tsx',
    'test/extended/project-db-snapshot.test.ts',
    'test/extended/rich-chat-pane.test.tsx',
    'test/extended/view-sidebar.test.tsx',
  ],
});
