import { Icon } from '../icons/Icon';
import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  ApiError,
  canPerformOperation,
  enrollApprovalKey,
  getOperatorSigningKeyStatus,
  registerOperatorSigningKey,
  type InstanceInfo,
  type OperatorSigningKeyStatus,
} from '../../api';
import { DetailPaneNotice } from '../shared/DetailPaneNotice';

type Props = { instance?: InstanceInfo | null };

const STATE_LABEL: Record<string, string> = {
  usable: 'Ready',
  key_missing: 'Key file missing',
  key_invalidated: 'Fingerprints changed',
  biometry_unavailable: 'Touch ID unavailable',
  biometry_locked_out: 'Touch ID locked',
  no_interactive_session: 'No login session',
  failed: 'Failed',
};

const CHANGE_LABEL: Record<string, string> = {
  approval_key_enrollment: 'Approval key enrolled',
  signer_add: 'Signer added',
  signer_revoke: 'Signer removed',
  protected_branches: 'Protected branches changed',
  delegated_signer_setup: 'Delegated signer set up',
  delegated_signer_remove: 'Delegated signer removed',
};

export default function SigningSettings({ instance }: Props): JSX.Element {
  const [status, setStatus] = useState<OperatorSigningKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [publicKey, setPublicKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [bootstrapOffer, setBootstrapOffer] = useState<string | null>(null);
  const readAllowed = canPerformOperation(instance, 'GET', '/api/users/operator/signing-key');
  const importAllowed = canPerformOperation(instance, 'POST', '/api/users/operator/signing-key', { public_key: '' });
  const enrollAllowed = canPerformOperation(instance, 'POST', '/api/users/operator/approval-key', {});

  const refresh = useCallback(async () => {
    if (!readAllowed) {
      setLoading(false);
      return;
    }
    try {
      setStatus(await getOperatorSigningKeyStatus());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load signing status.');
    } finally {
      setLoading(false);
    }
  }, [readAllowed]);

  useEffect(() => { void refresh(); }, [refresh]);

  const enroll = useCallback(async (confirmBootstrap: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await enrollApprovalKey(confirmBootstrap ? { confirm_bootstrap: true } : {});
      setBootstrapOffer(null);
      await refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'operator_signature_bootstrap_confirmation_required') {
        setBootstrapOffer(cause.message);
      } else {
        setError(cause instanceof Error ? cause.message : 'Could not enroll the approval key.');
      }
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const register = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await registerOperatorSigningKey(publicKey);
      setPublicKey('');
      setFormOpen(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add the signer.');
    } finally {
      setBusy(false);
    }
  }, [publicKey, refresh]);

  const handleFile = useCallback(async (event: Event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 16_384) {
      setError('Public-key files must be 16 KB or smaller.');
      return;
    }
    try {
      const lines = (await file.text()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length !== 1 || !/^(ssh-|ecdsa-|sk-)\S+\s+\S+(?:\s+.*)?$/.test(lines[0])) {
        setError('Choose a .pub file containing one OpenSSH public-key line.');
        return;
      }
      setError(null);
      setPublicKey(lines[0]);
      setFormOpen(true);
    } catch {
      setError('Could not read the selected public-key file.');
    }
  }, []);

  const approvalKey = status?.approval_keys[0] ?? null;
  const externalSigners = status?.credentials.filter((credential) => credential.custody !== 'enclave') ?? [];

  return (
    <div className="settings-view__signing-settings" data-settings-searchable>
      <div
        className="settings-view__number-row"
        data-settings-searchable
        data-settings-search-text={`Approval key Touch ID ${approvalKey?.fingerprint ?? ''}`}
      >
        <div className="settings-view__number-info">
          <span className="settings-view__number-label">Approval key</span>
          {approvalKey && <span className="settings-view__number-desc"><code>{approvalKey.fingerprint}</code></span>}
        </div>
        <div className="settings-view__number-controls">
          {approvalKey && <span className="settings-view__badge" title={approvalKey.detail ?? undefined}>{STATE_LABEL[approvalKey.state] ?? approvalKey.state}</span>}
          {enrollAllowed && (
            <button type="button" className="btn btn--sm" onClick={() => void enroll(false)} disabled={busy}>
              {approvalKey ? 'Replace' : 'Enroll'}
            </button>
          )}
        </div>
      </div>

      {bootstrapOffer && (
        <div data-settings-searchable data-settings-search-text={`Approval key bootstrap ${bootstrapOffer}`}>
          <DetailPaneNotice severity="warning" density="compact" title="Replace without the current key">{bootstrapOffer}</DetailPaneNotice>
          <button type="button" className="btn btn--active btn--sm" onClick={() => void enroll(true)} disabled={busy}>Replace</button>
        </div>
      )}

      <div className="settings-view__number-row" data-settings-searchable data-settings-search-text="External signers">
        <div className="settings-view__number-info">
          <span className="settings-view__number-label">External signers</span>
        </div>
        <div className="settings-view__number-controls">
          {importAllowed && (
            <button
              type="button"
              className="btn btn--sm"
              aria-label={formOpen ? 'Cancel' : 'Add signer'}
              title={formOpen ? 'Cancel' : 'Add signer'}
              onClick={() => setFormOpen((open) => !open)}
              disabled={busy}
            >
              {formOpen ? <Icon name="dismiss" /> : <Icon name="addSigningKey" size={16} />}
            </button>
          )}
        </div>
      </div>

      {!readAllowed ? (
        <div data-settings-searchable data-settings-search-text="Signing status unavailable">
          <DetailPaneNotice severity="info" density="compact" title="Signing status unavailable">
            This instance does not allow reading operator signing credentials.
          </DetailPaneNotice>
        </div>
      ) : loading ? null : status && (
        <>
          {externalSigners.map((credential) => (
            <div
              className="settings-view__number-row"
              data-settings-searchable
              data-settings-search-text={`External signer ${credential.fingerprint} ${credential.label ?? ''}`}
              key={credential.id}
            >
              <div className="settings-view__number-info">
                <span className="settings-view__number-label">{credential.fingerprint}</span>
                {credential.label && <span className="settings-view__number-desc">{credential.label}</span>}
              </div>
              <span className="settings-view__badge">{credential.type === 'delegated_ssh_key' ? 'Delegated' : 'Verify only'}</span>
            </div>
          ))}
          {status.trust_changes.length > 0 && (
            <div className="settings-view__field" data-settings-searchable data-settings-search-text="Trust changes">
              <span className="settings-view__field-label">Trust changes</span>
              {status.trust_changes.map((change) => (
                <div className="settings-view__number-row" key={change.id} title={change.statement}>
                  <div className="settings-view__number-info">
                    <span className="settings-view__number-label">{CHANGE_LABEL[change.kind] ?? change.kind}</span>
                    <span className="settings-view__number-desc">{new Date(change.created_at).toLocaleString()}</span>
                  </div>
                  <span className="settings-view__badge">{change.authorization === 'bootstrap' ? 'Bootstrap' : 'Signed'}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {formOpen && importAllowed && (
        <div className="settings-view__field" data-settings-searchable data-settings-search-text="Add OpenSSH public key signer">
          <label className="settings-view__field-label" htmlFor="signing-public-key">OpenSSH public key</label>
          <textarea
            id="signing-public-key"
            className="settings-view__input settings-view__input--mono"
            value={publicKey}
            onInput={(event) => setPublicKey((event.currentTarget as HTMLTextAreaElement).value)}
            maxLength={16_384}
            rows={3}
            placeholder="sk-ssh-ed25519@openssh.com AAAA…"
            disabled={busy}
          />
          <input id="signing-public-key-file" type="file" accept=".pub,text/plain" onChange={(event) => void handleFile(event)} disabled={busy} />
          <button type="button" className="btn btn--active btn--sm" onClick={() => void register()} disabled={!publicKey.trim() || busy}>
            Add signer
          </button>
        </div>
      )}

      {error && <div data-settings-searchable data-settings-search-text={`Signing error ${error}`}><DetailPaneNotice severity="error" density="compact">{error}</DetailPaneNotice></div>}
    </div>
  );
}
