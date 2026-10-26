import { useEffect, useState } from 'preact/hooks';
import { getChildRetentionSettings, updateChildRetentionSettings } from '../../api';
import { CHILD_RETENTION_SETTINGS_SCHEMA, type ChildRetentionSettings as Settings } from '../../../../src/conversations/retention-contract';
import { SettingsToggle } from './SettingsToggle';
import { DetailPaneNotice } from '../shared/DetailPaneNotice';

export function ChildRetentionSettings({ canSave }: { canSave: boolean }): JSX.Element {
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void getChildRetentionSettings().then(value => {
      if (active) { setDraft(value); setSaved(value); setLoaded(true); setError(null); }
    }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [loadAttempt]);
  const save = async () => {
    if (!draft || saving || !canSave) return;
    setSaving(true); setError(null);
    try {
      const value = await updateChildRetentionSettings(draft);
      setSaved(value); setDraft(value);
    } catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
  };
  const toggle = (label: string, enabled: boolean, edit: () => void, disabled = false) => (
    <SettingsToggle label={label} enabled={enabled} onToggle={edit} disabled={!canSave || saving || disabled} />
  );
  return <div>
    {draft ? <>
      <div className="settings-view__toggle-row" data-settings-searchable>
        <div className="settings-view__toggle-info">
          <h3 className="settings-view__section-title">Clean up child chats</h3>
          <p className="settings-view__section-desc">Archive eligible Codex and Claude child chats in Mandible. Codex chats are also archived in Codex when available. Autonomous and successor chats stay active.</p>
        </div>
        {toggle('Clean up child chats', draft.enabled, () => setDraft({ ...draft, enabled: !draft.enabled }))}
      </div>
      {(['planner', 'archaeologist'] as const).map(role => {
        const name = role === 'planner' ? 'Planner' : 'Archaeologist';
        return <div key={role} data-settings-searchable>
          <div className="settings-view__toggle-row">
            <div className="settings-view__toggle-info">
              <h3 className="settings-view__section-title">{name} children</h3>
              <p className="settings-view__section-desc">Archive after the configured idle time.</p>
            </div>
            {toggle(`${name} child cleanup`, draft[role].enabled, () => setDraft({ ...draft, [role]: { ...draft[role], enabled: !draft[role].enabled } }), !draft.enabled)}
          </div>
          <label className="settings-view__text-row">
            <span className="settings-view__text-label">{name} idle time</span>
            <span className="settings-view__number-controls">
              <input className="settings-view__number-input" aria-label={`${name} idle hours`} type="number" min="0" step="any" value={draft[role].idleHours}
                disabled={!canSave || saving || !draft.enabled || !draft[role].enabled}
                onInput={event => setDraft({ ...draft, [role]: { ...draft[role], idleHours: event.currentTarget.valueAsNumber } })} />
              <span>hours</span>
            </span>
          </label>
        </div>;
      })}
      <div className="settings-view__toggle-row" data-settings-searchable>
        <div className="settings-view__toggle-info">
          <h3 className="settings-view__section-title">Resolved worker children</h3>
          <p className="settings-view__section-desc">Archive worker chats when their work is resolved and they have stopped.</p>
        </div>
        {toggle('Resolved worker child cleanup', draft.worker.enabled, () => setDraft({ ...draft, worker: { enabled: !draft.worker.enabled } }), !draft.enabled)}
      </div>
      {!CHILD_RETENTION_SETTINGS_SCHEMA.safeParse(draft).success ? <p className="settings-view__warning" role="status">Enter a valid positive idle time.</p> : null}
      <button type="button" className="btn btn--active btn--sm" disabled={!canSave || saving || JSON.stringify(saved) === JSON.stringify(draft) || !CHILD_RETENTION_SETTINGS_SCHEMA.safeParse(draft).success} onClick={() => { void save(); }}>{saving ? 'Saving…' : 'Save child cleanup'}</button>
    </> : null}
    {error ? <DetailPaneNotice severity="error" density="compact" actions={!loaded ? <button type="button" className="btn btn--ghost btn--sm" onClick={() => setLoadAttempt(value => value + 1)}>Retry</button> : undefined}>{error}</DetailPaneNotice> : null}
  </div>;
}
