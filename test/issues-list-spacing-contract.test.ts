import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const issuesStylesheet = readFileSync('ui/src/styles/issues.css', 'utf8');

function ruleFor(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = issuesStylesheet.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  expect(match, `Expected ${selector} rule`).toBeTruthy();
  return match![1];
}

function pixelValue(rule: string, property: string): number {
  const match = rule.match(new RegExp(`${property}\\s*:\\s*(\\d+)px\\s*;`));
  expect(match, `Expected ${property} pixel value`).toBeTruthy();
  return Number(match![1]);
}

describe('Issues list spacing contract', () => {
  it('keeps the top inset on the scroll owner at twice the row gap', () => {
    const listRule = ruleFor('.issues-list');
    const rowRule = ruleFor('.issues-item');

    expect(listRule).toMatch(/overflow-y\s*:\s*auto\s*;/);
    expect(pixelValue(listRule, 'padding-top')).toBe(2 * pixelValue(rowRule, 'margin-bottom'));
    expect(rowRule).not.toMatch(/margin-top\s*:/);
  });
});
