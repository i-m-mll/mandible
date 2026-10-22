// @vitest-environment jsdom
// Add-to-Space affordance tests (umbrella de56ffa, child 08c312a).
//
// Covers the shared AddToSpace picker (issue/artifact/graph surfaces) and the
// IssueDetail action-gating flip: the menu must appear on an otherwise
// read-only issue pane once `onAddToSpace` is provided.

import { render, screen, cleanup, fireEvent, waitFor } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only the API helpers the picker touches; everything else in the module
// is re-exported types or unrelated helpers.
const listSpaces = vi.fn();
const listSpacesGrouped = vi.fn();
const addSpaceItem = vi.fn();
vi.mock('../ui/src/api', async (importActual) => {
  const actual = await importActual<typeof import('../ui/src/api')>();
  return {
    ...actual,
    listSpaces: (...args: unknown[]) => listSpaces(...args),
    listSpacesGrouped: (...args: unknown[]) => listSpacesGrouped(...args),
    addSpaceItem: (...args: unknown[]) => addSpaceItem(...args),
  };
});

import { AddToSpace, type AddToSpaceTarget } from '../ui/src/components/spaces/AddToSpace';

function makeSpace(id: string, title: string) {
  return {
    id,
    project_id: 'proj-1',
    title,
    default_renderer: 'collection' as const,
    description: null,
    metadata: {},
    created_at: 0,
    updated_at: 0,
  };
}

const issueTarget: AddToSpaceTarget = { ref_type: 'issue', ref_id: 'issue-1', title: 'An issue' };

beforeEach(() => {
  listSpaces.mockReset();
  listSpacesGrouped.mockReset();
  addSpaceItem.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('AddToSpace picker', () => {
  it('adds every target for a multi-select pick', async () => {
    listSpaces.mockResolvedValue([makeSpace('s1', 'Roadmap')]);
    addSpaceItem.mockResolvedValue({ item: { id: 'i1' }, created: true, already_present: false });
    const targets: AddToSpaceTarget[] = [
      { ref_type: 'issue', ref_id: 'a' },
      { ref_type: 'artifact', ref_id: 'b' },
    ];
    render(<AddToSpace projectId="proj-1" targets={targets} includeCrossProject={false} />);

    fireEvent.click(screen.getByTestId('add-to-space').querySelector('button')!);
    fireEvent.click(await screen.findByText('Roadmap'));

    await waitFor(() => expect(addSpaceItem).toHaveBeenCalledTimes(2));
    expect(addSpaceItem).toHaveBeenNthCalledWith(1, 's1', expect.objectContaining({ ref_id: 'a' }));
    expect(addSpaceItem).toHaveBeenNthCalledWith(2, 's1', expect.objectContaining({ ref_id: 'b' }));
  });

  it('surfaces a failure without crashing', async () => {
    listSpaces.mockResolvedValue([makeSpace('s1', 'Roadmap')]);
    addSpaceItem.mockRejectedValue(new Error('boom'));
    render(<AddToSpace projectId="proj-1" targets={[issueTarget]} includeCrossProject={false} />);

    fireEvent.click(screen.getByTestId('add-to-space').querySelector('button')!);
    fireEvent.click(await screen.findByText('Roadmap'));

    const feedback = await screen.findByTestId('add-to-space-feedback');
    expect(feedback.textContent).toContain('boom');
  });
});

describe('AddToSpace cross-project (default)', () => {
  function groupedFixture() {
    return [
      { project_id: null, project_key: null, project_name: null, spaces: [makeSpace('t1', 'Global')] },
      { project_id: 'proj-1', project_key: 'alpha', project_name: 'Alpha', spaces: [makeSpace('s1', 'Roadmap')] },
      { project_id: 'proj-2', project_key: 'beta', project_name: 'Beta', spaces: [makeSpace('s2', 'Beta board')] },
    ];
  }

  it('adds an item to a Space in a different project', async () => {
    listSpacesGrouped.mockResolvedValue(groupedFixture());
    addSpaceItem.mockResolvedValue({ item: { id: 'i1' }, created: true, already_present: false });
    render(<AddToSpace projectId="proj-1" targets={[issueTarget]} />);

    fireEvent.click(screen.getByTestId('add-to-space').querySelector('button')!);
    fireEvent.click(await screen.findByText('Beta board'));
    await waitFor(() => expect(addSpaceItem).toHaveBeenCalledWith('s2', expect.objectContaining({ ref_id: 'issue-1' })));
  });
});
