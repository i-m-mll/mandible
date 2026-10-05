import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SidebarItemBadge,
  SidebarItemOverflowMenu,
  SidebarItemPinAction,
  SidebarItemRow,
  SidebarLeadingActionRow,
} from '../../ui/src/components/shared/SidebarItemRow';

const sidebarItemRowStylesheet = readFileSync('ui/src/styles/sidebar-item-row.css', 'utf8');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SidebarLeadingActionRow', () => {
  it('provides one native, focusable action while keeping its icon decorative', () => {
    const onPress = vi.fn();
    render(<SidebarLeadingActionRow label="New item" icon={<svg data-testid="icon" />} onPress={onPress} />);

    const action = screen.getByRole('button', { name: 'New item' });
    expect(action.getAttribute('type')).toBe('button');
    expect(action.classList.contains('sidebar-leading-action-row')).toBe(true);
    expect(screen.getByTestId('icon').closest('.sidebar-leading-action-row__icon')?.getAttribute('aria-hidden')).toBe('true');
    action.focus();
    expect(document.activeElement).toBe(action);
    fireEvent.click(action);
    expect(onPress).toHaveBeenCalledOnce();
  });
});

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
    expect(selectChildren).toHaveLength(1);
    expect(selectChildren[0].classList.contains('sidebar-item-row__content')).toBe(true);
    expect(selectChildren[0].lastElementChild?.classList.contains('sidebar-item-row__badges')).toBe(true);
    expect(select.nextElementSibling?.classList.contains('sidebar-item-row__trailing')).toBe(true);
    expect(select.nextElementSibling?.querySelector('.sidebar-item-row__actions')).toBeTruthy();

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






  it('keeps an accessible official provider mark in a fixed right-edge slot after reveal-only actions', () => {
    render(
      <SidebarItemRow
        label="Provider row"
        selectionLabel="Select provider row"
        provider={{ label: 'Codex', mark: 'openai' }}
        onSelect={() => undefined}
        actions={<SidebarItemPinAction label="provider row" pressed={false} onPress={() => undefined} />}
      />,
    );

    const select = screen.getByRole('button', { name: 'Select provider row' });
    expect(select.getAttribute('aria-description')).toBe('Provider: Codex');
    const mark = screen.getByRole('img', { name: 'Provider: Codex' });
    expect(mark.classList.contains('sidebar-item-row__provider-mark')).toBe(true);
    expect(mark.getAttribute('viewBox')).toBe('0 0 721 721');
    expect(mark.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
    expect(mark.parentElement?.classList.contains('sidebar-item-row__provider')).toBe(true);
    const trailing = select.nextElementSibling as HTMLElement;
    expect(trailing.classList.contains('sidebar-item-row__trailing')).toBe(true);
    expect(trailing.firstElementChild?.classList.contains('sidebar-item-row__actions')).toBe(true);
    expect(mark.parentElement).toBe(trailing.lastElementChild);
    expect(select.closest('.sidebar-item-row')?.classList.contains('sidebar-item-row--has-provider-mark')).toBe(true);
    expect(select.querySelector('.sidebar-item-row__badges')).toBeNull();

    const selectRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__select \{([^}]*)\}/)?.[1] ?? '';
    expect(selectRule).toContain('padding: 5px 7px 5px var(--sidebar-title-column-inset, 7px)');
    const providerRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__provider \{([^}]*)\}/)?.[1] ?? '';
    expect(providerRule).toContain('width: 18px');
    expect(providerRule).toContain('flex: 0 0 18px');
    expect(providerRule).toContain('justify-content: center');
    expect(providerRule).not.toMatch(/position: absolute|left:/);
    const markRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__provider-mark \{([^}]*)\}/)?.[1] ?? '';
    expect(markRule).toContain('width: 18px');
    expect(markRule).toContain('height: 18px');
    expect(markRule).toContain('color: var(--text-subdued)');
    expect(markRule).toContain('opacity: 0');
    expect(markRule).not.toMatch(/background/);
    const providerFootprintRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row--has-provider-mark \{([^}]*)\}/)?.[1] ?? '';
    expect(providerFootprintRule).toContain('--sidebar-item-row-reveal-width: 22px');
  });



  it('fails closed without inventing a mark while preserving unsupported provider identity', () => {
    render(<SidebarItemRow label="Unsupported" selectionLabel="Select unsupported" provider={{ label: 'agy', mark: null }} onSelect={() => undefined} />);
    const select = screen.getByRole('button', { name: 'Select unsupported' });
    expect(select.getAttribute('aria-description')).toBe('Provider: agy');
    expect(select.closest('.sidebar-item-row')?.classList.contains('sidebar-item-row--has-provider-mark')).toBe(false);
    expect(screen.queryByRole('img', { name: 'Provider: agy' })).toBeNull();
    expect(select.nextElementSibling).toBeNull();
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

  it('keeps an open overflow menu hit-tested and contains one pointer activation', () => {
    const onSelect = vi.fn();
    const onArchive = vi.fn();
    const onOuterPointerDown = vi.fn();
    render(
      <div onPointerDown={onOuterPointerDown}>
        <SidebarItemRow
          label="Pointer row"
          selectionLabel="Select pointer row"
          onSelect={onSelect}
          actions={(
            <SidebarItemOverflowMenu
              label="More actions for pointer row"
              actions={[{ id: 'archive', label: 'Archive', onSelect: onArchive }]}
            />
          )}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'More actions for pointer row' }));
    const menu = screen.getByRole('menu');
    const action = screen.getByRole('menuitem', { name: 'Archive' });
    const overflow = menu.closest('.sidebar-item-row__overflow');
    expect(overflow?.classList.contains('sidebar-item-row__overflow--open')).toBe(true);

    fireEvent.pointerDown(action);
    fireEvent.pointerUp(action);
    fireEvent.click(action);
    expect(onArchive).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOuterPointerDown).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('flips and clamps overflow menus inside the viewport layer', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockBounds() {
      if (this.getAttribute('role') === 'menu') {
        return {
          x: 0, y: 0, top: 0, right: 180, bottom: 240, left: 0,
          width: 180, height: 240, toJSON: () => ({}),
        } as DOMRect;
      }
      if (this.getAttribute('aria-label') === 'Viewport actions') {
        return {
          x: window.innerWidth - 38,
          y: window.innerHeight - 38,
          top: window.innerHeight - 38,
          right: window.innerWidth - 8,
          bottom: window.innerHeight - 8,
          left: window.innerWidth - 38,
          width: 30,
          height: 30,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0,
        width: 0, height: 0, toJSON: () => ({}),
      } as DOMRect;
    });

    render(
      <SidebarItemOverflowMenu
        label="Viewport actions"
        actions={[{ id: 'open', label: 'Open', onSelect: () => undefined }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Viewport actions' }));
    const menu = screen.getByRole('menu');

    await waitFor(() => expect(menu.style.visibility).toBe('visible'));
    expect(menu.classList.contains('app-anchored-menu')).toBe(true);
    expect(menu.getAttribute('popover')).toBe('manual');
    expect(menu.style.position).toBe('fixed');
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(menu.style.left) + 180).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(Number.parseFloat(menu.style.top)).toBe(window.innerHeight - 284);
  });
});
