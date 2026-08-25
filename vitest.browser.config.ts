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
export default mandibleVitestConfig(['test/browser/*.test.{ts,tsx}']);
