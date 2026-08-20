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

  it('uses zero structural reservation for the absolute visual layer without changing internal layout coordinates', () => {
    expect(stylesheet).toMatch(/--app-shadow-gutter-width:\s*0px;/);
    expect(stylesheet).toMatch(/--app-boundary-shadow-paint-width:\s*17px;/);
    expect(stylesheet).not.toMatch(/--(?:codex-iab|left-shadow)-edge-width:/);
    expect(stylesheet).toMatch(
      /\.app-shell--left-shadow::before\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0 auto 0 0;[^}]*width:\s*var\(--app-boundary-shadow-paint-width\);/s,
    );
    expect(stylesheet).not.toMatch(/\.app-shell--left-shadow[^,{]*\{[^}]*(?:padding|margin|transform|grid-template-columns):/s);
  });

  it('derives both edges from one profile with a sign-only direction change', () => {
    expect(stylesheet).toMatch(/--app-boundary-shadow-offset:\s*8px;/);
    expect(stylesheet).toMatch(/--app-boundary-shadow-blur:\s*36px;/);
    expect(stylesheet).toMatch(/--app-boundary-shadow-spread:\s*0px;/);
    expect(stylesheet).toMatch(
      /:where\(\.app-shell\)::after,\s*:where\(\.app-shell--left-shadow\)::before\s*\{[^}]*--shadow-app-subdivision:[^}]*--shadow-app-subdivision-paint:/s,
    );
    expect(stylesheet).toMatch(/\.app-shell::after\s*\{[^}]*--app-boundary-shadow-direction:\s*to right;[^}]*var\(--shadow-app-subdivision-paint\),/s);
    expect(stylesheet).toMatch(/\.app-shell--left-shadow::before\s*\{[^}]*--app-boundary-shadow-direction:\s*to left;[^}]*background-image:\s*var\(--shadow-app-subdivision-paint\);[^}]*box-shadow:\s*var\(--shadow-app-subdivision\);/s);
    expect(stylesheet.match(/box-shadow:\s*var\(--shadow-app-subdivision\)/g)).toHaveLength(1);
    expect(stylesheet).not.toMatch(/--shadow-codex-iab-edge:/);
  });

  it('centers a partially concealed toggle without changing nav geometry', () => {
    expect(stylesheet).toMatch(/\.app-rail__nav\s*\{[^}]*position:\s*relative;/s);
    expect(stylesheet).toMatch(/\.app-rail__left-shadow-toggle\s*\{[^}]*position:\s*absolute;[^}]*left:\s*50%;[^}]*bottom:\s*-4px;[^}]*width:\s*10px;[^}]*height:\s*10px;[^}]*transform:\s*translateX\(-50%\);/s);
    expect(stylesheet).toMatch(/\.app-rail__left-shadow-toggle:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\);[^}]*outline-offset:\s*-2px;/s);
  });
});
