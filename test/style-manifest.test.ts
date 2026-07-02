import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = readFileSync('ui/src/style.css', 'utf8');

describe('style.css import manifest', () => {
  it('stays a thin import-only manifest with tokens first', () => {
    const lines = manifest.trim().split(/\n/);

    expect(lines[0]).toBe('@import "./styles/tokens.css";');
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(lines.every((line) => /^@import "\.\/styles\/[^"]+\.css";$/.test(line))).toBe(true);
    expect(manifest).not.toMatch(/[{}]/);
  });
});
