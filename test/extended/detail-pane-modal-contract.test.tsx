import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { useRef, useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DetailPaneModal } from '../../ui/src/components/shared/DetailPaneModal';
import { DetailPaneShell } from '../../ui/src/components/shared/DetailPaneShell';

function rect(top: number, right: number, bottom: number, left: number): DOMRect {
  return {
    x: left,
    y: top,
    top,
    right,
    bottom,
    left,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DetailPaneModal shell contract', () => {
  it('inherits the shell body bounds, excludes the header, preserves scroll, and keeps close controls hittable', async () => {
    const close = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function paneRect() {
      if (this.classList.contains('detail-pane-shell__header')) return rect(40, 1080, 180, 320);
      if (this.classList.contains('detail-pane-shell__body')) return rect(180, 1080, 720, 320);
      return rect(0, 0, 0, 0);
    });
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <DetailPaneShell
          header={<span>Anchored header</span>}
          overlays={(
            <DetailPaneModal
              open={open}
              onClose={() => { close(); setOpen(false); }}
              titleId="shell-modal-title"
              title="Shell metadata"
              closeLabel="Close shell metadata"
            >
              <button type="button">Panel control</button>
            </DetailPaneModal>
          )}
        >
          <button type="button" onClick={() => setOpen(true)}>Open shell metadata</button>
        </DetailPaneShell>
      );
    }

    render(<Harness />);
    const body = document.querySelector('.detail-pane-shell__body') as HTMLElement;
    body.scrollTop = 144;
    fireEvent.click(screen.getByRole('button', { name: 'Open shell metadata' }));

    const dialog = await screen.findByRole('dialog', { name: 'Shell metadata' });
    const host = document.querySelector('[data-detail-pane-overlay-host]') as HTMLElement;
    expect(host.contains(dialog)).toBe(true);
    expect((dialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-top')).toBe('180px');
    expect((dialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-left')).toBe('320px');
    expect((dialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-right')).toBe('200px');
    expect((dialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-bottom')).toBe('80px');
    expect(body.classList.contains('detail-pane-shell__body--overlay-open')).toBe(true);

    body.scrollTop = 300;
    fireEvent.scroll(body);
    expect(body.scrollTop).toBe(144);
    fireEvent.pointerDown(within(dialog).getByRole('button', { name: 'Close shell metadata' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close shell metadata' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Shell metadata' })).toBeNull());
    expect(close).toHaveBeenCalledTimes(1);
    expect(body.scrollTop).toBe(144);
    expect(body.classList.contains('detail-pane-shell__body--overlay-open')).toBe(false);
  });

  it('keeps an explicit embedded fallback pane-scoped and closes on outside click and Escape', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function embeddedRect() {
      if (this.classList.contains('embedded-detail')) return rect(60, 1180, 740, 720);
      if (this.classList.contains('embedded-header')) return rect(60, 1180, 196, 720);
      return rect(0, 0, 0, 0);
    });
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 760, configurable: true });

    function EmbeddedHarness() {
      const [open, setOpen] = useState(false);
      const ownerRef = useRef<HTMLElement>(null);
      const headerRef = useRef<HTMLElement>(null);
      return (
        <aside className="embedded-detail" ref={ownerRef}>
          <header className="embedded-header" ref={headerRef}>Embedded header</header>
          <button type="button" onClick={() => setOpen(true)}>Open embedded metadata</button>
          <DetailPaneModal
            open={open}
            onClose={() => setOpen(false)}
            titleId="embedded-modal-title"
            title="Embedded metadata"
            closeLabel="Close embedded metadata"
            embeddedFallback={{ excludeAboveRef: headerRef, scrollOwnerRef: ownerRef }}
          >
            <span>Embedded content</span>
          </DetailPaneModal>
        </aside>
      );
    }

    render(<EmbeddedHarness />);
    const owner = document.querySelector('.embedded-detail') as HTMLElement;
    owner.scrollTop = 96;
    fireEvent.click(screen.getByRole('button', { name: 'Open embedded metadata' }));
    let dialog = await screen.findByRole('dialog', { name: 'Embedded metadata' });
    expect((dialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-top')).toBe('196px');
    expect((dialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-left')).toBe('720px');
    expect((dialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-right')).toBe('20px');
    expect((dialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-bottom')).toBe('20px');
    expect(owner.scrollTop).toBe(96);

    fireEvent(document, new Event('pointerdown', { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Embedded metadata' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Open embedded metadata' }));
    dialog = await screen.findByRole('dialog', { name: 'Embedded metadata' });
    expect(dialog).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Embedded metadata' })).toBeNull());
    expect(owner.scrollTop).toBe(96);
  });
});
