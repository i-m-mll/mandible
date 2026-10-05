import { mandibleVitestConfig } from './vitest.config';

export default mandibleVitestConfig(['test/extended/*.test.{ts,tsx}'], {
  // The maintained runner executes launcher declarations in isolated processes.
  exclude: ['test/extended/iab-preview-launcher.test.ts'],
});
