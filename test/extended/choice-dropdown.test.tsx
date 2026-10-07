import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { useRef, useState } from 'preact/hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { ChoiceDropdown } from '../../ui/src/components/shared/ChoiceDropdown';
import { useAnchoredMenu } from '../../ui/src/hooks/useAnchoredMenu';

afterEach(cleanup);
const choices = ['Low', 'Medium', 'High'].map(label => ({ value: label.toLowerCase(), label }));

it('navigates choices, selects with the keyboard, and restores focus without changing the accessible name', () => {
  const change = vi.fn();
  render(<ChoiceDropdown label="Thinking effort" prompt="Select effort" value="medium" choices={choices} onChange={change} />);
  const trigger = screen.getByRole('button', { name: 'Thinking effort' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  expect(trigger.textContent).toBe('Select effort');
  expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Medium' }));
  expect(screen.getByRole('option', { name: 'Medium' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(document.activeElement!, { key: 'End' });
  expect(document.activeElement).toBe(screen.getByRole('option', { name: 'High' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Low' }));
  fireEvent.keyDown(document.activeElement!, { key: 'm' });
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
  fireEvent.keyDown(document.activeElement!, { key: ' ' });
  expect(change).toHaveBeenCalledExactlyOnceWith('low');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('dismisses without selection on Escape, outside pointer, and focus departure; disabled choices stay closed', async () => {
  const change = vi.fn();
  const view = render(<><ChoiceDropdown label="Model" prompt="Select model" value="medium" choices={choices} onChange={change} /><button>Outside</button></>);
  const trigger = screen.getByRole('button', { name: 'Model' });
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(document.activeElement).toBe(trigger);
  expect(trigger.textContent).toBe('Medium');
  fireEvent.click(trigger);
  screen.getByRole('button', { name: 'Outside' }).dispatchEvent(new Event('pointerdown', { bubbles: true }));
  await vi.waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  fireEvent.click(trigger);
  screen.getByRole('button', { name: 'Outside' }).focus();
  await vi.waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  expect(change).not.toHaveBeenCalled();
  view.rerender(<ChoiceDropdown label="Model" prompt="Select model" value="medium" choices={choices} disabled onChange={change} />);
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
});

function NestedMenu() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredMenu({ open, anchorRef, menuRef, onDismiss: () => setOpen(false) });
  return <><button ref={anchorRef} onClick={() => setOpen(true)}>Run options</button>{open && <div ref={menuRef} role="dialog" popover="manual" className="app-anchored-menu" style={style}>
    <ChoiceDropdown label="Model" prompt="Select model" value="medium" choices={choices} onChange={() => {}} />
  </div>}</>;
}

it('closes the nested dropdown before the containing run-options menu on Escape', () => {
  render(<NestedMenu />);
  fireEvent.click(screen.getByRole('button', { name: 'Run options' }));
  const trigger = screen.getByRole('button', { name: 'Model' });
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Run options' }));
});
