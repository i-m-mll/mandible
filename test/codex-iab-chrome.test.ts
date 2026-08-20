import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { readResolvedStylesheet } from './helpers/css-manifest';

const stylesheet = readResolvedStylesheet();
const appSource = readFileSync('ui/src/app.tsx', 'utf8');
const bindingSource = readFileSync('ui/src/agent-page-binding.ts', 'utf8');

describe('optional left chrome edge contract', () => {
  it('is explicit user control with no host-detection path', () => {
    expect(appSource).toContain("${leftShadowEnabled ? ' app-shell--left-shadow' : ''}");
    expect(appSource).toContain('agentPageBinding !== null ? (');
    expect(appSource).toContain('aria-pressed={leftShadowEnabled}');
    expect(appSource).toContain('setLeftShadowEnabled((enabled) => !enabled)');
    expect(`${appSource}\n${bindingSource}`).not.toMatch(/modelContext|codexGetTools|detectCodexIab/);
  });

  it('derives a paint-width boundary column without a second gutter or width literal', () => {
    expect(stylesheet).toMatch(/--app-shadow-gutter-width:\s*0px;/);
    expect(stylesheet).toMatch(/--app-boundary-shadow-paint-width:\s*17px;/);
    expect(stylesheet).not.toMatch(/--(?:codex-iab|left-shadow)-edge-width:/);
    expect(stylesheet).toMatch(/\.app-shell\s*\{[^}]*--app-left-boundary-width:\s*0px;/s);
    expect(stylesheet).toMatch(/\.app-shell--left-shadow\s*\{[^}]*--app-left-boundary-width:\s*var\(--app-boundary-shadow-paint-width\);/s);
    expect(stylesheet).not.toMatch(/--app-left-boundary-width:\s*17px;/);
    expect(stylesheet).toMatch(
      /\.app-shell--left-shadow::before\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0 auto 0 0;[^}]*width:\s*var\(--app-boundary-shadow-paint-width\);/s,
    );
    expect(stylesheet).toMatch(/\.app-rail\s*\{[^}]*margin-left:\s*var\(--app-left-boundary-width\);/s);
    expect(stylesheet).not.toMatch(/\.app-shell--left-shadow::before\s*\{[^}]*border-inline-(?:start|end):/s);
  });

  it('mirrors one scaled shadow profile while keeping divider paint right-only', () => {
    expect(stylesheet).toMatch(/--app-boundary-shadow-offset:\s*8px;/);
    expect(stylesheet).toMatch(/--app-boundary-shadow-blur:\s*36px;/);
    expect(stylesheet).toMatch(/--app-boundary-shadow-spread:\s*0px;/);
    expect(stylesheet).toMatch(/--app-boundary-shadow-intensity-scale:\s*0\.7;/);
    expect(stylesheet).toMatch(/--app-boundary-shadow-paint-width:\s*17px;/);
    expect(stylesheet).toMatch(/transparent 0%,[^;]*24%,[^;]*59%,[^;]*100%/s);
    expect(stylesheet).toMatch(
      /:where\(\.app-shell\)::after,\s*:where\(\.app-shell--left-shadow\)::before\s*\{[^}]*--shadow-app-subdivision-paint:/s,
    );
    expect(stylesheet).toMatch(/\.app-shell::after\s*\{[^}]*--app-boundary-shadow-direction:\s*to right;[^}]*--app-boundary-divider-paint:\s*linear-gradient\(var\(--app-boundary-accent\), var\(--app-boundary-accent\)\);[^}]*background-image:\s*var\(--app-boundary-divider-paint\),\s*var\(--shadow-app-subdivision-paint\);/s);
    expect(stylesheet).toMatch(/\.app-shell--left-shadow::before\s*\{[^}]*--app-boundary-shadow-direction:\s*to left;[^}]*background-image:\s*var\(--shadow-app-subdivision-paint\);/s);
    expect(stylesheet.match(/--app-boundary-divider-paint:/g)).toHaveLength(1);
    expect(stylesheet).not.toMatch(/\.app-shell--left-shadow::before\s*\{[^}]*(?:divider|box-shadow)/s);
    expect(stylesheet).not.toMatch(/--shadow-codex-iab-edge:/);
  });

  it('centers a partially concealed toggle without changing nav geometry', () => {
    expect(stylesheet).toMatch(/\.app-rail__nav\s*\{[^}]*position:\s*relative;/s);
    expect(stylesheet).toMatch(/\.app-rail__left-shadow-toggle\s*\{[^}]*position:\s*absolute;[^}]*left:\s*50%;[^}]*bottom:\s*-4px;[^}]*width:\s*10px;[^}]*height:\s*10px;[^}]*transform:\s*translateX\(-50%\);/s);
    expect(stylesheet).toMatch(/\.app-rail__left-shadow-toggle:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\);[^}]*outline-offset:\s*-2px;/s);
  });
});
