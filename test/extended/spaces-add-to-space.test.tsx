// Add-to-Space affordance tests (umbrella de56ffa, child 08c312a).
//
// Covers the shared AddToSpace picker (issue/artifact/graph surfaces) and the
// IssueDetail action-gating flip: the menu must appear on an otherwise
// read-only issue pane once `onAddToSpace` is provided.

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


// Mock only the API helpers the picker touches; everything else in the module
// is re-exported types or unrelated helpers.
const listSpaces = vi.fn();
const listSpacesGrouped = vi.fn();
const addSpaceItem = vi.fn();
vi.mock('../../ui/src/api', async (importActual) => {
  const actual = await importActual<typeof import('../../ui/src/api')>();
  return {
    ...actual,
    listSpaces: (...args: unknown[]) => listSpaces(...args),
    listSpacesGrouped: (...args: unknown[]) => listSpacesGrouped(...args),
    addSpaceItem: (...args: unknown[]) => addSpaceItem(...args),
  };
});

import { AddToSpace, type AddToSpaceTarget } from '../../ui/src/components/spaces/AddToSpace';
import { LedgerIssueDetail } from '../../ui/src/components/ledger/IssueDetail';
import type { LedgerIssueDetailProjection } from '../../ui/src/api';

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

  it('disables the trigger when no project context is available', () => {
    render(<AddToSpace projectId={null} targets={[issueTarget]} />);
    const trigger = screen.getByTestId('add-to-space').querySelector('button')!;
    expect(trigger.disabled).toBe(true);
    expect(listSpaces).not.toHaveBeenCalled();
  });

  it('disables the trigger when there are no targets', () => {
    render(<AddToSpace projectId="proj-1" targets={[]} />);
    const trigger = screen.getByTestId('add-to-space').querySelector('button')!;
    expect(trigger.disabled).toBe(true);
  });

  it('lists the project Spaces only after the popover is opened', async () => {
    listSpaces.mockResolvedValue([makeSpace('s1', 'Roadmap'), makeSpace('s2', 'Backlog')]);
    render(<AddToSpace projectId="proj-1" targets={[issueTarget]} includeCrossProject={false} />);
    expect(listSpaces).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Add to Space'));
    await waitFor(() => expect(listSpaces).toHaveBeenCalledWith('proj-1'));
    expect(await screen.findByText('Roadmap')).toBeTruthy();
    expect(screen.getByText('Backlog')).toBeTruthy();
  });

  it('adds the target to the chosen Space and reports the outcome', async () => {
    listSpaces.mockResolvedValue([makeSpace('s1', 'Roadmap')]);
    addSpaceItem.mockResolvedValue({ item: { id: 'i1' }, created: true, already_present: false });
    const onAdded = vi.fn();
    render(<AddToSpace projectId="proj-1" targets={[issueTarget]} onAdded={onAdded} includeCrossProject={false} />);

    fireEvent.click(screen.getByText('Add to Space'));
    const option = await screen.findByText('Roadmap');
    fireEvent.click(option);

    await waitFor(() => expect(addSpaceItem).toHaveBeenCalledWith('s1', {
      ref_type: 'issue',
      ref_id: 'issue-1',
      ref_uri: null,
      title: 'An issue',
    }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('add-to-space-feedback')).toBeTruthy();
  });

  it('adds every target for a multi-select pick', async () => {
    listSpaces.mockResolvedValue([makeSpace('s1', 'Roadmap')]);
    addSpaceItem.mockResolvedValue({ item: { id: 'i1' }, created: true, already_present: false });
    const targets: AddToSpaceTarget[] = [
      { ref_type: 'issue', ref_id: 'a' },
      { ref_type: 'artifact', ref_id: 'b' },
    ];
    render(<AddToSpace projectId="proj-1" targets={targets} includeCrossProject={false} />);

    fireEvent.click(screen.getByText(/Add to Space/));
    fireEvent.click(await screen.findByText('Roadmap'));

    await waitFor(() => expect(addSpaceItem).toHaveBeenCalledTimes(2));
    expect(addSpaceItem).toHaveBeenNthCalledWith(1, 's1', expect.objectContaining({ ref_id: 'a' }));
    expect(addSpaceItem).toHaveBeenNthCalledWith(2, 's1', expect.objectContaining({ ref_id: 'b' }));
  });

  it('surfaces a failure without crashing', async () => {
    listSpaces.mockResolvedValue([makeSpace('s1', 'Roadmap')]);
    addSpaceItem.mockRejectedValue(new Error('boom'));
    render(<AddToSpace projectId="proj-1" targets={[issueTarget]} includeCrossProject={false} />);

    fireEvent.click(screen.getByText('Add to Space'));
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

  it('lists spaces from multiple projects grouped with the own project first', async () => {
    listSpacesGrouped.mockResolvedValue(groupedFixture());
    render(<AddToSpace projectId="proj-1" targets={[issueTarget]} />);

    fireEvent.click(screen.getByText('Add to Space'));
    await waitFor(() => expect(listSpacesGrouped).toHaveBeenCalled());
    // It uses the grouped read, NOT the single-project read.
    expect(listSpaces).not.toHaveBeenCalled();

    // Own project (Alpha) renders first, then top-level, then other projects.
    const popover = await screen.findByTestId('add-to-space-popover');
    const sectionOrder = Array.from(popover.querySelectorAll('[data-testid^="add-to-space-section-"]')).map(
      (el) => el.getAttribute('data-testid'),
    );
    expect(sectionOrder[0]).toBe('add-to-space-section-proj-1');
    expect(sectionOrder).toContain('add-to-space-section-__top_level__');
    expect(sectionOrder).toContain('add-to-space-section-proj-2');

    expect(screen.getByText('Roadmap')).toBeTruthy();
    expect(screen.getByText('Global')).toBeTruthy();
    expect(screen.getByText('Beta board')).toBeTruthy();
  });

  it('adds an item to a Space in a different project', async () => {
    listSpacesGrouped.mockResolvedValue(groupedFixture());
    addSpaceItem.mockResolvedValue({ item: { id: 'i1' }, created: true, already_present: false });
    render(<AddToSpace projectId="proj-1" targets={[issueTarget]} />);

    fireEvent.click(screen.getByText('Add to Space'));
    fireEvent.click(await screen.findByText('Beta board'));
    await waitFor(() => expect(addSpaceItem).toHaveBeenCalledWith('s2', expect.objectContaining({ ref_id: 'issue-1' })));
  });
});

function readOnlyDetail(): LedgerIssueDetailProjection {
  return {
    id: 'ledger-issue-1',
    display_id: '08c312a',
    project: {
      id: 'proj-1',
      display_name: 'mandible',
      remote_identity: '',
      upstream_identity: '',
      repo_id: 'mandible',
      repo_name: 'mandible',
      repo_root: null,
      default_branch: 'main',
    },
    title: 'Read-only issue',
    body: 'No body actions',
    status: 'open',
    resolution: null,
    kind: 'feature',
    priority: 'unknown',
    source: 'mandible',
    created_at: 0,
    updated_at: 0,
    closed_at: null,
    author: { id: null, type: 'mandible_user', display: 'Mandible' },
    labels: [],
    aliases: [],
    comments: [],
    relationships: [],
    sessions: [],
    work_units: [],
    auth_requests: [],
    associated_artifacts: [],
    timeline: [],
    checkpoints: [],
  } as unknown as LedgerIssueDetailProjection;
}

describe('IssueDetail Add-to-Space gating', () => {
  it('shows no actions menu on a read-only pane without onAddToSpace', () => {
    render(<LedgerIssueDetail detail={readOnlyDetail()} />);
    expect(screen.queryByLabelText('Issue actions')).toBeNull();
  });

  it('flips hasIssueActions and exposes "Add to Space" when onAddToSpace is provided', () => {
    const onAddToSpace = vi.fn();
    render(<LedgerIssueDetail detail={readOnlyDetail()} onAddToSpace={onAddToSpace} />);
    const trigger = screen.getByLabelText('Issue actions');
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    const item = screen.getByText('Add to Space');
    fireEvent.click(item);
    expect(onAddToSpace).toHaveBeenCalledTimes(1);
  });
});
