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

  it('uses the measured gutter for the absolute visual layer without changing internal layout coordinates', () => {
    expect(stylesheet).toMatch(/--app-shadow-gutter-width:\s*17px;/);
    expect(stylesheet).not.toMatch(/--codex-iab-edge-width:/);
    expect(stylesheet).toMatch(
      /\.app-shell--codex-iab \.app-header::before,\s*\.app-shell--codex-iab \.app-rail::before\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0 auto 0 0;[^}]*width:\s*var\(--app-shadow-gutter-width\);/s,
    );
    expect(stylesheet).not.toMatch(/\.app-shell--codex-iab[^,{]*\{[^}]*(?:padding|margin|transform|grid-template-columns):/s);
  });

  it('derives both edges from one profile with a sign-only direction change', () => {
    expect(stylesheet).toMatch(/--app-boundary-shadow-offset:\s*8px;/);
    expect(stylesheet).toMatch(/--app-boundary-shadow-blur:\s*36px;/);
    expect(stylesheet).toMatch(/--app-boundary-shadow-spread:\s*0px;/);
    expect(stylesheet).toMatch(
      /:where\(\.app-layout\)::after,\s*:where\(\.app-shell--codex-iab\) \.app-header::before,\s*:where\(\.app-shell--codex-iab\) \.app-rail::before\s*\{[^}]*--shadow-app-subdivision:\s*var\(--app-boundary-shadow-x\) 0 var\(--app-boundary-shadow-blur\) var\(--app-boundary-shadow-spread\) var\(--app-boundary-shadow-color\);/s,
    );
    expect(stylesheet).toMatch(/\.app-layout::after\s*\{[^}]*--app-boundary-shadow-x:\s*calc\(0px - var\(--app-boundary-shadow-offset\)\);[^}]*box-shadow:\s*var\(--shadow-app-subdivision\);/s);
    expect(stylesheet).toMatch(/\.app-shell--codex-iab \.app-header::before,[^{]*\{[^}]*--app-boundary-shadow-x:\s*var\(--app-boundary-shadow-offset\);[^}]*--app-boundary-accent:\s*var\(--app-divider\);[^}]*border-inline-end:\s*1px solid var\(--app-boundary-accent\);[^}]*box-shadow:\s*var\(--shadow-app-subdivision\);/s);
    expect(stylesheet.match(/box-shadow:\s*var\(--shadow-app-subdivision\)/g)).toHaveLength(2);
    expect(stylesheet).not.toMatch(/--shadow-codex-iab-edge:/);
  });
});
