import { mandibleVitestConfig } from './vitest.config';

/**
 * The maintained per-declaration runner uses fresh thread-pool processes for
 * the large IAB launcher fixture. See test/extended/README.md.
 */
export default mandibleVitestConfig(['test/extended/iab-preview-launcher.test.ts']);
