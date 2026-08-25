import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { appColors } from '../ui/src/theme';

const styleCss = readFileSync('ui/src/style.css', 'utf8');
const tokensCss = readFileSync('ui/src/styles/tokens.css', 'utf8');

const legacyRootTokens = [
  '--bg-primary',
  '--bg-secondary',
  '--bg-card',
  '--text-primary',
  '--text-muted',
  '--text-secondary',
  '--fg-default',
  '--fg-muted',
  '--fg-subtle',
  '--fg-inverse',
  '--text-on-accent',
  '--text-primary-soft',
  '--text-primary-muted',
  '--text-primary-subtle',
  '--accent-green',
  '--accent-yellow',
  '--accent-red',
  '--accent-blue',
  '--accent-purple',
  '--accent',
  '--accent-soft',
  '--status-success',
  '--status-warning',
  '--status-danger',
  '--status-info',
  '--status-purple',
  '--status-neutral',
  '--status-success-bg',
  '--status-success-bg-strong',
  '--status-success-border',
  '--status-warning-bg',
  '--status-warning-bg-soft',
  '--status-warning-border',
  '--status-warning-border-soft',
  '--status-danger-bg',
  '--status-danger-bg-soft',
  '--status-danger-border',
  '--status-danger-border-soft',
  '--status-info-bg',
  '--status-info-bg-soft',
  '--status-info-border',
  '--status-purple-bg',
  '--status-purple-border',
  '--inbox-continuation',
  '--inbox-continuation-bg',
  '--inbox-handoff',
  '--inbox-handoff-bg',
  '--inbox-issue',
  '--inbox-issue-bg',
  '--auth-result-completed',
  '--auth-result-completed-bg',
  '--auth-result-problem',
  '--auth-result-problem-bg',
  '--auth-result-neutral',
  '--auth-result-neutral-bg',
  '--bg-page',
  '--bg-surface',
  '--bg-panel',
  '--issues-detail-bg',
  '--surface-app',
  '--surface-app-glow',
  '--surface-header',
  '--surface-rail',
  '--surface-sidebar',
  '--surface-toolbar',
  '--surface-popover',
  '--surface-content',
  '--surface-code',
  '--scrim-modal',
  '--bg-inset',
  '--bg-muted',
  '--bg-hover',
  '--bg-active',
  '--bg-overlay',
  '--overlay-hover',
  '--overlay-active',
  '--overlay-selected',
  '--overlay-muted',
  '--neutral-alpha-01',
  '--neutral-alpha-02',
  '--neutral-alpha-025',
  '--neutral-alpha-03',
  '--neutral-alpha-035',
  '--neutral-alpha-04',
  '--neutral-alpha-045',
  '--neutral-alpha-05',
  '--neutral-alpha-055',
  '--neutral-alpha-06',
  '--neutral-alpha-07',
  '--neutral-alpha-08',
  '--neutral-alpha-10',
  '--neutral-alpha-12',
  '--neutral-alpha-15',
  '--neutral-alpha-16',
  '--neutral-alpha-18',
  '--neutral-alpha-20',
  '--border',
  '--border-color',
  '--border-subtle',
  '--border-muted',
  '--border-faint',
  '--border-strong',
  '--border-active',
  '--focus-ring',
  '--terminal-bg',
  '--terminal-fg',
  '--terminal-cursor',
  '--graph-node-muted',
  '--graph-node-muted-strong',
  '--graph-node-default',
  '--graph-node-default-muted',
  '--graph-label',
  '--graph-selection-stroke',
  '--graph-node-stroke',
  '--graph-edge-session',
  '--graph-edge-umbrella',
  '--graph-edge-auth',
  '--graph-edge-parent',
  '--graph-edge-muted',
  '--graph-arrow',
  '--graph-background-grid',
  '--graph-minimap-mask',
  '--font-sans',
  '--font-mono',
  '--shadow-soft',
  '--shadow-header',
  '--shadow-chrome',
  '--shadow-rail',
  '--shadow-panel-top',
  '--shadow-content-top',
] as const;

