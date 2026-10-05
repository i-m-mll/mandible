import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextualAction } from '../../ui/src/components/shared/ContextualAction';

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
  });
});
