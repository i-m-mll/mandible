// Shared <ViewSidebar> container tests (issue e29a8c5).
//
// Covers the container contract: renders frame + resize handle, returns null
// (and drops the handle) when hidden, reads the per-view storageKey width,
// renders the headerless single-block vs. header/body variant, and forwards
// containerRef to the frame element.
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRef } from 'preact';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ViewSidebar } from '../ui/src/components/ViewSidebar';

// jsdom in this build ships a localStorage stub whose setItem throws; install a
// working in-memory localStorage so width persistence round-trips.
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mem, configurable: true, writable: true });
}

beforeEach(() => {
  installMemoryLocalStorage();
});

afterEach(() => {
  cleanup();
});

describe('ViewSidebar', () => {
  it('renders the frame with its content className, aria-label, and a resize handle', () => {
    const { container } = render(
      <ViewSidebar storageKey="sidebar-width:test" defaultWidth={420} minWidth={280} ariaLabel="Issues" className="issues-tree" as="div">
        <div data-testid="body">content</div>
      </ViewSidebar>,
    );
    const frame = container.querySelector('.view-sidebar');
    expect(frame).toBeTruthy();
    // content class applied alongside the shared class
    expect(frame!.classList.contains('issues-tree')).toBe(true);
    expect(frame!.getAttribute('aria-label')).toBe('Issues');
    expect(screen.getByTestId('body')).toBeTruthy();

    const handle = container.querySelector('.view-sidebar__resize-handle');
    expect(handle).toBeTruthy();
    expect(handle!.classList.contains('sidebar-drag-handle')).toBe(true);
    expect(handle!.getAttribute('role')).toBe('separator');
    expect(handle!.getAttribute('aria-orientation')).toBe('vertical');
    expect((handle as HTMLElement).tabIndex).toBe(0);
  });

  it('honors the as prop for the frame tag (div vs default aside)', () => {
    const { container, rerender } = render(
      <ViewSidebar storageKey="sidebar-width:t1" defaultWidth={300} minWidth={200} ariaLabel="Spaces" as="div">
        <div>x</div>
      </ViewSidebar>,
    );
    expect(container.querySelector('div.view-sidebar')).toBeTruthy();

    rerender(
      <ViewSidebar storageKey="sidebar-width:t1" defaultWidth={300} minWidth={200} ariaLabel="Graph controls">
        <div>x</div>
      </ViewSidebar>,
    );
    expect(container.querySelector('aside.view-sidebar')).toBeTruthy();
  });

  it('returns null when hidden, rendering neither the frame nor the handle', () => {
    const { container } = render(
      <ViewSidebar hidden storageKey="sidebar-width:test" defaultWidth={420} minWidth={280} ariaLabel="Issues">
        <div data-testid="body">content</div>
      </ViewSidebar>,
    );
    expect(container.querySelector('.view-sidebar')).toBeNull();
    expect(container.querySelector('.view-sidebar__resize-handle')).toBeNull();
    expect(screen.queryByTestId('body')).toBeNull();
  });

  it('reads the persisted width from its storageKey', () => {
    localStorage.setItem('sidebar-width:issues', '512');
    const { container } = render(
      <ViewSidebar storageKey="sidebar-width:issues" defaultWidth={420} minWidth={280} ariaLabel="Issues" as="div">
        <div>content</div>
      </ViewSidebar>,
    );
    const frame = container.querySelector('.view-sidebar') as HTMLElement;
    expect(frame.style.width).toBe('512px');
  });

  it('renders single-block children when no header is provided', () => {
    const { container } = render(
      <ViewSidebar storageKey="sidebar-width:t2" defaultWidth={420} minWidth={280} ariaLabel="Issues" as="div">
        <div data-testid="block">block</div>
      </ViewSidebar>,
    );
    // No header/body wrappers in the headerless variant.
    expect(container.querySelector('.view-sidebar__header')).toBeNull();
    expect(container.querySelector('.view-sidebar__body')).toBeNull();
    expect(screen.getByTestId('block')).toBeTruthy();
  });

  it('renders header + body wrappers when a header slot is provided', () => {
    const { container } = render(
      <ViewSidebar
        storageKey="sidebar-width:t3"
        defaultWidth={300}
        minWidth={220}
        ariaLabel="Spaces"
        as="div"
        header={<div data-testid="hdr">header</div>}
      >
        <div data-testid="scroll">scroll body</div>
      </ViewSidebar>,
    );
    const header = container.querySelector('.view-sidebar__header');
    const body = container.querySelector('.view-sidebar__body');
    expect(header).toBeTruthy();
    expect(body).toBeTruthy();
    expect(header!.contains(screen.getByTestId('hdr'))).toBe(true);
    expect(body!.contains(screen.getByTestId('scroll'))).toBe(true);
  });

  it('keyboard ArrowRight/ArrowLeft resize the sidebar directly and persist the clamped width', () => {
    // window.innerWidth in jsdom is 1024 → 50% clamp = 512.
    localStorage.setItem('sidebar-width:issues', '420');
    const { container } = render(
      <ViewSidebar storageKey="sidebar-width:issues" defaultWidth={420} minWidth={280} ariaLabel="Issues" as="div">
        <div>content</div>
      </ViewSidebar>,
    );
    const frame = container.querySelector('.view-sidebar') as HTMLElement;
    const handle = container.querySelector('.view-sidebar__resize-handle') as HTMLElement;
    expect(frame.style.width).toBe('420px');

    // ArrowRight (+8) widens and persists; no synthetic mouse events involved.
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(frame.style.width).toBe('428px');
    expect(localStorage.getItem('sidebar-width:issues')).toBe('428');

    // Shift+ArrowLeft uses the larger 32px step.
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(frame.style.width).toBe('396px');
    expect(localStorage.getItem('sidebar-width:issues')).toBe('396');

    // Clamps to minWidth (280): many big steps left can't go below the min.
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(parseInt(frame.style.width, 10)).toBe(280);
    expect(localStorage.getItem('sidebar-width:issues')).toBe('280');
  });

  // The runtime cascade bug (issue e29a8c5) is a source-order override of
  // `.view-sidebar__resize-handle` by the later equal-specificity
  // `.sidebar-drag-handle`. jsdom cannot compute the full cascade, so this only
  // guards the selector SHAPE; CDP (headless Chrome getComputedStyle +
  // getBoundingClientRect) is the real verification — see the issue's CDP run.
  it('uses a higher-specificity two-class selector for the resize handle (cascade guard)', () => {
    const css = readFileSync(join(process.cwd(), 'ui/src/style.css'), 'utf8');
    // The winning rule must be the two-class form, pinned to the right edge.
    expect(css).toMatch(/\.view-sidebar__resize-handle\.sidebar-drag-handle\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.view-sidebar__resize-handle\.sidebar-drag-handle\s*\{[^}]*right:\s*0/);
    // The old single-class positioning rule (which lost to source order) is gone.
    expect(css).not.toMatch(/(^|\n)\s*\.view-sidebar__resize-handle\s*\{[^}]*position:\s*absolute/);
  });

  it('forwards containerRef to the frame element', () => {
    const ref = createRef<HTMLElement>();
    const { container } = render(
      <ViewSidebar
        storageKey="sidebar-width:t4"
        defaultWidth={300}
        minWidth={220}
        ariaLabel="Spaces"
        as="div"
        containerRef={ref}
      >
        <div>x</div>
      </ViewSidebar>,
    );
    const frame = container.querySelector('.view-sidebar');
    expect(ref.current).toBe(frame);
    // The ref contract Spaces relies on: containerRef.current.contains(child).
    const child = container.querySelector('.view-sidebar__resize-handle')!;
    expect(ref.current!.contains(child)).toBe(true);
  });
});
