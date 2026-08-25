import { mandibleVitestConfig } from './vitest.config';

/**
 * Failing assertions extracted from gated files, each backed by an open issue.
 * This suite is expected to fail. See test/quarantine/README.md.
 */
export default mandibleVitestConfig(['test/quarantine/*.test.{ts,tsx}']);
