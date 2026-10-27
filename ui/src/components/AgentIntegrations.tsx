import { useEffect, useState } from 'preact/hooks';
import { getOptionalIntegrations, updateOptionalIntegration, canPerformOperation, type InstanceInfo } from '../api';
import type { OptionalIntegrations, OptionalIntegration } from '../../../src/optional-integrations';

export function AgentIntegrations({ instance }: { instance?: InstanceInfo | null }): JSX.Element {
  const [state, setState] = useState<OptionalIntegrations | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const allowed = canPerformOperation(instance ?? null, 'GET', '/api/settings/integrations');
  useEffect(() => {
    if (!allowed) return;
    let active = true;
    getOptionalIntegrations().then(value => { if (active) setState(value); })
      .catch(error => { if (active) setFeedback(String(error)); });
    return () => { active = false; };
  }, [allowed]);
  async function apply(item: OptionalIntegration, action: 'install' | 'remove') {
    setBusy(true);
    try {
      setState(await updateOptionalIntegration(item.id, action));
      setFeedback('Integration updated. Restart your external agent to use the change.');
    } catch (error) { setFeedback(String(error)); }
    finally { setBusy(false); }
  }
  return <>
    <p className="settings-view__text-desc">Mandible keeps issues, approvals, artifacts, and agent conversations together on your Mac. External agent connections are optional. Instruction destinations can be selected in Instruction Delivery below.</p>
    {state && <>
      {!state.available && <p className="settings-view__text-desc">Use the installed app to change global integrations. This development or preview instance only shows their state.</p>}
      <div className="settings-view__text-row"><div className="settings-view__text-info">
        <span className="settings-view__text-label">Mandible command</span><code>{state.command}</code>
        <span className="settings-view__text-desc">The shortcut uses ~/.local/bin; add that directory to your shell PATH if needed.</span>
      </div><button className="btn btn--sm" onClick={() => { void navigator.clipboard.writeText(state.command).then(() => setFeedback('Command copied.'), error => setFeedback(String(error))); }}>Copy command</button></div>
      {state.items.map(item => <div className="settings-view__text-row" data-settings-searchable key={item.id}>
        <div className="settings-view__text-info"><span className="settings-view__text-label">{item.label} · {item.status}</span>
          <code>{item.destination}</code>{item.detail && <span className="settings-view__text-desc">{item.detail}</span>}</div>
        <button className="btn btn--sm" disabled={busy || !state.available || item.status === 'conflict' || !canPerformOperation(instance ?? null, 'PUT', '/api/settings/integrations')}
          onClick={() => void apply(item, item.status === 'installed' ? 'remove' : 'install')}>{item.status === 'installed' ? 'Remove' : item.status === 'outdated' ? 'Refresh' : 'Install'}</button>
        {item.status === 'outdated' && <button className="btn btn--sm" disabled={busy || !state.available} onClick={() => void apply(item, 'remove')}>Remove</button>}
      </div>)}
      <details><summary>Generic Mandible skill</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{state.skill}</pre>
        <button className="btn btn--sm" onClick={() => { void navigator.clipboard.writeText(state.skill).then(() => setFeedback('Skill copied.'), error => setFeedback(String(error))); }}>Copy skill</button>
      </details>
    </>}
    {feedback && <p role="status">{feedback}</p>}
  </>;
}

export function IntegrationIntroduction({ settings, onSave }: {
  settings: Record<string, string>;
  onSave: (key: string, value: string) => Promise<void>;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (settings['integrations.setup']) return null;
  return <div className="daemon-toast daemon-toast--introduction" role="region" aria-label="Welcome to Mandible">
    <span>Mandible keeps your agent work together. You can optionally connect external agents and the command line.</span>
    <a className="daemon-toast__link" href="#/settings?section=settings-integrations">Choose integrations</a>
    <button className="btn btn--sm" disabled={busy} onClick={() => {
      setBusy(true);
      void onSave('integrations.setup', 'skipped').catch(error => setError(String(error))).finally(() => setBusy(false));
    }}>Skip for now</button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
