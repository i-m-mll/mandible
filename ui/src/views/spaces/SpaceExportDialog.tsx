// Space export dialog (umbrella de56ffa, C13f / issue f7be021).
//
// Custody-doc §5: committing a Space document to a repo is ALWAYS an explicit
// user action. This dialog is that action's surface. It:
//   - reads the resolved export settings (global default + per-repo override) +
//     the existing tracking rows via `getSpaceExports`,
//   - lets the user CONFIRM the resolved default path or OVERRIDE it per-export,
//   - optionally persists the chosen path as the per-repo override,
//   - posts the explicit export-and-track via `exportSpaceTracked` (custody-doc
//     §3) — re-exporting the SAME doc to the SAME path is idempotent (§5.2).
//
// Boundaries (sibling-ownership / non-goals from issue f7be021):
//   - No export/commit backend here (C13b owns `export-and-track`); this dialog
//     only resolves the path and posts the explicit user confirm.
//   - No drift logic here (C13c owns drift); the dialog only DISPLAYS the
//     existing row's status as confirm context.
//   - There is NO auto-track / auto-commit affordance: every export is a manual,
//     explicit user submit (custody-doc §5).
//
// Per the Dataful-UX rule the dialog is browser-local view state: the only
// canonical mutations are the explicit user-triggered settings + export POSTs.
// The user's last-confirmed path/message is persisted per-Space (./exportDialogState).

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';

import {
  getSpaceExports,
  exportSpaceTracked,
  setSpaceExportSettings,
  type SpaceExportSettings,
  type SpaceExport,
  type ExportAndTrackResult,
} from '../../api';
import {
  readExportDialogState,
  writeExportDialogState,
  type ExportDialogViewState,
} from './exportDialogState';
import './SpaceExportDialog.css';

export type SpaceExportDialogProps = {
  /** The Space being exported; posts to `/api/spaces/:spaceId/exports`. */
  spaceId: string;
  /** Project scope (used for per-Space dialog view-state persistence). */
  projectId: string;
  /** Explicit project-checkout id; defaults to the Space's project checkout. */
  repoId?: string;
  /**
   * Issue refs for ledger links to the exported commit. At least one is
   * required for a tracked export's linked commit (custody-doc §3 step 3).
   */
  issues?: string[];
  /** Called after a successful export-and-track with the C13b result. */
  onExported?: (result: ExportAndTrackResult) => void;
  /** Dismiss the dialog without exporting. */
  onClose?: () => void;
};

