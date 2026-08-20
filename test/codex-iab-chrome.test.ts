import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { readResolvedStylesheet } from './helpers/css-manifest';

const stylesheet = readResolvedStylesheet();
const appSource = readFileSync('ui/src/app.tsx', 'utf8');

describe('Codex IAB chrome edge contract', () => {
  it('applies the modifier only from the positive host capability result', () => {
    expect(appSource).toContain(
      "${codexIabDetected ? ' app-shell--codex-iab' : ''}",
    );
    expect(appSource).not.toContain(
      "${agentPageBinding !== null ? ' app-shell--codex-iab' : ''}",
    );
    expect(appSource.match(/app-shell--codex-iab/g)).toHaveLength(1);
  });

  it('adds a 15px absolute visual layer without changing internal layout coordinates', () => {
    expect(stylesheet).toMatch(/--codex-iab-edge-width:\s*15px;/);
    expect(stylesheet).toMatch(
      /\.app-shell--codex-iab \.app-header::before,\s*\.app-shell--codex-iab \.app-rail::before\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0 auto 0 0;[^}]*width:\s*var\(--codex-iab-edge-width\);/s,
    );
    expect(stylesheet).not.toMatch(/\.app-shell--codex-iab[^,{]*\{[^}]*(?:padding|margin|transform|grid-template-columns):/s);
  });

  it('derives both edges from one profile with a sign-only direction change', () => {
    expect(stylesheet).toMatch(/--app-boundary-shadow-offset:\s*8px;/);
    expect(stylesheet).toMatch(/--app-boundary-shadow-blur:\s*36px;/);
    expect(stylesheet).toMatch(/--app-boundary-shadow-spread:\s*0px;/);
    expect(stylesheet).toMatch(
      /--shadow-app-subdivision:\s*calc\(var\(--app-boundary-direction\) \* var\(--app-boundary-shadow-offset\)\) 0 var\(--app-boundary-shadow-blur\) var\(--app-boundary-shadow-spread\) var\(--app-boundary-shadow-color\);/,
    );
    expect(stylesheet).toMatch(/\.app-layout::after\s*\{[^}]*--app-boundary-direction:\s*-1;[^}]*box-shadow:\s*var\(--shadow-app-subdivision\);/s);
    expect(stylesheet).toMatch(/\.app-shell--codex-iab \.app-header::before,[^{]*\{[^}]*--app-boundary-direction:\s*1;[^}]*--app-boundary-accent:\s*var\(--app-divider\);[^}]*border-inline-end:\s*1px solid var\(--app-boundary-accent\);[^}]*box-shadow:\s*var\(--shadow-app-subdivision\);/s);
    expect(stylesheet.match(/box-shadow:\s*var\(--shadow-app-subdivision\)/g)).toHaveLength(2);
    expect(stylesheet).not.toMatch(/--shadow-codex-iab-edge:/);
  });
});
