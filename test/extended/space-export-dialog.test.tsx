// Component tests for the Space export dialog (child f7be021).
//
// Acceptance criteria covered here (custody-doc §5):
//   - The dialog resolves the global-default + per-repo-override path from the
//     backend (`getSpaceExports`) and lets the user confirm or override it.
//   - The explicit export posts the CONFIRMED path to `exportSpaceTracked`; a
//     per-export override can be persisted as the per-repo default.
//   - Re-exporting the SAME document to the SAME confirmed path is surfaced as an
//     idempotent in-place refresh (idempotency against C13b).
//   - There is NO auto-track affordance: export only fires on an explicit submit.
//   - UI-state-persistence (standing AC #2): the user's confirmed path/message
//     persists per-Space across remounts.

import { screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { render } from './notice-test-render';

const getSpaceExportsMock = vi.fn();
const exportSpaceTrackedMock = vi.fn();
const setSpaceExportSettingsMock = vi.fn();

vi.mock('../../ui/src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ui/src/api')>();
  return {
    ...actual,
    getSpaceExports: (...args: unknown[]) => getSpaceExportsMock(...args),
    exportSpaceTracked: (...args: unknown[]) => exportSpaceTrackedMock(...args),
    setSpaceExportSettings: (...args: unknown[]) => setSpaceExportSettingsMock(...args),
  };
});

import { SpaceExportDialog } from '../../ui/src/views/spaces/SpaceExportDialog';
import { exportDialogStorageKey } from '../../ui/src/views/spaces/exportDialogState';
import type { InstanceInfo } from '../../ui/src/api';

const copiedPreview: InstanceInfo = {
  role: 'preview',
  instance_id: 'preview-1',
  installation_id: 'install-1',
  public_origin: 'http://localhost:19420',
  backend_generation: 'test-generation',
  allowed_effects: ['ledger:read', 'ledger:write', 'files:preview'],
  writable_roots: ['/tmp/mandible-preview'],
  db_path: '/tmp/mandible-preview/mandible.db',
  db_path_source: 'iab-preview-copy',
};

// jsdom's localStorage in this config is a partial stub; install a full
// Map-backed shim (matching the spaces-document-renderer test) so per-Space view
// state persistence is exercised end to end.
function stubLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    },
  });
}

function settingsResult(overrides: Record<string, unknown> = {}) {
  return {
    exports: [],
    repo_id: 'repo-1',
    settings: { path: 'docs/spaces/space-1.md', branch: 'docs/main', overridden: false },
    ...overrides,
  };
}

function exportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exp-1',
    space_id: 'space-1',
    repo_id: 'repo-1',
    branch: 'docs/main',
    path: 'docs/spaces/space-1.md',
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
    ...overrides,
  };
}

beforeEach(() => {
  getSpaceExportsMock.mockReset();
  exportSpaceTrackedMock.mockReset();
  setSpaceExportSettingsMock.mockReset();
  stubLocalStorage();
  getSpaceExportsMock.mockResolvedValue(settingsResult());
  exportSpaceTrackedMock.mockResolvedValue({
    export: exportRow(),
    document_content_sha256: 'sha',
    commit: 'abc123',
    pre_export_snapshot_artifact_id: 'art-pre',
    last_export_artifact_id: 'art-last',
  });
  setSpaceExportSettingsMock.mockResolvedValue({ ok: true, scope: 'repo', repo_id: 'repo-1' });
});

afterEach(() => {
  cleanup();
});