/** Normalize a repo-relative path for display + idempotency comparison. */
function normalizePathForCompare(input: string): string {
  return input.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

export function SpaceExportDialog({
  spaceId,
  projectId,
  repoId,
  issues = [],
  onExported,
  onClose,
}: SpaceExportDialogProps): JSX.Element {
  // Resolved settings + existing rows from the backend (the source of truth for
  // the global default + per-repo override; custody-doc §5.1).
  const [settings, setSettings] = useState<SpaceExportSettings | null>(null);
  const [resolvedRepoId, setResolvedRepoId] = useState<string | null>(null);
  const [existing, setExisting] = useState<SpaceExport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Browser-local, per-Space dialog intent (path / message / save-as-default).
  const [view, setView] = useState<ExportDialogViewState>(() =>
    readExportDialogState(projectId, spaceId),
  );

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Persist the user's confirmable intent so re-opening the dialog restores it
  // rather than silently resetting (Dataful-UX persistence AC #2).
  useEffect(() => {
    writeExportDialogState(projectId, spaceId, view);
  }, [projectId, spaceId, view]);

  // Load the resolved settings + existing tracking rows once per Space/repo.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    getSpaceExports(spaceId, repoId)
      .then((result) => {
        if (cancelled) return;
        setSettings(result.settings);
        setResolvedRepoId(result.repo_id);
        setExisting(result.exports);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load export settings');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, repoId]);

  // The effective path the export will write to: the user's per-export override
  // when set, otherwise the resolved default from settings (custody-doc §5.1).
  const resolvedDefaultPath = settings?.path ?? '';
  const effectivePath = view.path.trim() ? view.path.trim() : resolvedDefaultPath;
  const usingOverride = view.path.trim().length > 0
    && normalizePathForCompare(view.path) !== normalizePathForCompare(resolvedDefaultPath);

  // Idempotency context: is there already a tracked row at the effective
  // (repo, branch, path)? Re-exporting there is a deterministic refresh (§5.2),
  // surfaced so the user knows this confirm overwrites an existing tracked file.
  const matchingExisting = useMemo<SpaceExport | null>(() => {
    if (!settings || !effectivePath) return null;
    const target = normalizePathForCompare(effectivePath);
    const branch = settings.branch;
    const repo = resolvedRepoId;
    return (
      existing.find(
        (row) =>
          normalizePathForCompare(row.path) === target
          && row.branch === branch
          && (repo == null || row.repo_id === repo),
      ) ?? null
    );
  }, [existing, settings, effectivePath, resolvedRepoId]);

  const setPath = useCallback((next: string) => {
    setView((current) => ({ ...current, path: next }));
  }, []);
  const setMessage = useCallback((next: string) => {
    setView((current) => ({ ...current, message: next }));
  }, []);
  const setSaveAsRepoDefault = useCallback((next: boolean) => {
    setView((current) => ({ ...current, saveAsRepoDefault: next }));
  }, []);

  const canExport = Boolean(effectivePath) && issues.length > 0 && !submitting && !loading;

  const handleExport = useCallback(async () => {
    if (!canExport) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // If the user asked to persist the chosen path as the per-repo default,
      // do that explicit settings write FIRST (custody-doc §5.1, per-repo
      // override). It is itself an explicit user action, gated on the checkbox.
      if (view.saveAsRepoDefault && usingOverride && resolvedRepoId) {
        await setSpaceExportSettings({ repo_id: resolvedRepoId, path: effectivePath });
      }
      const result = await exportSpaceTracked(spaceId, {
        path: effectivePath,
        repo_id: repoId ?? resolvedRepoId ?? undefined,
        branch: settings?.branch ?? null,
        issues,
        message: view.message.trim() ? view.message.trim() : null,
      });
      // Reflect the new/updated row locally so the idempotency hint updates
      // without a refetch (reconciliation input, not a reset).
      setExisting((current) => {
        const others = current.filter((row) => row.id !== result.export.id);
        return [...others, result.export];
      });
      onExported?.(result);
    } catch (error: unknown) {
      setSubmitError(error instanceof Error ? error.message : 'Export failed');
    } finally {
      setSubmitting(false);
    }
  }, [
    canExport,
    view.saveAsRepoDefault,
    view.message,
    usingOverride,
    resolvedRepoId,
    effectivePath,
    spaceId,
    repoId,
    settings,
    issues,
    onExported,
  ]);

  return (
    <section
      className="space-export-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Export document to repo"
      data-testid="space-export-dialog"
    >
      <header className="space-export-dialog__header">
        <h2 className="space-export-dialog__title">Export to repo</h2>
        {onClose ? (
          <button
            type="button"
            className="space-export-dialog__close"
            aria-label="Close export dialog"
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </header>

      {(loadError || submitError) && (
        <DetailPaneNotice severity="error" density="compact" title="Export failed" testId={loadError ? 'export-load-error' : 'export-error'}>
          {loadError ?? submitError}
        </DetailPaneNotice>
      )}

      {loading ? (
        <p className="space-export-dialog__hint" data-testid="export-loading">
          Resolving export location…
        </p>
      ) : loadError ? (
        <p className="space-export-dialog__hint">Export location unavailable.</p>
      ) : (
        <div className="space-export-dialog__body">
          <p className="space-export-dialog__hint" data-testid="export-default-path">
            Default location:{' '}
            <code>{resolvedDefaultPath || '(no default set)'}</code>
            {settings?.overridden ? (
              <span className="space-export-dialog__badge" data-testid="export-repo-override-badge">
                per-repo override
              </span>
            ) : null}
          </p>

          <label className="space-export-dialog__field">
            <span>Export path (confirm or override)</span>
            <input
              value={view.path}
              data-testid="export-path-input"
              onInput={(event) => setPath((event.currentTarget as HTMLInputElement).value)}
              placeholder={resolvedDefaultPath || 'docs/my-document.md'}
            />
          </label>

          <p className="space-export-dialog__hint" data-testid="export-effective-path">
            Will write to{' '}
            <code data-testid="export-effective-path-value">{effectivePath || '(no path)'}</code>
            {settings?.branch ? (
              <>
                {' '}on branch <code>{settings.branch}</code>
              </>
            ) : null}
          </p>

          {usingOverride ? (
            <label className="space-export-dialog__option">
              <input
                type="checkbox"
                checked={view.saveAsRepoDefault}
                data-testid="export-save-default"
                onChange={(event) =>
                  setSaveAsRepoDefault((event.currentTarget as HTMLInputElement).checked)
                }
              />
              <span>Save this path as the per-repo default</span>
            </label>
          ) : null}

          {matchingExisting ? (
            <p
              className="space-export-dialog__hint space-export-dialog__hint--idempotent"
              data-testid="export-idempotent-hint"
            >
              A tracked export already exists at this path (status{' '}
              <code>{matchingExisting.status}</code>). Re-exporting refreshes it
              in place.
            </p>
          ) : null}

          <label className="space-export-dialog__field">
            <span>Commit message (optional)</span>
            <input
              value={view.message}
              data-testid="export-message-input"
              onInput={(event) => setMessage((event.currentTarget as HTMLInputElement).value)}
              placeholder="Export Spaces document…"
            />
          </label>

          {issues.length === 0 ? (
            <p
              className="space-export-dialog__error"
              role="alert"
              data-testid="export-no-issue"
            >
              A linked issue is required for the docs-branch commit. Link an issue
              to this Space before exporting.
            </p>
          ) : null}
        </div>
      )}

      <footer className="space-export-dialog__actions">
        {onClose ? (
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          className="space-export-dialog__submit"
          data-testid="export-submit"
          disabled={!canExport}
          onClick={handleExport}
        >
          {submitting ? 'Exporting…' : matchingExisting ? 'Re-export' : 'Export to repo'}
        </button>
      </footer>
    </section>
  );
}

export default SpaceExportDialog;
