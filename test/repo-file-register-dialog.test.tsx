// Component tests for the repo-file registration dialog (child f7be021).
//
// Acceptance criteria covered here (custody-doc §1.4):
//   - An existing tracked repo file can be registered as a document with link
//     custody: the dialog posts (repo, ref, path) to `registerRepoFileDocument`.
//   - The recorded source is a `repo://<repo>@<ref>/<path>` ref (previewed in the
//     UI and produced by the backend glue this dialog targets).
//   - Registration is an explicit user action — no auto-register affordance: the
//     register POST only fires on an explicit submit, and is disabled without a
//     path.

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

const registerRepoFileDocumentMock = vi.fn();

vi.mock('../ui/src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/src/api')>();
  return {
    ...actual,
    registerRepoFileDocument: (...args: unknown[]) => registerRepoFileDocumentMock(...args),
  };
});

import {
  RepoFileRegisterDialog,
  previewRepoSourceRef,
} from '../ui/src/views/spaces/RepoFileRegisterDialog';

beforeEach(() => {
  registerRepoFileDocumentMock.mockReset();
  registerRepoFileDocumentMock.mockResolvedValue({
    export: {
      id: 'exp-1',
      space_id: 'space-1',
      repo_id: 'repo-1',
      branch: 'main',
      path: 'docs/design.md',
      authority: 'repo',
      status: 'clean',
      last_export_artifact_id: null,
      pre_export_snapshot_artifact_id: null,
      last_export_commit: null,
      last_export_blob_sha: null,
      last_export_content_sha256: null,
      last_seen_commit: null,
      last_seen_content_sha256: null,
      created_at: 1,
      updated_at: 1,
    },
    source_ref: 'repo://repo-1@main/docs/design.md',
  });
});

afterEach(() => {
  cleanup();
});

describe('previewRepoSourceRef', () => {
  it('builds a repo://<repo>@<ref>/<path> ref and normalizes the path', () => {
    expect(previewRepoSourceRef('repo-1', 'main', '/docs/design.md')).toBe(
      'repo://repo-1@main/docs/design.md',
    );
  });

  it('omits the ref segment when no branch is given', () => {
    expect(previewRepoSourceRef('repo-1', '', 'docs/design.md')).toBe(
      'repo://repo-1/docs/design.md',
    );
  });

  it('returns null without a path (nothing to register yet)', () => {
    expect(previewRepoSourceRef('repo-1', 'main', '   ')).toBeNull();
  });
});

describe('RepoFileRegisterDialog', () => {
  it('registers an existing repo file with authority=repo link custody on explicit submit', async () => {
    const onRegistered = vi.fn();
    render(
      <RepoFileRegisterDialog
        spaceId="space-1"
        repoId="repo-1"
        defaultBranch="main"
        onRegistered={onRegistered}
      />,
    );

    fireEvent.input(screen.getByTestId('register-path-input') as HTMLInputElement, {
      target: { value: 'docs/design.md' },
    });

    // The source-ref preview reflects the repo://<repo>@<ref>/<path> the backend
    // will record (custody-doc §1.4).
    await waitFor(() =>
      expect(screen.getByTestId('register-source-preview').textContent).toContain(
        'repo://repo-1@main/docs/design.md',
      ),
    );

    fireEvent.click(screen.getByTestId('register-submit'));

    await waitFor(() => expect(registerRepoFileDocumentMock).toHaveBeenCalledTimes(1));
    const [spaceId, body] = registerRepoFileDocumentMock.mock.calls[0];
    expect(spaceId).toBe('space-1');
    expect(body).toMatchObject({ repo_id: 'repo-1', branch: 'main', path: 'docs/design.md' });

    await waitFor(() => expect(onRegistered).toHaveBeenCalledTimes(1));
    expect(onRegistered.mock.calls[0][0].export.authority).toBe('repo');
  });

  it('disables register and never posts without a path (no auto-register)', () => {
    render(<RepoFileRegisterDialog spaceId="space-1" repoId="repo-1" />);
    expect((screen.getByTestId('register-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('register-submit'));
    expect(registerRepoFileDocumentMock).not.toHaveBeenCalled();
  });

  it('surfaces a registration failure without throwing', async () => {
    registerRepoFileDocumentMock.mockRejectedValue(new Error('file not tracked'));
    render(<RepoFileRegisterDialog spaceId="space-1" repoId="repo-1" defaultBranch="main" />);
    fireEvent.input(screen.getByTestId('register-path-input') as HTMLInputElement, {
      target: { value: 'docs/missing.md' },
    });
    fireEvent.click(screen.getByTestId('register-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('register-error').textContent).toContain('file not tracked'),
    );
  });
});
