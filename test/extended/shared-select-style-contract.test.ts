import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const localStylePaths = [
  'ui/src/styles/auth-hooks.css',
  'ui/src/styles/auth.css',
  'ui/src/styles/chat-history.css',
  'ui/src/styles/console.css',
  'ui/src/styles/conversations.css',
  'ui/src/styles/detail-pane-shell.css',
  'ui/src/styles/graph.css',
  'ui/src/styles/issues.css',
  'ui/src/styles/settings.css',
  'ui/src/styles/sidebar-search-filter.css',
  'ui/src/styles/timeline.css',
  'ui/src/styles/work.css',
  'ui/src/views/spaces/SpaceCanvas.css',
  'ui/src/views/spaces/SpacesSidebar.css',
];

const nativeSelectClass = /(?:\.settings-view__select(?:--compact)?|\.conv-sort|\.conv-compose__model|\.work-sort|\.repo-card__sort|\.work-compare-tray__mode|\.session-controls__select(?:--compact)?|\.spaces-tree__chooser-select)(?![-\w])/;
const forbiddenVisualDeclaration = /(?:^|;)\s*(?:appearance|background(?:-[\w-]+)?|border(?:-[\w-]+)?|color|cursor|font(?:-[\w-]+)?|letter-spacing|opacity|outline(?:-[\w-]+)?|padding(?:-[\w-]+)?|text-transform)\s*:/m;

describe('shared native select visual contract', () => {
  it('is imported once from the app stylesheet before contextual view rules', () => {
    const appStyles = read('ui/src/style.css');
    expect(appStyles.match(/@import "\.\/styles\/select\.css";/g)).toHaveLength(1);
    expect(appStyles.indexOf('@import "./styles/select.css";')).toBeGreaterThan(
      appStyles.indexOf('@import "./styles/base.css";'),
    );
    expect(appStyles.indexOf('@import "./styles/select.css";')).toBeLessThan(
      appStyles.indexOf('@import "./styles/timeline.css";'),
    );
  });

  it('owns theme-aware visuals, focus, disabled state, and the inset caret', () => {
    const css = read('ui/src/styles/select.css');
    expect(css).toMatch(/select\s*\{[^}]*border:\s*1px solid var\(--neutral-alpha-10\);[^}]*background-color:\s*var\(--bg-card\);[^}]*color:\s*var\(--text-primary\);[^}]*font:\s*13px\/1\.2 var\(--font-sans\);/s);
    expect(css).toMatch(/select:not\(\[multiple\]\)\s*\{[^}]*appearance:\s*none;[^}]*padding:\s*0 38px 0 10px;[^}]*var\(--text-muted\)[^}]*calc\(100% - 21px\)[^}]*calc\(100% - 17px\)/s);
    expect(css).toMatch(/select:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent-blue\);/s);
    expect(css).toMatch(/select:disabled\s*\{[^}]*cursor:\s*not-allowed;[^}]*opacity:\s*0\.55;/s);
  });

  it('leaves only contextual size and layout authority near consumers', () => {
    const violations: string[] = [];
    for (const path of localStylePaths) {
      const css = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = match[1]?.trim() ?? '';
        const declarations = match[2] ?? '';
        const targetsNativeSelect = /(^|[\s,>+~])select(?=$|[\s,:.#[>+~])/.test(selector)
          || nativeSelectClass.test(selector)
          || /select\.(?:new-session-dialog__input|space-canvas__input)/.test(selector);
        if (targetsNativeSelect && forbiddenVisualDeclaration.test(declarations)) {
          violations.push(`${path}: ${selector}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
