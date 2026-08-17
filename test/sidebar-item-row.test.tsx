import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SidebarItemBadge,
  SidebarItemOverflowMenu,
  SidebarItemPinAction,
  SidebarItemRow,
} from '../ui/src/components/shared/SidebarItemRow';

afterEach(() => cleanup());

describe('SidebarItemRow', () => {
  it('keeps selection, passive facts, and actions in separate accessible controls', () => {
    const onSelect = vi.fn();
    const onPin = vi.fn();
    const onArchive = vi.fn();
    render(
      <SidebarItemRow
        label="A title long enough to truncate"
        selectionLabel="Select the item"
        selected
        ariaCurrent="true"
        onSelect={onSelect}
        badges={<SidebarItemBadge ariaLabel="12 items">12</SidebarItemBadge>}
        actions={(
          <>
            <SidebarItemPinAction label="the item" pressed={false} onPress={onPin} />
            <SidebarItemOverflowMenu
              label="More actions for the item"
              actions={[{ id: 'archive', label: 'Archive', onSelect: onArchive }]}
            />
          </>
        )}
      />,
    );

    const select = screen.getByRole('button', { name: 'Select the item' });
    const row = select.closest('.sidebar-item-row');
    expect(row?.classList.contains('sidebar-item-row--selected')).toBe(true);
    expect(select.getAttribute('aria-current')).toBe('true');
    expect(row?.querySelector('.sidebar-item-row__label')?.textContent).toBe('A title long enough to truncate');
    expect(screen.getByLabelText('12 items').textContent).toBe('12');

    fireEvent.click(screen.getByRole('button', { name: 'Pin the item' }));
    expect(onPin).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'More actions for the item' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(onArchive).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(select);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('reveals actions through focus-within and returns focus when Escape closes overflow', () => {
    render(
      <SidebarItemRow
        label="Keyboard row"
        selectionLabel="Select keyboard row"
        onSelect={() => undefined}
        actions={(
          <SidebarItemOverflowMenu
            label="More actions for keyboard row"
            actions={[{ id: 'rename', label: 'Rename', onSelect: () => undefined }]}
          />
        )}
      />,
    );

    const select = screen.getByRole('button', { name: 'Select keyboard row' });
    const trigger = screen.getByRole('button', { name: 'More actions for keyboard row' });
    select.focus();
    expect(document.activeElement).toBe(select);
    expect(select.closest('.sidebar-item-row')?.contains(document.activeElement)).toBe(true);
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Rename' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
