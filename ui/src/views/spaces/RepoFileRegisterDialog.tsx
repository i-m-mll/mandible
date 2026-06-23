// Repo-file-as-document registration dialog (umbrella de56ffa, C13f / f7be021).
//
// Custody-doc §1.4: an EXISTING tracked repo file (README, design spec,
// whitepaper) can be registered as a canonical document with LINK CUSTODY — the
// canonical bytes stay in the repo, the document starts at `authority='repo'`,
// and its source is a `repo://<repo>@<ref>/<path>` ref. This dialog is the
// explicit user action that registers such a file (it ties to issue 2dc97b8).
//
// Boundaries (sibling-ownership / non-goals from issue f7be021):
//   - No backend register op here (C13b owns the `.../exports/register` glue);
//     this dialog only collects (repo, ref, path) and posts the explicit confirm
//     via `registerRepoFileDocument`.
//   - Registration is link custody — Mandible does NOT rewrite the repo bytes.
//   - There is NO auto-register affordance: registering is always a manual,
//     explicit user submit (custody-doc §2.2 / §5: committing/adopting a repo
//     file is always an explicit user action).
//
// Per the Dataful-UX rule the dialog is pure browser-local view state; the only
// canonical mutation is the explicit user-triggered register POST.

import { useCallback, useState } from 'preact/hooks';

import {
  registerRepoFileDocument,
  type RegisterRepoFileResult,
} from '../../api';
import './RepoFileRegisterDialog.css';

export type RepoFileRegisterDialogProps = {
  /** The Space the file is registered into; posts to `.../exports/register`. */
  spaceId: string;
  /** Explicit project-checkout id; defaults to the Space's project checkout. */
  repoId?: string;
  /** Default docs branch / ref to pre-fill (the file's ref). */
  defaultBranch?: string;
  /** Called after a successful registration with the C13b result. */
  onRegistered?: (result: RegisterRepoFileResult) => void;
  /** Dismiss the dialog without registering. */
  onClose?: () => void;
};

/** Normalize a repo-relative path: trim, drop leading/trailing slashes. */
function normalizeRepoPath(input: string): string {
  return input.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Preview the `repo://<repo>@<ref>/<path>` source ref the registration will
 * record, so the user can confirm exactly what is being adopted. The authoritative
 * ref is computed server-side; this is a display preview only.
 */
export function previewRepoSourceRef(
  repoId: string | undefined,
  branch: string,
  path: string,
): string | null {
  const repo = (repoId ?? '').trim();
  const file = normalizeRepoPath(path);
  if (!file) return null;
  const ref = branch.trim();
  const repoSegment = repo || '<repo>';
  return `repo://${repoSegment}${ref ? `@${ref}` : ''}/${file}`;
}

export function RepoFileRegisterDialog({
  spaceId,
  repoId,
  defaultBranch = '',
  onRegistered,
  onClose,
}: RepoFileRegisterDialogProps): JSX.Element {
  const [path, setPath] = useState('');
  const [branch, setBranch] = useState(defaultBranch);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const normalizedPath = normalizeRepoPath(path);
  const sourcePreview = previewRepoSourceRef(repoId, branch, path);
  const canRegister = normalizedPath.length > 0 && !submitting;

  const handleRegister = useCallback(async () => {
    if (!canRegister) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await registerRepoFileDocument(spaceId, {
        repo_id: repoId ?? null,
        branch: branch.trim() ? branch.trim() : null,
        path: normalizedPath,
      });
      onRegistered?.(result);
    } catch (error: unknown) {
      setSubmitError(error instanceof Error ? error.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  }, [canRegister, spaceId, repoId, branch, normalizedPath, onRegistered]);

  return (
    <section
      className="repo-file-register-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Register repo file as document"
      data-testid="repo-file-register-dialog"
    >
      <header className="repo-file-register-dialog__header">
        <h2 className="repo-file-register-dialog__title">Register a repo file</h2>
        {onClose ? (
          <button
            type="button"
            className="repo-file-register-dialog__close"
            aria-label="Close register dialog"
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </header>

      <div className="repo-file-register-dialog__body">
        <p className="repo-file-register-dialog__hint">
          Adopt an existing tracked repo file as a document with{' '}
          <strong>link custody</strong>. The repo keeps the canonical bytes;
          Mandible tracks it as repo-authoritative.
        </p>

        <label className="repo-file-register-dialog__field">
          <span>Repo-relative path</span>
          <input
            value={path}
            data-testid="register-path-input"
            onInput={(event) => setPath((event.currentTarget as HTMLInputElement).value)}
            placeholder="docs/design.md"
          />
        </label>

        <label className="repo-file-register-dialog__field">
          <span>Ref / branch (optional)</span>
          <input
            value={branch}
            data-testid="register-branch-input"
            onInput={(event) => setBranch((event.currentTarget as HTMLInputElement).value)}
            placeholder="main"
          />
        </label>

        {sourcePreview ? (
          <p className="repo-file-register-dialog__hint" data-testid="register-source-preview">
            Source ref: <code>{sourcePreview}</code>
          </p>
        ) : null}
      </div>

      {submitError ? (
        <p
          className="repo-file-register-dialog__error"
          role="alert"
          data-testid="register-error"
        >
          {submitError}
        </p>
      ) : null}

      <footer className="repo-file-register-dialog__actions">
        {onClose ? (
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          className="repo-file-register-dialog__submit"
          data-testid="register-submit"
          disabled={!canRegister}
          onClick={handleRegister}
        >
          {submitting ? 'Registering…' : 'Register file'}
        </button>
      </footer>
    </section>
  );
}

export default RepoFileRegisterDialog;
