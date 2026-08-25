import { mandibleVitestConfig } from './vitest.config';

/**
 * Everything not on the default gate's whitelist: green, run on demand.
 * See test/extended/README.md.
 */
export default mandibleVitestConfig(['test/extended/*.test.{ts,tsx}']);
