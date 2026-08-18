import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SidebarItemBadge,
  SidebarItemOverflowMenu,
  SidebarItemPinAction,
  SidebarItemRow,
} from '../ui/src/components/shared/SidebarItemRow';

const sidebarItemRowStylesheet = readFileSync('ui/src/styles/sidebar-item-row.css', 'utf8');

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
        selectionDescription="Item state: active"
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
    expect(select.getAttribute('aria-description')).toBe('Item state: active');
    expect(row?.querySelector('.sidebar-item-row__label')?.textContent).toBe('A title long enough to truncate');
    expect(screen.getByLabelText('12 items').textContent).toBe('12');
    const selectChildren = Array.from(select.children);
    expect(selectChildren.at(-1)?.classList.contains('sidebar-item-row__badges')).toBe(true);
    expect(select.nextElementSibling?.classList.contains('sidebar-item-row__actions')).toBe(true);

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

  it('reserves the action footprint before hover and only changes visibility on reveal', () => {
    const baseRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__actions \{([^}]*)\}/)?.[1] ?? '';
    const revealRule = sidebarItemRowStylesheet.match(
      /\.sidebar-item-row:hover \.sidebar-item-row__actions,\s*\.sidebar-item-row:focus-within \.sidebar-item-row__actions \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(baseRule).toContain('width: auto');
    expect(baseRule).toContain('padding-right: 4px');
    expect(baseRule).toContain('overflow: visible');
    expect(baseRule).toContain('opacity: 0');
    expect(revealRule).toContain('opacity: 1');
    expect(revealRule).not.toMatch(/width|padding|overflow/);
    const actionRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__action \{([^}]*)\}/)?.[1] ?? '';
    expect(actionRule).toContain('border-radius: 999px');
  });

  it('keeps actions visible and operable for touch and coarse pointers', () => {
    const coarsePointerRule = sidebarItemRowStylesheet.match(
      /@media \(hover: none\), \(pointer: coarse\) \{\s*\.sidebar-item-row__actions \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(coarsePointerRule).toContain('opacity: 1');
    expect(coarsePointerRule).toContain('pointer-events: auto');
  });

  it('keeps an accessible provider outside the canonical title column and reveals its dot only through interaction or selection', () => {
    render(
      <SidebarItemRow
        label="Provider row"
        selectionLabel="Select provider row"
        provider={{ label: 'Codex', tone: 'codex' }}
        onSelect={() => undefined}
      />,
    );

    const select = screen.getByRole('button', { name: 'Select provider row' });
    expect(select.getAttribute('aria-description')).toBe('Provider: Codex');
    const dot = screen.getByRole('img', { name: 'Provider: Codex' });
    expect(dot.classList.contains('sidebar-item-row__provider-dot--codex')).toBe(true);
    expect(dot.parentElement?.classList.contains('sidebar-item-row__provider-gutter')).toBe(true);
    expect(select.querySelector('.sidebar-item-row__badges')).toBeNull();

    const selectRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__select \{([^}]*)\}/)?.[1] ?? '';
    expect(selectRule).toContain('position: relative');
    expect(selectRule).toContain('padding: 5px 7px 5px var(--sidebar-title-column-inset, 7px)');
    const gutterRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__provider-gutter \{([^}]*)\}/)?.[1] ?? '';
    expect(gutterRule).toContain('position: absolute');
    expect(gutterRule).toContain('left: calc(var(--sidebar-title-column-inset, 7px) - 14px)');
    expect(gutterRule).toContain('width: 14px');
    expect(gutterRule).toContain('justify-content: center');
    expect(gutterRule).not.toMatch(/flex:|margin-right/);
    const dotRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__provider-dot \{([^}]*)\}/)?.[1] ?? '';
    expect(dotRule).toContain('width: 7px');
    expect(dotRule).toContain('opacity: 0');
    const revealRule = sidebarItemRowStylesheet.match(
      /\.sidebar-item-row:hover \.sidebar-item-row__provider-dot,\s*\.sidebar-item-row__select:focus \.sidebar-item-row__provider-dot,\s*\.sidebar-item-row:focus-within \.sidebar-item-row__provider-dot,\s*\.sidebar-item-row--selected \.sidebar-item-row__provider-dot \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(revealRule).toContain('opacity: 1');
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
