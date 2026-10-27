// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from './helpers/dom';
import { AppHoverTips, appTip } from '../ui/src/components/shared/AppHoverTips';
import { installNativeTopBarDragging } from '../ui/src/native-top-bar';
import { NativeTopBarBand } from '../ui/src/components/NativeTopBarBand';

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('shows one shared fast tip for disabled controls and keyboard focus, preserving existing descriptions', async () => {
  render(<><AppHoverTips /><button disabled {...appTip('Back')}>Back</button><button aria-describedby="existing" {...appTip('Open menu')}>Menu</button></>);
  const back = screen.getByRole('button', { name: 'Back' });
  act(() => back.dispatchEvent(new Event('pointerover', { bubbles: true })));
  await screen.findByRole('tooltip');
  expect(screen.getByRole('tooltip').textContent).toBe('Back');
  expect(back.hasAttribute('disabled')).toBe(true);
  expect(back.hasAttribute('title')).toBe(false);
  const menu = screen.getByRole('button', { name: 'Menu' });
  act(() => menu.focus());
  await screen.findByText('Open menu', { selector: '[role=tooltip]' });
  expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  expect(screen.getByRole('tooltip').textContent).toBe('Open menu');
  expect(menu.getAttribute('aria-describedby')).toBe('existing app-hover-tip');
  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(menu.getAttribute('aria-describedby')).toBe('existing');
});

it('delegates one native drag from nested header decorations and the invisible splash band while preserving controls', () => {
  const drag = vi.fn().mockResolvedValue(undefined);
  const remove = installNativeTopBarDragging(document, drag);
  const { container } = render(<><header data-native-drag-boundary><h2><span data-label>Title</span></h2><svg><path /></svg><button><span>Action</span></button><input /><span contentEditable>Editable</span></header><NativeTopBarBand /></>);
  for (const target of container.querySelectorAll('h2 span,svg path,header,.app-native-top-bar-band')) fireEvent.mouseDown(target, { button: 0 });
  expect(drag).toHaveBeenCalledTimes(4);
  for (const target of container.querySelectorAll('button span,input,[contenteditable]')) fireEvent.mouseDown(target, { button: 0 });
  expect(drag).toHaveBeenCalledTimes(4);
  fireEvent.mouseDown(container.querySelector('h2')!, { button: 2 });
  expect(drag).toHaveBeenCalledTimes(4);
  remove(); fireEvent.mouseDown(container.querySelector('header')!, { button: 0 });
  expect(drag).toHaveBeenCalledTimes(4);
});
