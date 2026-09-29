import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  canPerformOperation,
  getOperatorSigningKeyStatus,
  registerOperatorSigningKey,
  type InstanceInfo,
  type OperatorSigningKeyStatus,
} from '../../api';
import { DetailPaneNotice } from '../shared/DetailPaneNotice';

type Props = { instance?: InstanceInfo | null };

export default function SigningSettings({ instance }: Props): JSX.Element {
  const [status, setStatus] = useState<OperatorSigningKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [publicKey, setPublicKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const readAllowed = canPerformOperation(instance, 'GET', '/api/users/operator/signing-key');
  const importAllowed = canPerformOperation(instance, 'POST', '/api/users/operator/signing-key', { source: 'public_key' });
  const configuredAllowed = canPerformOperation(instance, 'POST', '/api/users/operator/signing-key', { source: 'configured' });

  const refresh = useCallback(async () => {
    if (!readAllowed) {
      setLoading(false);
      return;
    }
    try {
      setStatus(await getOperatorSigningKeyStatus());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load signing-key status.');
    } finally {
      setLoading(false);
    }
  }, [readAllowed]);

  useEffect(() => { void refresh(); }, [refresh]);

  const register = useCallback(async (input: { source: 'configured' } | { source: 'public_key'; public_key: string }) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await registerOperatorSigningKey(input);
      setMessage(result.unchanged ? 'This key is already registered.' : 'Public key registered. Git configuration was not changed.');
      setPublicKey('');
      setFormOpen(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not register the public key.');
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleFile = useCallback(async (event: Event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 16_384) {
      setError('Public-key files must be 16 KB or smaller.');
      return;
    }
    try {
      const contents = await file.text();
      const lines = contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length !== 1 || !/^(ssh-|ecdsa-|sk-)\S+\s+\S+(?:\s+.*)?$/.test(lines[0])) {
        setError('Choose a .pub file containing one OpenSSH public-key line. Private-key files are not accepted.');
        return;
      }
      setError(null);
      setPublicKey(lines[0]);
      setFormOpen(true);
    } catch {
      setError('Could not read the selected public-key file.');
    }
  }, []);

  const statusText = status?.audit.status === 'ok'
    ? 'Registered; signing not tested'
    : status?.audit.status === 'missing_credential'
      ? 'Git key not registered'
      : status?.audit.status === 'unconfigured'
        ? 'Git key not configured'
        : status?.audit.status === 'unresolvable'
          ? 'Configured public key unavailable'
          : status?.audit.status === 'no_operator'
            ? 'The local operator is not set up.'
            : null;

  return (
    <div className="settings-view__signing-settings" data-settings-searchable>
      <div
        className="settings-view__number-row"
        data-settings-searchable
        data-settings-search-text={`Git signing key ${statusText ?? ''} ${status?.audit.fingerprint ?? ''}`}
      >
        <div className="settings-view__number-info">
          <span className="settings-view__number-label">Git signing key</span>
          <span className="settings-view__number-desc">Git configuration and operator credential registration are separate. Registering a key never changes Git configuration.</span>
        </div>
        <div className="settings-view__number-controls">
          {status?.audit.status === 'missing_credential' && configuredAllowed && (
            <button type="button" className="btn btn--active btn--sm" onClick={() => void register({ source: 'configured' })} disabled={busy}>
              {busy ? 'Registering…' : 'Register configured key'}
            </button>
          )}
          {importAllowed && (
            <button
              type="button"
              className="btn btn--sm"
              aria-label={formOpen ? 'Cancel public-key registration' : 'Add public key'}
              title={formOpen ? 'Cancel public-key registration' : 'Add public key'}
              onClick={() => { setFormOpen((open) => !open); setMessage(null); }}
              disabled={busy}
            >
              {formOpen ? '×' : <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>}
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
      ) : loading ? (
        <p className="settings-view__number-desc" data-settings-searchable data-settings-search-text="Checking Git signing configuration and registered credentials">Checking Git configuration and registered credentials…</p>
      ) : error ? (
        <div data-settings-searchable data-settings-search-text={`Signing status error ${error}`}>
          <DetailPaneNotice severity="error" density="compact">{error}</DetailPaneNotice>
        </div>
      ) : status ? (
        <>
          <div data-settings-searchable data-settings-search-text={`Git signing ${statusText ?? ''} ${status.audit.fingerprint ?? ''}`}>
            <DetailPaneNotice severity="info" density="compact" title={statusText ?? 'Signing status unavailable'}>
              {status.git_config_read
                ? status.audit.fingerprint
                  ? <>Fingerprint: <code>{status.audit.fingerprint}</code></>
                  : 'A public key can be registered here before Git signing is configured.'
                : 'Configured Git signing status is unavailable.'}
            </DetailPaneNotice>
          </div>
          {instance?.role === 'preview' && (
            <p className="settings-view__number-desc">This preview reads Git configuration without changing it. Key registration writes only to the preview copy.</p>
          )}

          {status.credentials.length > 0 && (
            <div className="settings-view__field">
              <span className="settings-view__field-label">Registered operator signing keys</span>
              {status.credentials.map((credential) => (
                <div
                  className="settings-view__number-row"
                  data-settings-searchable
                  data-settings-search-text={`Registered operator signing key ${credential.fingerprint} ${credential.label ?? ''}`}
                  key={credential.id}
                >
                  <div className="settings-view__number-info">
                    <span className="settings-view__number-label">{credential.fingerprint}</span>
                    {credential.label && <span className="settings-view__number-desc">{credential.label}</span>}
                  </div>
                  <span className="settings-view__badge">{credential.type === 'delegated_ssh_key' ? 'Delegated key' : 'SSH key'}</span>
                </div>
              ))}
            </div>
          )}

          {status.audit.status === 'unconfigured' && status.git_config_read && (
            <p className="settings-view__number-desc">
              To enable signing, configure Git's <code>gpg.format=ssh</code> and <code>user.signingkey</code>. Registration does not test signing.
            </p>
          )}
        </>
      ) : null}

      {formOpen && importAllowed && (
        <div className="settings-view__field" data-settings-searchable data-settings-search-text="Register or import OpenSSH public key">
          <label className="settings-view__field-label" htmlFor="signing-public-key">OpenSSH public key</label>
          <textarea
            id="signing-public-key"
            className="settings-view__input settings-view__input--mono"
            value={publicKey}
            onInput={(event) => setPublicKey((event.currentTarget as HTMLTextAreaElement).value)}
            maxLength={16_384}
            rows={3}
            placeholder="ssh-ed25519 AAAA… comment"
            disabled={busy}
          />
          <label className="settings-view__field-label" htmlFor="signing-public-key-file">Or choose a .pub file</label>
          <input id="signing-public-key-file" type="file" accept=".pub,text/plain" onChange={(event) => void handleFile(event)} disabled={busy} />
          <p className="settings-view__number-desc">Only one OpenSSH public-key line is accepted. Private-key files are rejected. Registration adds a credential; it does not enable Git signing.</p>
          <button
            type="button"
            className="btn btn--active btn--sm"
            onClick={() => void register({ source: 'public_key', public_key: publicKey })}
            disabled={!publicKey.trim() || busy}
          >
            {busy ? 'Registering…' : 'Register public key'}
          </button>
        </div>
      )}

      {message && <span data-settings-searchable data-settings-search-text={message} className="settings-view__feedback settings-view__feedback--success">{message}</span>}
      {error && status && <div data-settings-searchable data-settings-search-text={`Public key registration error ${error}`}><DetailPaneNotice severity="error" density="compact">{error}</DetailPaneNotice></div>}
    </div>
  );
}
