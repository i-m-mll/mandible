import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DetailPaneHeader } from '../ui/src/components/shared/DetailPaneHeader.js';
import { DetailPaneMenuTrigger } from '../ui/src/components/shared/DetailPaneMenuTrigger.js';
import { DetailPaneShell } from '../ui/src/components/shared/DetailPaneShell.js';
import { EntityTimestamps } from '../ui/src/components/shared/EntityTimestamps.js';
import { CollapsiblePanel } from '../ui/src/components/shared/CollapsiblePanel.js';
import { shortIdentityRef } from '../ui/src/identity-refs.js';
import { AppShellProvider, type AppRightSidebarDescriptor } from '../ui/src/app-shell.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.head.querySelector('[data-test-compact-header-styles]')?.remove();
});

describe('canonical detail pane header', () => {
  it('uses the shared overflow trigger with menu semantics and the supplied anchor ref', () => {
    const onClick = vi.fn();
    const buttonRef = { current: null as HTMLButtonElement | null };
    render(
      <DetailPaneMenuTrigger
        buttonRef={buttonRef}
        label="Issue actions"
        expanded
        onClick={onClick}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Issue actions' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(buttonRef.current).toBe(trigger);
    fireEvent.click(trigger);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each(['standard', 'versioned', 'compact'] as const)(
    'keeps %s identity and actions but omits the app-sidebar slot in sidebar presentation',
    (variant) => {
      const descriptor: AppRightSidebarDescriptor = {
        id: 'test-preview',
        kind: 'panel',
        title: 'Preview',
        ariaLabel: 'Preview',
        content: null,
        open: false,
        width: 360,
        onOpenChange: () => undefined,
        onWidthChange: () => undefined,
      };
      render(
        <AppShellProvider value={{
          active: true,
          rightSidebar: descriptor,
          registerRightSidebar: () => () => undefined,
          registerInitialRouteLoad: () => undefined,
          updateRightSidebar: () => undefined,
          setRightSidebarOpen: () => undefined,
          setViewSidebarWidth: () => undefined,
        }}>
          <DetailPaneHeader
            presentation="sidebar"
            variant={variant}
            identity={{ entityLabel: 'Issue', displayRef: '4fb8d9b', canonicalRef: 'mandible/4fb8d9b' }}
            title="Responsive Chat detail"
            actions={<button type="button">Meaningful action</button>}
          />
        </AppShellProvider>,
      );
      const header = document.querySelector('.detail-pane-header')!;
      expect(header.getAttribute('data-detail-pane-presentation')).toBe('sidebar');
      expect(within(header as HTMLElement).getByText('4fb8d9b')).toBeTruthy();
      expect(within(header as HTMLElement).getByRole('button', { name: 'Meaningful action' })).toBeTruthy();
      expect(within(header as HTMLElement).queryByRole('button', { name: 'Show Preview' })).toBeNull();
      expect(header.querySelector('.app-right-sidebar-toggle')).toBeNull();
    },
  );

  it('labels creation first and attributes only actors supplied for each event', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T16:00:00Z'));
    const now = Date.now();

    const { rerender } = render(
      <EntityTimestamps
        createdAt={now - (20 * 60 * 1000)}
        updatedAt={now - (20 * 60 * 1000)}
        createdBy="codex"
      />,
    );

    expect(screen.getByText('created 20m ago by codex')).toBeTruthy();
    expect(screen.queryByText(/updated/)).toBeNull();

    rerender(
      <EntityTimestamps
        createdAt={now - (2 * 60 * 60 * 1000)}
        updatedAt={now - (5 * 60 * 1000)}
        createdBy="codex"
        updatedBy="claude"
      />,
    );

    expect(document.body.textContent).toContain('created 2h ago by codex · updated 5m ago by claude');
    expect(document.querySelectorAll('time')).toHaveLength(2);
  });

  it('renders standard semantics while keeping exact authority internal and copying the short ref', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    const canonicalRef = 'mandible/087857e5e4addb25ad61ee9163ef33261f3919f8abfdb0fb5c0c277903e98741';

    render(
      <DetailPaneShell
        header={(
          <DetailPaneHeader
            variant="standard"
            identity={{ entityLabel: 'Issue', displayRef: '087857e', canonicalRef }}
            title="Canonical shared header"
            status={<span>open</span>}
            actions={<button type="button">More</button>}
            secondaryMetadata={<span>Updated today</span>}
          />
        )}
      >
        <button type="button">Body action</button>
      </DetailPaneShell>,
    );

    const shell = document.querySelector('.detail-pane-shell') as HTMLElement;
    const header = shell.querySelector(':scope > .detail-pane-shell__header') as HTMLElement;
    const body = shell.querySelector(':scope > .detail-pane-shell__body') as HTMLElement;
    expect(header.querySelectorAll('.detail-pane-header')).toHaveLength(1);
    expect(header.querySelector('header')).toBeNull();
    expect(within(header).getByRole('heading', { name: 'Canonical shared header' })).toBeTruthy();
    expect(within(header).getByText('087857e')).toBeTruthy();
    expect(header.textContent).not.toContain(canonicalRef);
    expect(within(header).getByRole('group', { name: 'Detail actions' })).toBeTruthy();
    expect(within(body).queryByRole('group', { name: 'Detail actions' })).toBeNull();

    const css = readFileSync(resolve(process.cwd(), 'ui/src/styles/detail-pane-shell.css'), 'utf8');

    fireEvent.click(within(header).getByRole('button', { name: 'Copy Issue reference' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('mandible/087857e'));
  });

  it('renders compact and selector semantics with selected canonical copy authority', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    const selectedCanonicalRef = 'artifact-version:av_01KABCDEF0123456789';

    render(
      <DetailPaneHeader
        variant="compact"
        identity={{
          entityLabel: 'Artifact',
          displayRef: 'artifact:12ab34c',
          canonicalRef: 'artifact:art_01KABCDEF0123456789',
        }}
        title="A compact title that remains semantically headed"
        selector={{
          label: 'Artifact version',
          control: <select aria-label="Artifact version"><option>v3</option></select>,
          selectedCanonicalRef,
          copyLabel: 'Copy selected artifact-version reference',
        }}
      />,
    );

    const header = document.querySelector('.detail-pane-header') as HTMLElement;
    expect(header.dataset.detailPaneHeaderVariant).toBe('compact');
    expect(within(header).getByRole('group', { name: 'Artifact version' })).toBeTruthy();
    const selectorControl = header.querySelector('.detail-pane-header__selector-control') as HTMLElement;
    const select = within(header).getByRole('combobox', { name: 'Artifact version' });
    const copy = within(header).getByRole('button', { name: 'Copy selected artifact-version reference' });
    expect(selectorControl.children).toHaveLength(1);
    expect(selectorControl.firstElementChild).toBe(select);
    expect(selectorControl.nextElementSibling).toBe(copy);
    expect(header.textContent).not.toContain(selectedCanonicalRef);

    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('artifact-version:av_01Kabcdef0'));
  });

  it('centralizes typed and untyped ambiguity-safe clipboard formatting', () => {
    expect(shortIdentityRef(`briefing:${'a'.repeat(64)}`)).toBe('briefing:aaaaaaa');
    expect(shortIdentityRef(`artifact-version:${'b'.repeat(32)}`)).toBe('artifact-version:bbbbbbb');
    expect(shortIdentityRef(`artifact-series:${'d'.repeat(32)}`)).toBe('artifact-series:ddddddd');
    expect(shortIdentityRef('artifact-series:bbbbbbbbbbbb0')).toBe('artifact-series:bbbbbbbbbbbb0');
    expect(shortIdentityRef('01a01639-5f21-7c61-8623-42636a39fd49')).toBe('01a01639');
    expect(shortIdentityRef(`mandible/${'c'.repeat(64)}`)).toBe('mandible/ccccccc');
  });

  it('allows an identity-free compact title row without rendering retired copy chrome', () => {
    render(
      <DetailPaneHeader
        variant="compact"
        title="Identity-free compact title"
        menu={<button type="button">More</button>}
      />,
    );

    const header = document.querySelector('.detail-pane-header--compact') as HTMLElement;
    expect(header.querySelector('.detail-pane-header__topline')).toBeNull();
    expect(header.querySelector('.detail-pane-header__identity')).toBeNull();
    expect(header.querySelector('.ledger-copy-ref-button')).toBeNull();
    expect(within(header).getByRole('heading', { name: 'Identity-free compact title' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: 'More' })).toBeTruthy();
  });


  it('renders exact two-row versioned geometry with optional entity label and typed copy authority', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    const logicalCanonicalRef = 'artifact:art_01KABCDEF0123456789';
    const selectedCanonicalRef = 'artifact-version:av_01K9876543210FEDCBA';

    render(
      <DetailPaneHeader
        variant="versioned"
        identity={{
          displayRef: '12ab34c',
          canonicalRef: logicalCanonicalRef,
        }}
        title="SISU results"
        supportingMetadata={<span>managed · report · Updated today</span>}
        state={<span>Latest</span>}
        selector={{
          label: 'Artifact version',
          control: <select aria-label="Artifact version"><option>v3</option></select>,
          selectedCanonicalRef,
        }}
        actions={<button type="button" aria-label="Artifact actions">...</button>}
      />,
    );

    const header = document.querySelector('.detail-pane-header--versioned') as HTMLElement;
    const main = header.querySelector(':scope > .detail-pane-header__main') as HTMLElement;
    const rows = Array.from(main.children);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.classList.contains('detail-pane-header__topline')).toBe(true);
    expect(rows[1]?.classList.contains('detail-pane-header__title-row')).toBe(true);
    expect(rows[0]?.querySelector(':scope > .detail-pane-header__identity')).toBeTruthy();
    expect(rows[0]?.querySelector(':scope > .detail-pane-header__topline-controls')).toBeTruthy();
    expect(rows[1]?.querySelector(':scope > .detail-pane-header__title-block > .detail-pane-header__title')).toBeTruthy();
    expect(rows[1]?.querySelector('.detail-pane-header__supporting-metadata')?.textContent).toContain('Updated today');
    expect(rows[1]?.querySelector(':scope > .detail-pane-header__actions')).toBeTruthy();
    expect(within(header).queryByText('Artifact')).toBeNull();
    expect(within(header).getByText('12ab34c')).toBeTruthy();
    expect(within(header).getByText('Latest')).toBeTruthy();
    expect(header.textContent).not.toContain(logicalCanonicalRef);
    expect(header.textContent).not.toContain(selectedCanonicalRef);
    const selectorControl = header.querySelector('.detail-pane-header__selector-control') as HTMLElement;
    expect(selectorControl.firstElementChild).toBe(within(header).getByRole('combobox', { name: 'Artifact version' }));
    expect(selectorControl.nextElementSibling).toBe(within(header).getByRole('button', {
      name: 'Copy selected artifact version reference',
    }));

    fireEvent.click(within(header).getByRole('button', { name: 'Copy reference' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('artifact:art_01kabcde'));
    fireEvent.click(within(header).getByRole('button', {
      name: 'Copy selected artifact version reference',
    }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('artifact-version:av_01K9876543'));

    const css = readFileSync(resolve(process.cwd(), 'ui/src/styles/detail-pane-shell.css'), 'utf8');
    const versionedSelectRule = css.match(/\.detail-pane-header--versioned \.detail-pane-header__selector-control select\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(versionedSelectRule).toMatch(/height:\s*30px;/);
    expect(versionedSelectRule).toMatch(/max-width:\s*180px;/);
    expect(versionedSelectRule).not.toMatch(/(?:background|border|color|font|padding|appearance|outline)\s*:/);
  });


});

describe('shared collapsible panel', () => {
  it('places the canonical disclosure chevron directly after a normal-case subdued title', () => {
    const onExpandedChange = vi.fn();
    render(
      <CollapsiblePanel title="Commit message" expanded={false} onExpandedChange={onExpandedChange}>
        Hidden body
      </CollapsiblePanel>,
    );

    const toggle = screen.getByRole('button', { name: 'Commit message' });
    expect(toggle.children[0]?.textContent).toBe('Commit message');
    expect(toggle.children[1]?.getAttribute('data-disclosure-chevron')).toBe('right');
    expect(document.querySelector('.collapsible-panel__body')).toBeNull();
    fireEvent.click(toggle);
    expect(onExpandedChange).toHaveBeenCalledWith(true);

    const css = readFileSync(resolve(process.cwd(), 'ui/src/styles/collapsible-panel.css'), 'utf8');
  });
});
