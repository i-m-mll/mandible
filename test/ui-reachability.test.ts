import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { computeReachability } from '../scripts/ui-reachability.mjs';
import { testRuntimeRoot } from './helpers/runtime-isolation.js';

it('follows side-effect styles before from-imports through lazy component dependencies', () => {
  const repoRoot = mkdtempSync(path.join(testRuntimeRoot, 'ui-reachability-'));
  const ui = path.join(repoRoot, 'ui', 'src');
  mkdirSync(ui, { recursive: true });
  const files = {
    'app.tsx': `
      import './app.css';
      import { Canvas } from './Canvas';
      export { token } from './exports';
      import('./lazy');
      require('./legacy');
      // import './ghost';
    `,
    'Canvas.tsx': `import './Canvas.css'; import { token } from './exports'; export const Canvas = token;`,
    'app.css': `@import './tokens.css';`,
    'Canvas.css': `.canvas { display: flex; }`,
    'tokens.css': `:root { --canvas-color: red; }`,
    'exports.ts': `export const token = 1;`,
    'lazy.ts': `export const lazy = true;`,
    'legacy.js': `module.exports = {};`,
    'ghost.ts': `export const ghost = true;`,
  };
  for (const [name, source] of Object.entries(files)) writeFileSync(path.join(ui, name), source);
  expect(computeReachability({ repoRoot }).unreachable).toEqual(['ui/src/ghost.ts']);
});
