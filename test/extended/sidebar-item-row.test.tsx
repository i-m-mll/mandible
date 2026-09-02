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
const contextualActionStylesheet = readFileSync('ui/src/styles/contextual-action.css', 'utf8');

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

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

  it('overlays the measured trailing cluster behind a short title fade without reserving width or showing an ellipsis', () => {
    const rowRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row \{([^}]*)\}/)?.[1] ?? '';
    const selectRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__select \{([^}]*)\}/)?.[1] ?? '';
    const contentRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__content \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const labelRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__label \{([^}]*)\}/)?.[1] ?? '';
    const trailingRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__trailing \{([^}]*)\}/)?.[1] ?? '';
    const revealRule = sidebarItemRowStylesheet.match(
      /\.sidebar-item-row:hover \.sidebar-item-row__trailing,\s*\.sidebar-item-row:focus-within \.sidebar-item-row__trailing,\s*\.sidebar-item-row--persistent-pin \.sidebar-item-row__trailing \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(rowRule).toContain('--sidebar-item-row-reveal-width: 0px');
    expect(rowRule).toContain('display: block');
    expect(selectRule).toContain('width: 100%');
    expect(selectRule).not.toContain('mask-image');
    expect(contentRule).toContain('width: 100%');
    expect(contentRule).toContain('overflow: hidden');
    expect(contentRule).toContain('mask-image: linear-gradient');
    expect(contentRule).toContain('var(--sidebar-item-row-reveal-width)');
    expect(contentRule).toContain('calc(100% - var(--sidebar-item-row-reveal-width) - 12px)');
    expect(contentRule).not.toContain('min(12px, var(--sidebar-item-row-reveal-width))');
    expect(contentRule).toContain('transparent calc(100% - var(--sidebar-item-row-reveal-width))');
    expect(labelRule).toContain('text-overflow: clip');
    expect(labelRule).not.toContain('text-overflow: ellipsis');
    expect(labelRule).not.toContain('mask-image');
    expect(trailingRule).toContain('position: absolute');
    expect(trailingRule).toContain('right: 0');
    expect(trailingRule).toContain('opacity: 0');
    expect(trailingRule).not.toMatch(/flex: 0 0|margin-left|padding-left/);
    expect(revealRule).toContain('opacity: 1');
    expect(revealRule).not.toMatch(/width|padding|margin/);
    const actionRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__action \{([^}]*)\}/)?.[1] ?? '';
    expect(actionRule).toContain('width: 24px');
    expect(contextualActionStylesheet).toMatch(/\.contextual-action\s*\{[^}]*border-radius: 0;[^}]*background: transparent;/s);
  });

  it('feeds the actual overlaid cluster width into the shared fade boundary', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 68 } as DOMRect);
    const { rerender } = render(
      <SidebarItemRow
        label="Measured"
        selectionLabel="Select measured"
        onSelect={() => undefined}
        actions={<SidebarItemPinAction label="measured" pressed={false} onPress={() => undefined} />}
      />,
    );
    const row = screen.getByRole('button', { name: 'Select measured' }).closest('.sidebar-item-row') as HTMLElement;
    expect(row.style.getPropertyValue('--sidebar-item-row-trailing-width')).toBe('68px');

    rerender(
      <SidebarItemRow
        label="Measured"
        selectionLabel="Select measured"
        onSelect={() => undefined}
      />,
    );
    expect(row.querySelector('.sidebar-item-row__trailing')).toBeNull();
    expect(row.style.getPropertyValue('--sidebar-item-row-trailing-width')).toBe('0px');
    expect(row.style.getPropertyValue('--sidebar-item-row-persistent-width')).toBe('0px');
  });

  it('reveals the shared cluster and shifted mask boundary for interaction, persistent-pin, and coarse-pointer rows', () => {
    render(
      <SidebarItemRow
        label="Pinned"
        selectionLabel="Select pinned"
        trailingReveal="persistent-pin"
        onSelect={() => undefined}
        actions={<SidebarItemPinAction label="pinned" pressed onPress={() => undefined} />}
      />,
    );
    expect(screen.getByRole('button', { name: 'Select pinned' }).closest('.sidebar-item-row')
      ?.classList.contains('sidebar-item-row--persistent-pin')).toBe(true);
    expect(sidebarItemRowStylesheet).toMatch(
      /\.sidebar-item-row:hover,\s*\.sidebar-item-row:focus-within \{\s*--sidebar-item-row-reveal-width: var\(--sidebar-item-row-trailing-width, 0px\);/,
    );
    expect(sidebarItemRowStylesheet).not.toMatch(
      /\.sidebar-item-row--selected\s*\{[^}]*--sidebar-item-row-reveal-width/s,
    );
    const persistentRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row--persistent-pin \{([^}]*)\}/)?.[1] ?? '';
    expect(persistentRule).toContain('--sidebar-item-row-reveal-width: var(--sidebar-item-row-persistent-width, 0px)');
    const coarsePointerRule = sidebarItemRowStylesheet.match(/@media \(hover: none\), \(pointer: coarse\) \{([\s\S]*)\n\}/)?.[1] ?? '';
    expect(coarsePointerRule).toContain('--sidebar-item-row-reveal-width: var(--sidebar-item-row-trailing-width, 0px)');
    expect(coarsePointerRule).toContain('.sidebar-item-row__trailing');
    expect(coarsePointerRule).toContain('opacity: 1');
    expect(coarsePointerRule).toContain('pointer-events: auto');
  });

  it('measures only the visible pin at persistent rest and the full cluster for reveal', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect() {
      const width = this.classList.contains('sidebar-item-row__trailing') ? 28
        : this.classList.contains('sidebar-item-row__overflow') ? 24
          : 0;
      return { width } as DOMRect;
    });
    render(
      <SidebarItemRow
        label="Persistent"
        selectionLabel="Select persistent"
        trailingReveal="persistent-pin"
        onSelect={() => undefined}
        actions={(
          <>
            <SidebarItemPinAction label="persistent" pressed onPress={() => undefined} />
            <SidebarItemOverflowMenu label="More persistent actions" actions={[{ id: 'copy', label: 'Copy', onSelect: () => undefined }]} />
          </>
        )}
      />,
    );
    const row = screen.getByRole('button', { name: 'Select persistent' }).closest('.sidebar-item-row') as HTMLElement;
    expect(row.style.getPropertyValue('--sidebar-item-row-persistent-width')).toBe('28px');
    expect(row.style.getPropertyValue('--sidebar-item-row-trailing-width')).toBe('54px');
    expect(sidebarItemRowStylesheet).toMatch(/\.sidebar-item-row--persistent-pin \.sidebar-item-row__actions \{[^}]*width: 24px;/s);
    expect(sidebarItemRowStylesheet).toMatch(/\.sidebar-item-row--persistent-pin \.sidebar-item-row__overflow \{[^}]*position: absolute;[^}]*right: calc\(100% \+ 2px\);/s);
  });

  it('remeasures the shared boundary when an existing row becomes persistently pinned', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect() {
      if (this.classList.contains('sidebar-item-row__overflow')) return { width: 24 } as DOMRect;
      if (this.classList.contains('sidebar-item-row__trailing')) {
        return {
          width: this.closest('.sidebar-item-row')?.classList.contains('sidebar-item-row--persistent-pin') ? 28 : 54,
        } as DOMRect;
      }
      return { width: 0 } as DOMRect;
    });
    const actions = (pressed: boolean) => (
      <>
        <SidebarItemPinAction label="dynamic" pressed={pressed} onPress={() => undefined} />
        <SidebarItemOverflowMenu label="More dynamic actions" actions={[{ id: 'copy', label: 'Copy', onSelect: () => undefined }]} />
      </>
    );
    const { rerender } = render(
      <SidebarItemRow
        label="Dynamic"
        selectionLabel="Select dynamic"
        onSelect={() => undefined}
        actions={actions(false)}
      />,
    );
    const row = screen.getByRole('button', { name: 'Select dynamic' }).closest('.sidebar-item-row') as HTMLElement;
    expect(row.style.getPropertyValue('--sidebar-item-row-persistent-width')).toBe('54px');

    rerender(
      <SidebarItemRow
        label="Dynamic"
        selectionLabel="Select dynamic"
        trailingReveal="persistent-pin"
        onSelect={() => undefined}
        actions={actions(true)}
      />,
    );
    expect(row.style.getPropertyValue('--sidebar-item-row-persistent-width')).toBe('28px');
    expect(row.style.getPropertyValue('--sidebar-item-row-trailing-width')).toBe('54px');
  });

  it('keeps an accessible provider in the fixed right footprint and reveals its dot only through interaction', () => {
    render(
      <SidebarItemRow
        label="Provider row"
        selectionLabel="Select provider row"
        provider={{ label: 'Codex', tone: 'codex' }}
        onSelect={() => undefined}
        actions={<SidebarItemPinAction label="provider row" pressed={false} onPress={() => undefined} />}
      />,
    );

    const select = screen.getByRole('button', { name: 'Select provider row' });
    expect(select.getAttribute('aria-description')).toBe('Provider: Codex');
    const dot = screen.getByRole('img', { name: 'Provider: Codex' });
    expect(dot.classList.contains('sidebar-item-row__provider-dot--codex')).toBe(true);
    expect(dot.parentElement?.classList.contains('sidebar-item-row__provider')).toBe(true);
    const trailing = select.nextElementSibling as HTMLElement;
    expect(trailing.classList.contains('sidebar-item-row__trailing')).toBe(true);
    expect(dot.parentElement).toBe(trailing.firstElementChild);
    expect(dot.parentElement?.nextElementSibling?.classList.contains('sidebar-item-row__actions')).toBe(true);
    expect(select.querySelector('.sidebar-item-row__badges')).toBeNull();

    const selectRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__select \{([^}]*)\}/)?.[1] ?? '';
    expect(selectRule).toContain('padding: 5px 7px 5px var(--sidebar-title-column-inset, 7px)');
    const providerRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__provider \{([^}]*)\}/)?.[1] ?? '';
    expect(providerRule).toContain('width: 14px');
    expect(providerRule).toContain('flex: 0 0 14px');
    expect(providerRule).toContain('justify-content: center');
    expect(providerRule).not.toMatch(/position: absolute|left:/);
    const dotRule = sidebarItemRowStylesheet.match(/\.sidebar-item-row__provider-dot \{([^}]*)\}/)?.[1] ?? '';
    expect(dotRule).toContain('width: 7px');
    expect(dotRule).toContain('opacity: 0');
    const revealRule = sidebarItemRowStylesheet.match(
      /\.sidebar-item-row:hover \.sidebar-item-row__provider-dot,\s*\.sidebar-item-row__select:focus \.sidebar-item-row__provider-dot,\s*\.sidebar-item-row:focus-within \.sidebar-item-row__provider-dot,\s*\.sidebar-item-row--persistent-pin \.sidebar-item-row__provider-dot \{([^}]*)\}/,
    )?.[1] ?? '';
    expect(revealRule).toContain('opacity: 1');
  });

  it('keeps a selected untouched row full-width with its provider and hover-only actions hidden', () => {
    render(
      <SidebarItemRow
        label="Selected at rest"
        selectionLabel="Select at-rest row"
        selected
        provider={{ label: 'Codex', tone: 'codex' }}
        onSelect={() => undefined}
        actions={<SidebarItemPinAction label="at-rest row" pressed={false} onPress={() => undefined} />}
      />,
    );

    const row = screen.getByRole('button', { name: 'Select at-rest row' }).closest('.sidebar-item-row')!;
    expect(row.classList.contains('sidebar-item-row--selected')).toBe(true);
    expect(row.classList.contains('sidebar-item-row--persistent-pin')).toBe(false);
    expect(sidebarItemRowStylesheet.match(/\.sidebar-item-row__trailing \{([^}]*)\}/)?.[1]).toContain('opacity: 0');
    expect(sidebarItemRowStylesheet.match(/\.sidebar-item-row__provider-dot \{([^}]*)\}/)?.[1]).toContain('opacity: 0');
    expect(row.querySelector('.sidebar-item-row__actions')?.classList.contains('contextual-action-group')).toBe(true);
    expect(sidebarItemRowStylesheet).not.toMatch(
      /\.sidebar-item-row--selected \.sidebar-item-row__(?:trailing|provider-dot|actions)/,
    );
    expect(sidebarItemRowStylesheet).toMatch(
      /\.sidebar-item-row:hover \.sidebar-item-row__trailing,\s*\.sidebar-item-row:focus-within \.sidebar-item-row__trailing[^}]*\{[^}]*opacity: 1;/s,
    );
    expect(row.classList.contains('contextual-action-owner')).toBe(true);
    expect(contextualActionStylesheet).not.toMatch(/selected[^}]*contextual-action-group/);
  });

  it('uses neutral shared selection and reserves provider tones for explicit consumers', () => {
    render(<SidebarItemRow label="Neutral" selectionLabel="Select neutral" selected onSelect={() => undefined} />);
    const neutral = screen.getByRole('button', { name: 'Select neutral' }).closest('.sidebar-item-row')!;
    expect(neutral.classList.contains('sidebar-item-row--selection-codex')).toBe(false);
    const selectedRule = sidebarItemRowStylesheet.match(/\n\n\.sidebar-item-row--selected \{([^}]*)\}/)?.[1] ?? '';
    expect(selectedRule).toContain('background: var(--neutral-alpha-05)');
    expect(selectedRule).toContain('color: var(--text-primary)');
    expect(selectedRule).not.toMatch(/accent-bg|accent-fg/);
  });

  it('keeps every resolved light and dark provider selection pair above WCAG AA', () => {
    const pairs = [
      ['#f8e5dc', '#492f26'], ['#eaebff', '#30345b'], ['#def7eb', '#1d4334'],
      ['#5e2f1d', '#f3e2da'], ['#30366f', '#e4e6f7'], ['#174b36', '#dceee5'],
    ];
    for (const [foreground, background] of pairs) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
      expect(sidebarItemRowStylesheet).toContain(foreground);
      expect(sidebarItemRowStylesheet).toContain(background);
    }
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
