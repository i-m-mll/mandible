import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DetailPaneHeader } from '../ui/src/components/shared/DetailPaneHeader.js';
import { DetailPaneShell } from '../ui/src/components/shared/DetailPaneShell.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('canonical detail pane header', () => {
  it('renders standard semantics while keeping the full canonical ref copy-only', async () => {
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
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(canonicalRef));
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
    expect(within(header).getByRole('combobox', { name: 'Artifact version' })).toBeTruthy();
    expect(header.textContent).not.toContain(selectedCanonicalRef);

    fireEvent.click(within(header).getByRole('button', {
      name: 'Copy selected artifact-version reference',
    }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(selectedCanonicalRef));
  });

  it('gives nested compact composition one padding owner without changing the legacy seam', () => {
    const { container } = render(
      <DetailPaneShell
        variant="compact"
        header={(
          <DetailPaneHeader
            variant="compact"
            identity={{
              entityLabel: 'Conversation',
              displayRef: 'conv:12ab34c',
              canonicalRef: 'conversation:conv_01KABCDEF0123456789',
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
    expect(css).toMatch(/\.detail-pane-shell--compact\s+\.detail-pane-shell__header-primary:has\(> \.detail-pane-header--compact\)\s*\{[^}]*display:\s*block;[^}]*min-height:\s*0;[^}]*padding:\s*0;/s);
    expect(css).toMatch(/\.detail-pane-header--compact\s*\{[^}]*padding:\s*8px 18px;/s);
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
  const stage2Allowlist: Record<string, string> = {
    'ui/src/components/ledger/IssueDetail.tsx': 'ffc0f5c',
    'ui/src/views/auth.tsx': 'ffc0f5c',
    'ui/src/views/artifacts.tsx': 'e3b9289',
    'ui/src/views/feedback/BriefingDocumentRenderer.tsx': 'e3b9289',
    'ui/src/views/conversations.tsx': '79661b6',
  };

  it('allows bespoke shell headers only on explicit Stage 2 migration paths', () => {
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

    for (const path of bespokeConsumers) {
      expect(stage2Allowlist[path], `${path} needs an explicit Stage 2 owner`).toMatch(/^[0-9a-f]{7}$/);
    }
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