const requiredV2Tokens = [
  '--neutral-1',
  '--neutral-12',
  '--blue-fg',
  '--green-fg',
  '--red-fg',
  '--amber-fg',
  '--purple-fg',
  '--space-1',
  '--space-8',
  '--text-xs',
  '--text-xl',
  '--leading',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--surface-app',
  '--surface-panel',
  '--surface-card',
  '--surface-raised',
  '--text-disabled',
  '--border-default',
  '--border-focus',
  '--accent-fg',
  '--accent-bg',
  '--status-info-fg',
  '--status-success-fg',
  '--status-warning-fg',
  '--status-danger-fg',
  '--diff-added-fg',
  '--diff-removed-bg',
  '--diff-modified-bg',
  '--chat-max-width',
];

function declaredTokens(css: string): Set<string> {
  return new Set(Array.from(css.matchAll(/(--[\w-]+)\s*:/g), (match) => match[1]));
}

function collectCssFiles(paths: string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    if (stat.isFile() && path.endsWith('.css')) {
      files.push(path);
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(path)) {
      files.push(...collectCssFiles([join(path, entry)]));
    }
  }
  return files;
}

describe('design token stylesheet', () => {
  it('imports tokens before the rest of the application stylesheet', () => {
    expect(styleCss.startsWith('@import "./styles/tokens.css";')).toBe(true);
    expect(styleCss).not.toMatch(/\n:root\s*\{\s*--bg-primary:/);
  });

  it('declares the v2 primitive, semantic, and component token contract', () => {
    const tokens = declaredTokens(tokensCss);
    expect(requiredV2Tokens.filter((token) => !tokens.has(token))).toEqual([]);
    expect(tokensCss).toContain('/* Tier 1: primitives */');
    expect(tokensCss).toContain('/* Tier 2: semantic tokens */');
    expect(tokensCss).toContain('/* Tier 3: component tokens */');
    expect(tokensCss).toContain('/* DEPRECATED ALIASES');
  });

  it('keeps every legacy root token resolvable', () => {
    const tokens = declaredTokens(tokensCss);
    expect(legacyRootTokens).toHaveLength(130);
    expect(legacyRootTokens.filter((token) => !tokens.has(token))).toEqual([]);
  });

  it('keeps light theme remapping centralized in tokens.css', () => {
    const lightRemapBlocks = tokensCss.match(/\[data-theme=['"]light['"]\]\s*\{/g) ?? [];
    expect(lightRemapBlocks).toHaveLength(1);
  });

  it('keeps theme.ts appColors in sync with tokens.css declarations', () => {
    const tokens = declaredTokens(tokensCss);
    const missing = Object.entries(appColors)
      .map(([key, value]) => {
        const token = value.match(/^var\((--[\w-]+)\)$/)?.[1];
        return token && !tokens.has(token) ? { key, token } : null;
      })
      .filter(Boolean);

    expect(missing).toEqual([]);
  });
});

describe('chat surface CSS token guards', () => {
  const chatCssFiles = collectCssFiles([
    'ui/src/components/message-blocks',
    'ui/src/components/console',
    'ui/src/views/conversations.css',
    'ui/src/views/console.css',
  ]);

  it('does not add chat-surface light-theme overrides outside tokens.css', () => {
    const offenders = chatCssFiles.filter((file) => readFileSync(file, 'utf8').includes('data-theme'));
    expect(offenders).toEqual([]);
  });

  it('does not add raw hex colors to chat-surface CSS files', () => {
    const offenders = chatCssFiles.flatMap((file) => {
      const matches = Array.from(readFileSync(file, 'utf8').matchAll(/#[0-9a-fA-F]{3,8}\b/g));
      return matches.map((match) => ({ file, color: match[0] }));
    });

    expect(offenders).toEqual([]);
  });
});
