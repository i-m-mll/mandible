// Component tests for the Space seed dialog (child 27a5026).
//
// Acceptance criteria covered here:
//   - The seed dialog posts the SHARED predicate JSON to the C2 `/seed` endpoint
//     (via `seedSpace`); the predicate shape matches the shared filter module.
//   - The graph-selection seed reads the relationship/issue source through the
//     BACKEND graph endpoint (`getGraph`), never a direct UI DB read, and turns
//     the selection into the same predicate AST.
//   - The "label X" and "saved filter" seeds build the shared predicate shape.

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the typed api client so we can assert the exact POST body and confirm the
// graph read goes through the backend helper (not any UI-side DB access).
const seedSpaceMock = vi.fn();
const getGraphMock = vi.fn();

vi.mock('../ui/src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/src/api')>();
  return {
    ...actual,
    seedSpace: (...args: unknown[]) => seedSpaceMock(...args),
    getGraph: (...args: unknown[]) => getGraphMock(...args),
  };
});

import { SpaceSeedDialog } from '../ui/src/views/spaces/SpaceSeedDialog';

beforeEach(() => {
  seedSpaceMock.mockReset();
  getGraphMock.mockReset();
  seedSpaceMock.mockResolvedValue({
    matched_issue_ids: [],
    items: [],
    items_created: 0,
    items_existing: 0,
    occurrences: [],
    diagnostics: [],
  });
  getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
});

afterEach(() => {
  cleanup();
});

describe('SpaceSeedDialog', () => {
  it('posts the shared filter predicate to /seed via seedSpace', async () => {
    render(<SpaceSeedDialog spaceId="space-1" projectId="proj-1" />);
    // Default source is the saved-filter composer; add a chip token.
    fireEvent.click(screen.getByTestId('seed-source-filter'));
    const input = screen.getByPlaceholderText('label:auth -kind:unknown') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'label:auth' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    fireEvent.click(screen.getByTestId('seed-submit'));

    await waitFor(() => expect(seedSpaceMock).toHaveBeenCalledTimes(1));
    const [spaceId, body] = seedSpaceMock.mock.calls[0];
    expect(spaceId).toBe('space-1');
    // Shared predicate shape: a single label predicate (field `predicate`).
    expect(body.predicate).toEqual({ type: 'label', name: 'auth' });
    expect(body.include_artifacts).toBe(true);
    expect(body.with_shelf_occurrences).toBe(true);
  });

  it('reads graph selection from the BACKEND graph endpoint and seeds the selection predicate', async () => {
    getGraphMock.mockResolvedValue({
      nodes: [
        {
          id: 'issue:repo:abc',
          type: 'issue',
          label: 'Issue A',
          detail: { ledger_issue_id: 'ledger-abc', project_id: 'proj-1' },
          summary: { issue_id: 'abc' },
        },
        {
          id: 'issue:repo:def',
          type: 'issue',
          label: 'Issue B',
          detail: { ledger_issue_id: 'ledger-def', project_id: 'proj-1' },
          summary: { issue_id: 'def' },
        },
        // A non-issue node must be ignored by the picker.
        { id: 'session:1', type: 'session', label: 'Session', detail: {}, summary: {} },
      ],
      edges: [],
    });

    render(<SpaceSeedDialog spaceId="space-4" projectId="proj-1" repo="mandible" />);
    fireEvent.click(screen.getByTestId('seed-source-graph'));

    // The dialog must fetch through the backend graph helper, not a UI DB read.
    await waitFor(() => expect(getGraphMock).toHaveBeenCalledTimes(1));
    expect(getGraphMock.mock.calls[0][0]).toMatchObject({ repo: 'mandible' });

    // Only issue nodes are offered.
    await waitFor(() => expect(screen.getByTestId('seed-graph-node-issue:repo:abc')).toBeTruthy());
    expect(screen.queryByTestId('seed-graph-node-session:1')).toBeNull();

    fireEvent.click(screen.getByTestId('seed-graph-node-issue:repo:abc'));
    fireEvent.click(screen.getByTestId('seed-graph-node-issue:repo:def'));
    fireEvent.click(screen.getByTestId('seed-submit'));

    await waitFor(() => expect(seedSpaceMock).toHaveBeenCalledTimes(1));
    // Selection maps to an `or` of parent_subtree over the ledger issue ids.
    expect(seedSpaceMock.mock.calls[0][1].predicate).toEqual({
      type: 'or',
      predicates: [
        { type: 'parent_subtree', issue_id: 'ledger-abc' },
        { type: 'parent_subtree', issue_id: 'ledger-def' },
      ],
    });
  });
});
