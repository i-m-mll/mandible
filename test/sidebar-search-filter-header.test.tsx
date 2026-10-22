

import { render, screen, cleanup, fireEvent } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SidebarSearchFilterHeader } from '../ui/src/components/shared/SidebarSearchFilterHeader';


afterEach(() => {
  cleanup();
});

describe('SidebarSearchFilterHeader', () => {

  it('renders search-only headers with an action slot and stable input test id', () => {
    const onValueChange = vi.fn();
    render(
      <SidebarSearchFilterHeader
        value="road"
        onValueChange={onValueChange}
        placeholder="Filter spaces..."
        searchAriaLabel="Filter spaces"
        clearAriaLabel="Clear spaces filter"
        actionSlot={<button type="button">+</button>}
        testId="spaces-sidebar"
        inputTestId="spaces-filter-input"
      />,
    );

    const input = screen.getByTestId('spaces-filter-input') as HTMLInputElement;
    expect(input.value).toBe('road');
    expect(screen.getByTestId('spaces-sidebar').classList.contains('sidebar-search-filter')).toBe(true);
    expect(screen.getByRole('button', { name: '+' })).toBeTruthy();

    fireEvent.input(input, { target: { value: 'canvas' } });
    expect(onValueChange).toHaveBeenCalledWith('canvas');
  });

  it('keeps shared geometry and find focus for a custom search control beside a menu trigger', () => {
    render(
      <SidebarSearchFilterHeader
        value=""
        onValueChange={vi.fn()}
        placeholder="Filter inbox"
        searchAriaLabel="Filter inbox"
        clearAriaLabel="Clear inbox filter"
        searchSlot={<input type="text" aria-label="Inbox token filter" />}
        filterTrigger={{
          ariaLabel: 'Inbox menu',
          kind: 'menu',
          open: true,
          onToggle: vi.fn(),
        }}
        panel={{
          id: 'inbox-menu',
          role: 'menu',
          children: <button type="button" role="menuitem">Refresh</button>,
        }}
      />,
    );

    const input = screen.getByRole('textbox', { name: 'Inbox token filter' });
    const trigger = screen.getByRole('button', { name: 'Inbox menu' });
    expect(trigger.previousElementSibling?.contains(input)).toBe(true);
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(screen.getByRole('menu', { name: 'Inbox menu' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(input);
  });

  it('clears search text and renders a popover filter trigger with count and panel content', () => {
    const onValueChange = vi.fn();
    const onToggle = vi.fn();
    render(
      <SidebarSearchFilterHeader
        value="auth"
        onValueChange={onValueChange}
        placeholder="Search auth requests..."
        searchAriaLabel="Search auth requests"
        clearAriaLabel="Clear auth search"
        filterTrigger={{
          ariaLabel: 'Advanced auth filters',
          open: true,
          active: true,
          count: 3,
          onToggle,
        }}
        summarySlot={<span>active filters</span>}
        panel={{
          id: 'auth-filter-panel',
          variant: 'popover',
          children: <button type="button" className="sidebar-search-filter__option">active</button>,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear auth search' }));
    expect(onValueChange).toHaveBeenCalledWith('');

    const trigger = screen.getByRole('button', { name: 'Advanced auth filters' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.classList.contains('sidebar-search-filter__trigger--active')).toBe(true);
    expect(screen.getByText('3')).toBeTruthy();
    fireEvent.click(trigger);
    expect(onToggle).toHaveBeenCalledTimes(1);

    const panel = document.getElementById('auth-filter-panel');
    expect(panel).toBeTruthy();
    expect(panel!.classList.contains('sidebar-search-filter__panel--popover')).toBe(true);
    expect(panel!.classList.contains('app-anchored-menu')).toBe(true);
    expect(panel!.getAttribute('popover')).toBe('manual');
    expect(screen.getByText('active filters')).toBeTruthy();
  });

  it('owns Escape and outside-pointer dismissal for open overlays', () => {
    const onDismiss = vi.fn();
    render(
      <div>
        <SidebarSearchFilterHeader
          value=""
          onValueChange={vi.fn()}
          placeholder="Filter issues"
          searchAriaLabel="Filter issues"
          clearAriaLabel="Clear issue filter"
          filterTrigger={{
            ariaLabel: 'Advanced issue filters',
            open: true,
            onToggle: vi.fn(),
          }}
          panel={{
            id: 'issue-filter-panel',
            ariaLabel: 'Issue filter controls',
            onDismiss,
            children: <button type="button">Open only</button>,
          }}
        />
        <button type="button">Outside</button>
      </div>,
    );

    const trigger = screen.getByRole('button', { name: 'Advanced issue filters' });
    expect(trigger.getAttribute('aria-controls')).toBe('issue-filter-panel');
    expect(screen.getByRole('dialog', { name: 'Issue filter controls' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    screen.getByRole('button', { name: 'Outside' }).dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
    screen.getByRole('button', { name: 'Open only' }).dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('renders inline panels and calls onBlurWithin for outside-focus handling', () => {
    const onBlurWithin = vi.fn();
    const { container } = render(
      <SidebarSearchFilterHeader
        value=""
        onValueChange={vi.fn()}
        placeholder="Search artifacts"
        searchAriaLabel="Search artifacts"
        clearAriaLabel="Clear artifact search"
        onBlurWithin={onBlurWithin}
        panel={{
          variant: 'inline',
          children: <label className="artifacts-advanced__field">Facet</label>,
        }}
      />,
    );

    expect(container.querySelector('.sidebar-search-filter__panel--inline')).toBeTruthy();
    fireEvent(
      screen.getByRole('searchbox', { name: 'Search artifacts' }),
      new FocusEvent('focusout', { bubbles: true }),
    );
    expect(onBlurWithin).toHaveBeenCalledTimes(1);
  });

  it('captures Command-F and Control-F for the mounted view search', () => {
    render(
      <SidebarSearchFilterHeader
        value="artifact"
        onValueChange={vi.fn()}
        placeholder="Search artifacts"
        searchAriaLabel="Search artifacts"
        clearAriaLabel="Clear artifact search"
      />,
    );

    const input = screen.getByRole('searchbox', { name: 'Search artifacts' }) as HTMLInputElement;
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('artifact'.length);

    input.blur();
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(document.activeElement).toBe(input);
  });

  it('leaves find shortcuts owned by other editable controls alone', () => {
    render(
      <div>
        <textarea aria-label="Document editor" />
        <SidebarSearchFilterHeader
          value=""
          onValueChange={vi.fn()}
          placeholder="Search artifacts"
          searchAriaLabel="Search artifacts"
          clearAriaLabel="Clear artifact search"
        />
      </div>,
    );

    const editor = screen.getByRole('textbox', { name: 'Document editor' });
    editor.focus();
    fireEvent.keyDown(editor, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(editor);
  });

  it('lets only the visible header own find when cached panels remain mounted', () => {
    render(
      <div>
        <section hidden aria-hidden="true">
          <SidebarSearchFilterHeader
            value=""
            onValueChange={vi.fn()}
            placeholder="Search auth requests"
            searchAriaLabel="Search auth requests"
            clearAriaLabel="Clear auth search"
          />
        </section>
        <section>
          <SidebarSearchFilterHeader
            value="bug"
            onValueChange={vi.fn()}
            placeholder="Filter issues"
            searchAriaLabel="Filter issues"
            clearAriaLabel="Clear issue filter"
          />
        </section>
      </div>,
    );

    const hiddenSearch = screen.getByRole('searchbox', {
      name: 'Search auth requests',
      hidden: true,
    });
    const visibleSearch = screen.getByRole('searchbox', { name: 'Filter issues' });
    fireEvent.keyDown(window, { key: 'f', metaKey: true });

    expect(document.activeElement).toBe(visibleSearch);
    expect(document.activeElement).not.toBe(hiddenSearch);
  });

  it('preserves native find when every mounted header belongs to a hidden panel', () => {
    render(
      <section hidden aria-hidden="true">
        <SidebarSearchFilterHeader
          value=""
          onValueChange={vi.fn()}
          placeholder="Search artifacts"
          searchAriaLabel="Search artifacts"
          clearAriaLabel="Clear artifact search"
        />
      </section>,
    );

    const event = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });



});
