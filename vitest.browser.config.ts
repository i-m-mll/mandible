import { mandibleVitestConfig } from './vitest.config';

/**
 * Extended browser gate: `npm run test:browser`.
 *
 * These tests launch a real headless Chromium — and, for the chrome-edge pixel
 * gate, ImageMagick `magick` — and throw when those binaries are absent. That
 * is correct for a gate invoked deliberately on a provisioned machine and
 * wrong for the default suite, which must be green after nothing but
 * `npm ci`. See test/browser/README.md.
 */
const config = mandibleVitestConfig(['test/browser/*.test.{ts,tsx}']);
// Each file launches native Chromium processes. Concurrent files contend for
// startup resources and turn geometry checks into machine-load timeout tests.
config.test = { ...config.test, fileParallelism: false, testTimeout: 30_000 };
export default config;
