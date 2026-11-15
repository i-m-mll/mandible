import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  canPerformOperation,
  enrollApprovalKey,
  getOperatorSigningKeyStatus,
  type ApprovalKeyState,
  type InstanceInfo,
  type OperatorSigningKeyStatus,
} from '../../api';
import { copyText } from '../shared/DetailHeaderIdentity';

type Props = { instance?: InstanceInfo | null };

/** States in which the enrolled key will never sign again: the operator is simply not enrolled. */
const GONE: ReadonlySet<ApprovalKeyState> = new Set(['key_missing', 'key_invalidated']);

const UNAVAILABLE_NOW: Partial<Record<ApprovalKeyState, string>> = {
  biometry_unavailable: 'Touch ID is unavailable right now.',
  biometry_locked_out: 'Touch ID is locked; unlock the Mac with your password.',
  no_interactive_session: 'No macOS login session.',
};

/** The latest enrollment replaced a key without that key's signature, so only access to this Mac authorized it. */
function unsignedReplacement(status: OperatorSigningKeyStatus): Date | null {
  const latest = status.trust_changes.find((change) => change.kind === 'approval_key_enrollment');
  if (!latest || latest.authorization !== 'bootstrap') return null;
  try {
    const replaces = (JSON.parse(latest.statement) as { content?: { replaces?: unknown[] } }).content?.replaces;
    return Array.isArray(replaces) && replaces.length > 0 ? new Date(latest.created_at) : null;
  } catch {
    return new Date(latest.created_at);
  }
}

export default function SigningSettings({ instance }: Props): JSX.Element {
  const [status, setStatus] = useState<OperatorSigningKeyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readAllowed = canPerformOperation(instance, 'GET', '/api/users/operator/signing-key');
  const enrollAllowed = canPerformOperation(instance, 'POST', '/api/users/operator/approval-key', {});

  const refresh = useCallback(async () => {
    if (!readAllowed) return;
    try {
      setStatus(await getOperatorSigningKeyStatus());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [readAllowed]);

  useEffect(() => { void refresh(); }, [refresh]);

  const key = status?.approval_keys[0] ?? null;
  const enrolled = key !== null && !GONE.has(key.state);
  const failed = key?.state === 'failed';

  const enroll = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // A key the helper cannot classify was shown as failed; clicking Enroll is the confirmation to replace it.
      await enrollApprovalKey(failed ? { confirm_bootstrap: true } : {});
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [failed, refresh]);

  const copyPublicKey = useCallback(async () => {
    if (!key?.public_material) return;
    try {
      await copyText(key.public_material);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [key]);

  const replacedAt = status ? unsignedReplacement(status) : null;
  const note = !readAllowed
    ? 'Unavailable in this instance.'
    : failed
      ? key?.detail ?? 'The approval helper could not check the key.'
      : key && UNAVAILABLE_NOW[key.state];

  return (
    <div className="settings-view__signing" data-settings-searchable data-settings-search-text="Touch ID approval key enroll public key">
      <div className="settings-view__number-row">
        <div className="settings-view__number-info">
          <span className="settings-view__number-label">Touch ID</span>
          {note && <span className="settings-view__number-desc">{note}</span>}
          {replacedAt && (
            <span className="settings-view__warning">Enrolled {replacedAt.toLocaleDateString()} without the previous key's signature.</span>
          )}
          {error && <span className="settings-view__warning" role="alert">{error}</span>}
        </div>
        {readAllowed && status && (
          <div className="settings-view__number-controls">
            {enrolled && !failed ? (
              <>
                <span className="settings-view__status-pill" title={key.fingerprint}>Enrolled</span>
                {key.public_material && (
                  <button type="button" className="btn btn--sm" onClick={() => void copyPublicKey()}
                    title="GitHub accepts this OpenSSH key as a signing key.">
                    {copied ? 'Copied' : 'Copy public key'}
                  </button>
                )}
              </>
            ) : enrollAllowed && (
              <button type="button" className="btn btn--sm btn--active" onClick={() => void enroll()} disabled={busy}>
                {busy ? 'Waiting for Touch ID' : 'Enroll'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