describe('SpaceExportDialog', () => {
  it('resolves and displays the default export path from the backend', async () => {
    render(<SpaceExportDialog spaceId="space-1" projectId="proj-1" issues={['7be021']} />);
    await waitFor(() => expect(getSpaceExportsMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('export-default-path').textContent).toContain(
        'docs/spaces/space-1.md',
      ),
    );
    // With no override the effective path equals the resolved default.
    expect(screen.getByTestId('export-effective-path-value').textContent).toBe(
      'docs/spaces/space-1.md',
    );
  });

  it('posts the confirmed default path to exportSpaceTracked on explicit submit', async () => {
    render(<SpaceExportDialog spaceId="space-1" projectId="proj-1" issues={['7be021']} />);
    await waitFor(() => expect(screen.getByTestId('export-submit')).toBeTruthy());

    fireEvent.click(screen.getByTestId('export-submit'));

    await waitFor(() => expect(exportSpaceTrackedMock).toHaveBeenCalledTimes(1));
    const [spaceId, body] = exportSpaceTrackedMock.mock.calls[0];
    expect(spaceId).toBe('space-1');
    expect(body.path).toBe('docs/spaces/space-1.md');
    expect(body.issues).toEqual(['7be021']);
    expect(body.branch).toBe('docs/main');
    // No settings write when the resolved default was used unchanged.
    expect(setSpaceExportSettingsMock).not.toHaveBeenCalled();
  });

  it('exports to a per-export override path and can persist it as the per-repo default', async () => {
    render(<SpaceExportDialog spaceId="space-1" projectId="proj-1" issues={['7be021']} />);
    await waitFor(() => expect(screen.getByTestId('export-path-input')).toBeTruthy());

    const input = screen.getByTestId('export-path-input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'docs/custom/readme.md' } });

    // The override-default checkbox only appears once the path diverges.
    const saveDefault = await screen.findByTestId('export-save-default');
    fireEvent.click(saveDefault);

    fireEvent.click(screen.getByTestId('export-submit'));

    await waitFor(() => expect(exportSpaceTrackedMock).toHaveBeenCalledTimes(1));
    expect(exportSpaceTrackedMock.mock.calls[0][1].path).toBe('docs/custom/readme.md');
    // The explicit save-as-default fires the per-repo settings write.
    await waitFor(() => expect(setSpaceExportSettingsMock).toHaveBeenCalledTimes(1));
    expect(setSpaceExportSettingsMock.mock.calls[0][0]).toMatchObject({
      repo_id: 'repo-1',
      path: 'docs/custom/readme.md',
    });
  });

  it('surfaces an existing tracked export at the target path as an idempotent re-export', async () => {
    getSpaceExportsMock.mockResolvedValue(settingsResult({ exports: [exportRow({ status: 'clean' })] }));
    render(<SpaceExportDialog spaceId="space-1" projectId="proj-1" issues={['7be021']} />);

    await waitFor(() => expect(screen.getByTestId('export-idempotent-hint')).toBeTruthy());
    expect(screen.getByTestId('export-submit').textContent).toContain('Re-export');
  });

  it('blocks export when no linked issue is available (no commit trailer possible)', async () => {
    render(<SpaceExportDialog spaceId="space-1" projectId="proj-1" issues={[]} />);
    await waitFor(() => expect(screen.getByTestId('export-no-issue')).toBeTruthy());
    expect((screen.getByTestId('export-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('export-submit'));
    expect(exportSpaceTrackedMock).not.toHaveBeenCalled();
  });

  it('saves a copied-preview path setting locally while blocking repository export', async () => {
    render(
      <SpaceExportDialog
        spaceId="space-1"
        projectId="proj-1"
        issues={['7be021']}
        instance={copiedPreview}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('export-path-input')).toBeTruthy());

    fireEvent.input(screen.getByTestId('export-path-input') as HTMLInputElement, {
      target: { value: 'docs/copied-preview.md' },
    });
    fireEvent.click(await screen.findByTestId('export-save-default'));

    expect((await screen.findByTestId('export-preview-disabled')).textContent)
      .toContain('cannot write to the configured repository');
    expect((screen.getByTestId('export-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('export-submit'));
    expect(exportSpaceTrackedMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('export-save-default-submit'));
    await waitFor(() => expect(setSpaceExportSettingsMock).toHaveBeenCalledWith({
      repo_id: 'repo-1',
      path: 'docs/copied-preview.md',
    }));
    expect((await screen.findByTestId('export-settings-saved')).textContent)
      .toContain('saved in this instance');
    expect(exportSpaceTrackedMock).not.toHaveBeenCalled();
  });

  it('persists the confirmed path/message per-Space across remounts (UI-state AC)', async () => {
    const { unmount } = render(
      <SpaceExportDialog spaceId="space-1" projectId="proj-1" issues={['7be021']} />,
    );
    await waitFor(() => expect(screen.getByTestId('export-path-input')).toBeTruthy());
    fireEvent.input(screen.getByTestId('export-path-input') as HTMLInputElement, {
      target: { value: 'docs/persisted.md' },
    });
    fireEvent.input(screen.getByTestId('export-message-input') as HTMLInputElement, {
      target: { value: 'my message' },
    });

    await waitFor(() => {
      const raw = window.localStorage.getItem(exportDialogStorageKey('proj-1', 'space-1'));
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string).path).toBe('docs/persisted.md');
    });

    unmount();
    cleanup();

    render(<SpaceExportDialog spaceId="space-1" projectId="proj-1" issues={['7be021']} />);
    await waitFor(() =>
      expect((screen.getByTestId('export-path-input') as HTMLInputElement).value).toBe(
        'docs/persisted.md',
      ),
    );
    expect((screen.getByTestId('export-message-input') as HTMLInputElement).value).toBe(
      'my message',
    );
  });
});
