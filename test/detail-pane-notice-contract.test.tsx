import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import { DetailPaneNotice } from '../ui/src/components/shared/DetailPaneNotice';
import { DetailPaneShell } from '../ui/src/components/shared/DetailPaneShell';

afterEach(() => {
  cleanup();
  document.head.querySelector('[data-test-detail-pane-notice-styles]')?.remove();
});

const inventory = {
  anchored: [
    'ui/src/components/console/TerminalPane.tsx',
    'ui/src/views/auth.tsx',
    'ui/src/views/conversations.tsx',
    'ui/src/views/spaces/SpacesViewShell.tsx',
    'ui/src/views/timeline.tsx',
  ],
  contentLocal: [
    'ui/src/components/console/PtyBanner.tsx',
    'ui/src/views/artifacts.tsx',
    'ui/src/views/feedback/BriefingDocumentPanel.tsx',
    'ui/src/views/spaces/DocumentBlockEditor.tsx',
    'ui/src/views/work.tsx',
  ],
} as const;

describe('typed anchored detail and main notice contract', () => {
  it.each([
    ['info', 'status', 'polite'],
    ['success', 'status', 'polite'],
    ['warning', 'status', 'polite'],
    ['error', 'alert', 'assertive'],
  ] as const)('maps %s severity to %s semantics', (severity, role, live) => {
    render(<DetailPaneNotice severity={severity}>Notice body</DetailPaneNotice>);
    const notice = screen.getByText('Notice body').closest('.detail-pane-notice');
    expect(notice?.getAttribute('data-severity')).toBe(severity);
    expect(notice?.getAttribute('role')).toBe(role);
    expect(notice?.getAttribute('aria-live')).toBe(live);
  });

  it('wraps content and composes accessible actions inside the shared boundary', () => {
    render(
      <DetailPaneNotice
        severity="warning"
        title="Copied preview"
        actions={<button type="button">Review source</button>}
      >
        A deliberately long notice body that may wrap independently from its action.
      </DetailPaneNotice>,
    );

    const notice = screen.getByRole('status');
    expect(notice.querySelector('.detail-pane-notice__content')?.textContent)
      .toContain('A deliberately long notice body');
    expect(notice.querySelector('.detail-pane-notice__actions')
      ?.contains(screen.getByRole('button', { name: 'Review source' }))).toBe(true);
  });

  it('renders one anchored shell slot between header/subheader and the scroll-owned body', () => {
    const { container } = render(
      <DetailPaneShell
        header={<span>Header</span>}
        subheader={<span>Subheader</span>}
        notice={<DetailPaneNotice severity="warning">Anchored</DetailPaneNotice>}
        footer={{ content: <span>Footer</span> }}
      >
        <span>Scrollable</span>
      </DetailPaneShell>,
    );
    const shell = container.querySelector('.detail-pane-shell');
    const slots = Array.from(shell?.children ?? []).map((element) => element.getAttribute('data-detail-pane-slot'));
    expect(slots).toEqual(['header', 'notice', 'body', 'footer']);
    const notice = shell?.querySelector(':scope > .detail-pane-shell__notice');
    const body = shell?.querySelector(':scope > .detail-pane-shell__body');
    expect(notice?.contains(body ?? null)).toBe(false);
    expect(body?.contains(notice ?? null)).toBe(false);
  });

  it('has one bottom border, no top border, compact geometry, and scroll independence in real CSS', () => {
    const style = document.createElement('style');
    style.dataset.testDetailPaneNoticeStyles = '';
    style.textContent = [
      ':root { --status-danger-fg: rgb(255, 0, 0); --status-danger-bg-soft: rgb(20, 0, 0); --status-danger-border-soft: rgb(100, 0, 0); }',
      readFileSync(resolve(process.cwd(), 'ui/src/components/shared/DetailPaneNotice.css'), 'utf8'),
      readFileSync(resolve(process.cwd(), 'ui/src/styles/detail-pane-shell.css'), 'utf8'),
    ].join('\n');
    document.head.append(style);
    const { container } = render(
      <DetailPaneShell
        variant="compact"
        header={<span>Header</span>}
        notice={<DetailPaneNotice severity="error" density="compact">Source unavailable</DetailPaneNotice>}
      >
        Scrollable
      </DetailPaneShell>,
    );
    const boundary = container.querySelector('.detail-pane-shell__notice')!;
    const notice = container.querySelector('.detail-pane-notice')!;
    const body = container.querySelector('.detail-pane-shell__body')!;
    const boundaryStyle = getComputedStyle(boundary);
    const noticeStyle = getComputedStyle(notice);
    const bodyStyle = getComputedStyle(body);
    expect(getComputedStyle(container.querySelector('.detail-pane-shell')!).overflow).toBe('clip');
    expect(boundaryStyle.flexShrink).toBe('0');
    expect(bodyStyle.position).toBe('relative');
    expect(bodyStyle.overflowY).toBe('auto');
    expect(noticeStyle.borderTopWidth).toBe('0px');
    expect(noticeStyle.borderBottomWidth).toBe('1px');
    expect(noticeStyle.paddingTop).toBe('8px');
    expect(noticeStyle.paddingRight).toBe('18px');
  });

  it('keeps the explicit structural inventory on the one shared road', () => {
    const sourceRoot = resolve(process.cwd(), 'ui/src');
    const discoveredAnchored = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
      .map((entry) => resolve(entry.parentPath, entry.name))
      .filter((path) => /<DetailPaneNotice(?:\s|>)/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(process.cwd().length + 1))
      .sort();
    expect(discoveredAnchored).toEqual([...inventory.anchored].sort());

    for (const path of inventory.anchored) {
      expect(readFileSync(resolve(process.cwd(), path), 'utf8'), path).toContain('<DetailPaneNotice');
    }
    for (const path of inventory.contentLocal) {
      expect(readFileSync(resolve(process.cwd(), path), 'utf8'), path).not.toContain('<DetailPaneNotice');
    }

    const pavedRoads = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(tsx|css)$/.test(entry.name))
      .map((entry) => resolve(entry.parentPath, entry.name))
      .filter((path) => /PreviewDisabledNotice|preview-disabled-notice|conv-load-error|timeline-sync-banner|terminal-pane__inbox-banner|auth-detail--with-preview-notice/.test(readFileSync(path, 'utf8')));
    expect(pavedRoads).toEqual([]);
  });

  it('keeps one canonical DetailPaneShell notice boundary implementation', () => {
    const sourceRoot = resolve(process.cwd(), 'ui/src');
    const boundaries = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
      .map((entry) => resolve(entry.parentPath, entry.name))
      .flatMap((path) => Array.from(
        readFileSync(path, 'utf8').matchAll(/data-detail-pane-slot="notice"/g),
        () => path.slice(process.cwd().length + 1),
      ));
    expect(boundaries).toEqual(['ui/src/components/shared/DetailPaneShell.tsx']);
  });
});
