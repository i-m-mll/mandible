/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { useSidebarListNavigation } from '../ui/src/hooks/useSidebarListNavigation';

afterEach(cleanup);

function NavigableList() {
  const items = ['first', 'second', 'third'];
  const [selected, setSelected] = useState('second');
  const navigation = useSidebarListNavigation({
    items,
    getKey: (item) => item,
    selectedKey: selected,
    onSelect: setSelected,
  });

  return (
    <div>
      {items.map((item, index) => {
        const itemNavigation = navigation.getItemNavigationProps(item, index);
        return (
          <button
            key={item}
            ref={itemNavigation.ref}
            type="button"
            tabIndex={itemNavigation.tabIndex}
            aria-current={itemNavigation['aria-current']}
            onKeyDown={itemNavigation.onKeyDown}
            onClick={() => setSelected(item)}
          >
            {item}
          </button>
        );
      })}
    </div>
  );
}

describe('useSidebarListNavigation', () => {
  it('moves and focuses selection with Arrow, Home, and End keys', () => {
    render(<NavigableList />);
    const second = screen.getByRole('button', { name: 'second' });
    second.focus();

    fireEvent.keyDown(second, { key: 'ArrowDown' });
    const third = screen.getByRole('button', { name: 'third' });
    expect(third.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(third);

    fireEvent.keyDown(third, { key: 'Home' });
    const first = screen.getByRole('button', { name: 'first' });
    expect(first.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'End' });
    expect(third.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(third);
  });

  it('owns arrow keys at list boundaries without changing selection', () => {
    render(<NavigableList />);
    const second = screen.getByRole('button', { name: 'second' });
    second.focus();
    fireEvent.keyDown(second, { key: 'Home' });
    const first = screen.getByRole('button', { name: 'first' });

    const boundaryEvent = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      bubbles: true,
      cancelable: true,
    });
    first.dispatchEvent(boundaryEvent);

    expect(boundaryEvent.defaultPrevented).toBe(true);
    expect(first.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(first);
  });
});
