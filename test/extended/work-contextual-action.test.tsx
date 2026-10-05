import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';

import { BranchRow } from '../../ui/src/views/work';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps the row ellipsis contextual while focus and an open menu persist it', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, right: 24, bottom: 24, left: 0,
    width: 24, height: 24, toJSON: () => ({}),
  } as DOMRect);
  render(
    <table>
      <tbody>
        <BranchRow
          branch={{ name: 'feature/contextual', status: 'clean', last_commit_message: 'Contextual work' }}
          repoId="r1"
          defaultBranch="main"
          expanded={new Set()}
          onToggle={() => undefined}
        />
      </tbody>
    </table>,
  );

  const trigger = screen.getByRole('button', { name: 'Branch actions' });
  const group = trigger.closest('.work-actions') as HTMLElement;
  const row = trigger.closest('tr') as HTMLElement;
  expect(trigger.classList.contains('contextual-action')).toBe(true);
  expect(group.classList.contains('contextual-action-group')).toBe(true);
  expect(row.classList.contains('contextual-action-owner')).toBe(true);
  expect(trigger.closest('td')?.classList.contains('contextual-action-scope')).toBe(true);

  trigger.focus();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(group.classList.contains('contextual-action-group--persistent')).toBe(true);
  expect(screen.getByRole('menu')).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Copy branch name' })).toBeTruthy();

});
