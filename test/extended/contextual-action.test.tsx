import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextualAction } from '../../ui/src/components/shared/ContextualAction';

const stylesheet = readFileSync('ui/src/styles/contextual-action.css', 'utf8');

afterEach(cleanup);

describe('shared contextual action', () => {
  it('renders an accessible bare button without changing its operation', () => {
    const onPress = vi.fn();
    render(
      <div className="contextual-action-owner">
        <span className="contextual-action-group">
          <ContextualAction aria-label="Pin item" aria-pressed="true" onClick={onPress}>
            <svg aria-hidden="true" />
          </ContextualAction>
        </span>
      </div>,
    );

    const action = screen.getByRole('button', { name: 'Pin item' });
    expect(action.classList.contains('contextual-action')).toBe(true);
    expect(action.getAttribute('type')).toBe('button');
    fireEvent.click(action);
    expect(onPress).toHaveBeenCalledOnce();
    action.focus();
    expect(document.activeElement).toBe(action);
  });

  it('owns reveal, stronger interaction, selected-neutral, and coarse-pointer styling', () => {
    const baseRule = stylesheet.match(/\.contextual-action\s*{([^}]*)}/)?.[1] ?? '';
    expect(baseRule).toContain('border: 0');
    expect(baseRule).toContain('border-radius: 0');
    expect(baseRule).toContain('background: transparent');
    expect(baseRule).toContain('color: var(--text-subdued)');
    expect(stylesheet).toMatch(/\.contextual-action:is\([^}]*\[aria-expanded='true'\][^}]*\[aria-pressed='true'\]\)\s*{[^}]*background: transparent;[^}]*color: var\(--chrome-icon-hover-indirect\);/s);
    expect(stylesheet).toMatch(/\.contextual-action:is\(:hover, :focus-visible\)\s*{[^}]*color: var\(--chrome-icon-hover-direct\);/s);
    expect(stylesheet).toMatch(/\.contextual-action-group\s*{[^}]*opacity: 0;[^}]*pointer-events: none;/s);
    expect(stylesheet).toMatch(/\.contextual-action-owner:hover > \.contextual-action-group/);
    expect(stylesheet).not.toContain('.contextual-action-owner:is(:hover, :focus-within)');
    expect(stylesheet).toMatch(/\.contextual-action-group:has\(\.contextual-action:focus-visible\)/);
    expect(stylesheet).not.toMatch(/selected[^}]*contextual-action-group/);
    expect(stylesheet).toMatch(/@media \(hover: none\), \(pointer: coarse\)\s*{[^}]*\.contextual-action-group\s*{[^}]*opacity: 1;[^}]*pointer-events: auto;/s);
    expect(stylesheet).toMatch(/@media \(hover: none\), \(pointer: coarse\)[\s\S]*:where\(\.contextual-action-group\) \.contextual-action\s*{[^}]*color: var\(--chrome-icon-hover-indirect\);/);
  });

  it('provides one stable compact icon-button presentation without changing button semantics', () => {
    render(
      <ContextualAction presentation="compact" aria-label="Previous item" disabled>
        <svg aria-hidden="true" />
      </ContextualAction>,
    );

    const action = screen.getByRole('button', { name: 'Previous item' }) as HTMLButtonElement;
    expect(action.type).toBe('button');
    expect(action.disabled).toBe(true);
    expect(action.classList.contains('contextual-action--compact')).toBe(true);
    expect(stylesheet).toMatch(/\.contextual-action--compact\s*{[^}]*width: 2em;[^}]*height: 2em;[^}]*padding: \.5em;[^}]*border: 0;[^}]*border-radius: var\(--radius-sm\);[^}]*background: transparent;[^}]*box-shadow: none;/s);
    expect(stylesheet).toMatch(/\.contextual-action--compact > svg\s*{[^}]*width: 1em;[^}]*height: 1em;/s);
    expect(stylesheet).toMatch(/\.contextual-action--compact:is\(:hover, :focus-visible\)\s*{[^}]*background: var\(--surface-hover\);/s);
    expect(stylesheet).toMatch(/\.contextual-action--compact:disabled\s*{[^}]*cursor: not-allowed;[^}]*opacity: \.45;/s);
    expect(stylesheet).toMatch(/@media \(hover: none\), \(pointer: coarse\)[\s\S]*\.contextual-action--compact\s*{[^}]*min-width: 44px;[^}]*min-height: 44px;/s);
  });
});
