// @vitest-environment jsdom
import { installMemoryLocalStorage, previewInstance, mainInstance, render } from './helpers/ui-workspace-fixture';
import { act, cleanup, fireEvent, screen, waitFor } from './helpers/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'preact/hooks';
import { useChromeAppearancePreview } from '../ui/src/hooks/useChromeAppearancePreview';
import { PreviewAppearanceTools } from '../ui/src/components/preview/PreviewAppearanceTools';

function Harness({ instance = previewInstance }) {
  const preview = useChromeAppearancePreview(instance, 'light', true);
  const [count, setCount] = useState(0);
  return <div className="app-shell"><button onClick={() => setCount(value => value + 1)}>Underlying action {count}</button>
    <PreviewAppearanceTools instance={instance} controller={preview.controller} />
  </div>;
}
const panelKey = `mandible.preview-appearance-panel.v1:${previewInstance.instance_id}`;
const pointer = (node: Element, type: string, x: number, y: number) => {
  const event = new Event(type.replace(/pointer(.)/, (_, initial: string) => 'Pointer' + initial.toUpperCase()), { bubbles: true });
  Object.assign(event, { pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y });
  fireEvent(node, event);
};
let captured = false;
beforeEach(() => {
  installMemoryLocalStorage();
  captured = false;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const panel = this.classList.contains('preview-appearance-panel');
    const x = panel ? Number.parseFloat(this.style.left) : 500;
    const y = panel ? Number.parseFloat(this.style.top) : 700;
    const width = panel ? Number.parseFloat(this.style.width) : 28;
    const height = panel ? this.dataset.collapsed === 'true' ? 40 : Math.min(500, innerHeight - 16) : 28;
    return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() {} };
  });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.closest('[hidden]') ? [] : [this.getBoundingClientRect()]) as unknown as DOMRectList;
  });
  HTMLElement.prototype.setPointerCapture = () => { captured = true; };
  HTMLElement.prototype.hasPointerCapture = () => captured;
  HTMLElement.prototype.releasePointerCapture = () => { captured = false; };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('keeps the app interactive and retains independent appearance and panel intent through drag, collapse, close and remount', async () => {
  const { container, rerender, unmount } = render(<Harness />);
  const trigger = screen.getByRole('button', { name: 'Preview appearance' });
  fireEvent.click(trigger);
  const handle = screen.getByRole('button', { name: 'Move preview appearance' });
  expect(document.activeElement).toBe(handle);
  const initial = screen.getByRole('dialog');
  const initialPosition = { left: initial.style.left, top: initial.style.top };
  fireEvent.click(screen.getByRole('button', { name: 'Collapse preview appearance' }));
  expect({ left: initial.style.left, top: initial.style.top }).toEqual(initialPosition);
  fireEvent.click(screen.getByRole('button', { name: 'Expand preview appearance' }));
  fireEvent.input(screen.getByLabelText('UI font size value'), { target: { value: '3.75' } });
  fireEvent.click(screen.getByRole('button', { name: 'Underlying action 0' }));
  expect(screen.getByRole('button', { name: 'Underlying action 1' })).toBeTruthy();
  const panel = screen.getByRole('dialog', { name: 'Preview appearance' });
  pointer(handle, 'pointerdown', 500, 500);
  expect(captured).toBe(true);
  pointer(handle, 'pointermove', 5000, 5000);
  pointer(handle, 'pointerup', 5000, 5000);
  expect(captured).toBe(false);
  expect(panel.getBoundingClientRect().right).toBeLessThanOrEqual(innerWidth - 8);
  expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight - 8);
  const stored = JSON.parse(localStorage.getItem(panelKey)!);
  expect(stored.position).toEqual({ x: Number.parseFloat(panel.style.left), y: Number.parseFloat(panel.style.top) });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse preview appearance' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Expand preview appearance' }));
  fireEvent.change(screen.getByLabelText('Move panel to corner'), { target: { value: 'bottom-right' } });
  fireEvent.click(screen.getByRole('button', { name: 'Expand preview appearance' }));
  expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight - 8);
  fireEvent.keyDown(handle, { key: 'ArrowLeft' });
  expect(Number.parseFloat(panel.style.left)).toBeLessThan(stored.position.x);
  fireEvent.keyDown(screen.getByLabelText('Preview theme'), { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBe(panel);
  fireEvent.keyDown(handle, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button', { name: 'Collapse preview appearance' }));
  rerender(<Harness instance={{ ...previewInstance, instance_id: 'another-preview' }} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  rerender(<Harness />);
  expect(container.querySelector('.preview-appearance-panel')?.getAttribute('data-collapsed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Expand preview appearance' }));
  expect((screen.getByLabelText('UI font size value') as HTMLInputElement).value).toBe('3.75');
  unmount();
  render(<Harness />);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect((screen.getByLabelText('UI font size value') as HTMLInputElement).value).toBe('3.75');
});

it('suspends for visible app modals without changing open intent or taking focus, ignores inactive modals, and excludes production', async () => {
  const { container, rerender } = render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview appearance' }));
  const layer = container.querySelector<HTMLElement>('.preview-appearance-layer')!;
  const inactive = document.createElement('div');
  inactive.hidden = true;
  inactive.innerHTML = '<div aria-modal="true" role="dialog"><input></div>';
  act(() => document.body.append(inactive));
  await waitFor(() => expect(layer.hidden).toBe(false));
  const handle = screen.getByRole('button', { name: 'Move preview appearance' });
  pointer(handle, 'pointerdown', 500, 500);
  expect(captured).toBe(true);
  const modal = document.createElement('div');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = '<input aria-label="Modal input">';
  act(() => { document.body.append(modal); modal.querySelector('input')!.focus(); });
  await waitFor(() => expect(layer.hidden).toBe(true));
  expect(captured).toBe(false);
  expect(JSON.parse(localStorage.getItem(panelKey)!).open).toBe(true);
  expect(document.activeElement).toBe(modal.querySelector('input'));
  const underlying = screen.getByRole('button', { name: 'Underlying action 0' });
  act(() => { modal.remove(); underlying.focus(); });
  await waitFor(() => expect(layer.hidden).toBe(false));
  expect(document.activeElement).toBe(underlying);
  fireEvent.keyDown(underlying, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  inactive.remove();
  rerender(<Harness instance={mainInstance} />);
  expect(screen.queryByRole('button', { name: 'Preview appearance' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});
