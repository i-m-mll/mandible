import { defineConfig } from 'vitest/config';

/**
 * The one Vitest configuration. A suite is a directory; `MANDIBLE_TEST_SUITE`
 * selects which, and the gate is the default. Single stars on purpose: a file
 * belongs to exactly one suite by where it lives. See test/README.md.
 */
const SUITES = {
  gate: 'test/*.test.{ts,tsx}',
  provisioned: 'test/provisioned/*.test.{ts,tsx}',
  quarantine: 'test/quarantine/*.test.{ts,tsx}',
} as const;

type Suite = keyof typeof SUITES;

function selectedSuite(): Suite {
  const requested = process.env.MANDIBLE_TEST_SUITE ?? 'gate';
  if (!(requested in SUITES)) {
    throw new Error(`MANDIBLE_TEST_SUITE=${requested} is not one of ${Object.keys(SUITES).join(', ')}`);
  }
  return requested as Suite;
}

const suite = selectedSuite();

export default defineConfig({
  test: {
    include: [SUITES[suite]],
    // jsdom remains the default. Files that touch no DOM opt into `node` with
    // an `@vitest-environment node` docblock (issue 9e40a31).
    environment: 'jsdom',
    // Hang guards, not speed checks: the timing reporter owns speed, and tests
    // await state through test/helpers/wait-until.ts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Constrain the actual Bun forks, not only the Vitest parent process.
    execArgv: ['--smol'],
    fileParallelism: true,
    // Issue c4f456c: unconditional per-test reset of the src/db.ts singleton.
    setupFiles: ['./test/helpers/runtime-isolation.ts', './test/helpers/db-reset-backstop.ts'],
    reporters: ['default', ['./test/helpers/timing-reporter.ts', { timing: suite === 'gate' }]],
    // No global line threshold: a coverage floor rewards tests wherever they
    // are cheapest to reach, which test/README.md exists to resist.
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
