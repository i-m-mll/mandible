import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'preact/hooks';

import { useAnchoredMenu } from '../../ui/src/hooks/useAnchoredMenu';

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    top,
    right: left + width,
    bottom: top + height,
    left,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function MenuHarness(): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredMenu({
    open,
    anchorRef,
    menuRef,
    onDismiss: () => setOpen(false),
  });
  return (
    <div>
      <button ref={anchorRef} type="button" onClick={() => setOpen((value) => !value)}>Actions</button>
      {open ? (
        <div ref={menuRef} role="menu" popover="manual" className="app-anchored-menu" style={style}>
          <button type="button" role="menuitem">Action</button>
        </div>
      ) : null}
      <button type="button">Outside</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
});

describe('useAnchoredMenu behavior', () => {
  it('flips and clamps a bottom-right menu inside the viewport', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 240 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function bounds() {
      if (this.getAttribute('role') === 'menu') return rect(0, 0, 180, 120);
      if (this.textContent === 'Actions') return rect(286, 206, 26, 26);
      return rect(0, 0, 0, 0);
    });

    render(<MenuHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = screen.getByRole('menu');

    await waitFor(() => expect(menu.style.visibility).toBe('visible'));
    expect(menu.style.position).toBe('fixed');
    expect(Number.parseFloat(menu.style.left)).toBe(132);
    expect(Number.parseFloat(menu.style.top)).toBe(80);
    expect(Number.parseFloat(menu.style.left) + 180).toBeLessThanOrEqual(312);
  });

  it('dismisses outside, while inside pointers preserve the menu', async () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    screen.getByRole('menuitem').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(screen.getByRole('menu')).toBeTruthy();
    screen.getByRole('button', { name: 'Outside' }).dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('dismisses on Escape and restores focus to the anchor', () => {
    render(<MenuHarness />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    fireEvent.click(trigger);
    screen.getByRole('menuitem').focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
