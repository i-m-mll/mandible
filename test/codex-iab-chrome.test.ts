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
  });

  it('adds a 15px absolute visual layer without changing internal layout coordinates', () => {
    expect(stylesheet).toMatch(/--codex-iab-edge-width:\s*15px;/);
    expect(stylesheet).toMatch(
      /\.app-shell--codex-iab \.app-header::before,\s*\.app-shell--codex-iab \.app-rail::before\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0 auto 0 0;[^}]*width:\s*var\(--codex-iab-edge-width\);/s,
    );
    expect(stylesheet).not.toMatch(/\.app-shell--codex-iab[^,{]*\{[^}]*(?:padding|margin|transform|grid-template-columns):/s);
  });

  it('derives the leftward subdivision and rightward edge shadows from one mirrored primitive', () => {
    expect(stylesheet).toMatch(/--app-subdivision-shadow-offset:\s*4px;/);
    expect(stylesheet).toMatch(/--app-subdivision-shadow-blur:\s*10px;/);
    expect(stylesheet).toMatch(
      /--shadow-app-subdivision:\s*calc\(-1 \* var\(--app-subdivision-shadow-offset\)\) 0 var\(--app-subdivision-shadow-blur\) 0 var\(--app-subdivision-shadow-color\);/,
    );
    expect(stylesheet).toMatch(
      /--shadow-codex-iab-edge:\s*var\(--app-subdivision-shadow-offset\) 0 var\(--app-subdivision-shadow-blur\) 0 var\(--app-subdivision-shadow-color\);/,
    );
    expect(stylesheet).toMatch(/\.app-layout::after\s*\{[^}]*box-shadow:\s*var\(--shadow-app-subdivision\);/s);
    expect(stylesheet).toMatch(/\.app-shell--codex-iab \.app-header::before,[^{]*\{[^}]*box-shadow:\s*var\(--shadow-codex-iab-edge\);/s);
  });
});
