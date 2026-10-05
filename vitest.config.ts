import { defineConfig } from 'vitest/config';

export interface MandibleSuiteOptions {
  /**
   * Publish and enforce the timing contract (issue 9e40a31). Only the default
   * gate has a wall-clock budget worth defending; the on-demand suites are
   * allowed to be slow.
   */
  timingContract?: boolean;
  exclude?: string[];
}

/**
 * One canonical Vitest configuration for every Mandible suite; the include
 * globs are the only thing a suite chooses.
 */
export function mandibleVitestConfig(include: string[], options: MandibleSuiteOptions = {}) {
  return defineConfig({
    test: {
      include,
      ...(options.exclude ? { exclude: options.exclude } : {}),
      // jsdom remains the default. The auth-queue files opt into `node`
      // locally with an `@vitest-environment node` docblock (issue 9e40a31):
      // they touch no DOM, and building one per fork is pure cost. Flipping the
      // global default would put 73 files on an environment none of them were
      // written against, for a saving that was never measured.
      environment: 'jsdom',
      // Both stated explicitly rather than relied on as defaults: the gate's
      // whole shape depends on files running in parallel isolated forks, and a
      // silent upstream default change would be a silent regression.
      pool: 'forks',
      // Constrain the actual Bun forks, not only the Vitest parent process.
      execArgv: ['--smol'],
      fileParallelism: true,
      // Issue c4f456c: unconditional per-test reset of the src/db.ts singleton.
      setupFiles: ['./test/helpers/runtime-isolation.ts', './test/helpers/db-reset-backstop.ts'],
      ...(options.timingContract
        ? { reporters: ['default', './test/helpers/timing-reporter.ts'] }
        : {}),
      // No global line threshold on purpose: a coverage floor rewards adding
      // tests wherever they are cheapest to reach, which is the pressure the
      // whitelist in test/README.md exists to resist.
      coverage: {
        provider: 'v8',
      },
      server: {
        deps: {
          inline: ['@tanstack/react-virtual', 'agentation'],
        },
      },
    },
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'preact',
    },
    resolve: {
      alias: {
        react: 'preact/compat',
        'react-dom': 'preact/compat',
        'react/jsx-runtime': 'preact/jsx-runtime',
      },
    },
  });
}

// Single star on purpose: the default suite is exactly the flat `test/`
// directory. A `**` would keep subdirectories in the run, so moving a test out
// of `npm test` would not actually move it. With a single star, any suite that
// needs provisioning this runner cannot assume — a real browser, ImageMagick —
// is excluded simply by living in `test/<suite>/`. See test/browser/README.md.
export default mandibleVitestConfig(['test/*.test.{ts,tsx}'], { timingContract: true });
