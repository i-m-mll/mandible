import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DetailPaneHeader } from '../ui/src/components/shared/DetailPaneHeader.js';
import { DetailPaneShell } from '../ui/src/components/shared/DetailPaneShell.js';
import { shortIdentityRef } from '../ui/src/identity-refs.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.head.querySelector('[data-test-compact-header-styles]')?.remove();
});

describe('canonical detail pane header', () => {
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

  it('keeps a long compact title, its menu, and fixed metadata in semantic DOM order', () => {
    const style = document.createElement('style');
    style.dataset.testCompactHeaderStyles = '';
    style.textContent = readFileSync(resolve(process.cwd(), 'ui/src/styles/detail-pane-shell.css'), 'utf8')
      .replaceAll('var(--app-header-height)', '48px');
    document.head.append(style);

    const longTitle = 'A very long compact detail title that must truncate before displacing fixed metadata';
    render(
      <DetailPaneHeader
        variant="compact"
        title={longTitle}
        titleTooltip={longTitle}
        menuLabel="Conversation detail actions"
        menu={<button type="button" aria-label="Conversation actions">...</button>}
        metadata={<span data-testid="compact-metadata">Codex · Resumable</span>}
      />,
    );

    const header = document.querySelector('.detail-pane-header--compact') as HTMLElement;
    const main = header.querySelector(':scope > .detail-pane-header__main') as HTMLElement;
    const titleRow = main.firstElementChild as HTMLElement;
    const title = within(header).getByRole('heading', { name: longTitle });
    const menu = within(header).getByRole('group', { name: 'Conversation detail actions' });
    const metadata = within(header).getByTestId('compact-metadata');
    expect(titleRow.classList.contains('detail-pane-header__title-row')).toBe(true);
    expect(title.nextElementSibling).toBe(menu);
    expect(titleRow.nextElementSibling?.classList.contains('detail-pane-header__compact-metadata')).toBe(true);
    expect(titleRow.nextElementSibling?.contains(metadata)).toBe(true);

    const headerStyle = getComputedStyle(header);
    const mainStyle = getComputedStyle(main);
    const metadataStyle = getComputedStyle(titleRow.nextElementSibling!);
    expect(headerStyle.height).toBe('48px');
    expect(mainStyle.height).toBe('100%');
    expect(mainStyle.flexDirection).toBe('row');
    expect(mainStyle.alignItems).toBe('center');
    expect(metadataStyle.marginLeft).toBe('auto');
    expect(metadataStyle.flex).toBe('0 0 auto');

    const css = readFileSync(resolve(process.cwd(), 'ui/src/styles/detail-pane-shell.css'), 'utf8');
    expect(css).toMatch(/\.detail-pane-header--compact \.detail-pane-header__main\s*\{[^}]*display:\s*flex;/s);
    expect(css).toMatch(/\.detail-pane-header--compact \.detail-pane-header__title-row\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-width:\s*0;/s);
    expect(css).toMatch(/\.detail-pane-header--compact \.detail-pane-header__compact-metadata\s*\{[^}]*flex:\s*none;[^}]*margin-left:\s*auto;/s);
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
    expect(css).toMatch(/\.detail-pane-header--versioned \.detail-pane-header__topline\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s);
    expect(css).toMatch(/\.detail-pane-header--versioned \.detail-pane-header__topline-controls\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*flex-end;/s);
    expect(css).toMatch(/\.detail-pane-header--versioned \.detail-pane-header__state\s*\{[^}]*color:\s*var\(--text-muted\);/s);
    expect(css).toMatch(/\.detail-pane-header--versioned \.detail-pane-header__selector-control select\s*\{[^}]*height:\s*30px;[^}]*max-width:\s*180px;[^}]*border:\s*1px solid var\(--neutral-alpha-10\);[^}]*border-radius:\s*999px;[^}]*padding:\s*0 30px 0 12px;[^}]*background:\s*var\(--bg-card\);[^}]*color:\s*var\(--text-secondary\);[^}]*font:\s*12px\/1\.2 var\(--font-sans\);/s);
    expect(css).toMatch(/\.detail-pane-header--versioned \.detail-pane-header__title-row\s*\{[^}]*justify-content:\s*space-between;/s);
  });

  it('gives nested compact composition one padding owner at exact app-header height without changing the legacy seam', () => {
    const { container } = render(
      <DetailPaneShell
        variant="compact"
        header={(
          <DetailPaneHeader
            variant="compact"
            identity={{
              entityLabel: 'Conversation',
              displayRef: '01a01639',
              canonicalRef: '01a01639-6146-77c1-8616-6878ae755367',
            }}
            title="Canonical compact header"
          />
        )}
      >
        Compact body
      </DetailPaneShell>,
    );
    const primary = container.querySelector('.detail-pane-shell__header-primary');
    expect(primary?.querySelector(':scope > .detail-pane-header--compact')).toBeTruthy();

    const css = readFileSync(resolve(process.cwd(), 'ui/src/styles/detail-pane-shell.css'), 'utf8');
    expect(css).toMatch(/\.detail-pane-shell--compact \.detail-pane-shell__header-primary\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*48px;[^}]*padding:\s*8px 18px;/s);
    expect(css).toMatch(/\.detail-pane-shell--compact\s+\.detail-pane-shell__header-primary:has\(> \.detail-pane-header--compact\)\s*\{[^}]*display:\s*block;[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*padding:\s*0;/s);
    expect(css).toMatch(/\.detail-pane-header--compact\s*\{[^}]*height:\s*var\(--app-header-height\);[^}]*min-height:\s*var\(--app-header-height\);[^}]*padding:\s*0 18px;/s);
  });

  it('enforces truncation, responsive behavior, focus, and coarse-pointer targets in shared CSS', () => {
    const css = readFileSync(resolve(process.cwd(), 'ui/src/styles/detail-pane-shell.css'), 'utf8');
    expect(css).toMatch(/\.detail-pane-header__display-ref\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
    expect(css).toMatch(/\.detail-pane-header--compact \.detail-pane-header__title\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
    expect(css).toMatch(/\.detail-pane-header :is\(button, select, a\):focus-visible\s*\{[^}]*outline:/s);
    expect(css).toMatch(/@media \(max-width:\s*720px\)/);
    expect(css).toMatch(/@media \(pointer:\s*coarse\)\s*\{[^}]*\.detail-pane-header :is\(button, select, a\)\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/s);
  });
});

describe('detail pane composition migration boundary', () => {
  it('rejects DetailPaneShell consumers that bypass the canonical header', () => {
    const sourcePaths = readdirSync(resolve(process.cwd(), 'ui/src'), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
      .map((entry) => `ui/src/${entry.parentPath.slice(resolve(process.cwd(), 'ui/src').length + 1)}/${entry.name}`)
      .map((path) => path.replace('/./', '/'));
    const bespokeConsumers = sourcePaths.filter((path) => {
      const source = readFileSync(resolve(process.cwd(), path), 'utf8');
      return source.includes('<DetailPaneShell') && !source.includes('<DetailPaneHeader');
    });

    expect(bespokeConsumers).toEqual([]);
  });

  it('keeps the canonical component free of nested headers and raw canonical identity text', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'ui/src/components/shared/DetailPaneHeader.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/<header\b/);
    expect(source.match(/<DetailHeaderIdentity\b/g)).toHaveLength(1);
    expect(source).toContain('CopyRefButton');
  });
});
