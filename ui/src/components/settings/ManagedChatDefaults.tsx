import { NativeSelect } from '../shared/NativeSelect';
import { useEffect, useState } from 'preact/hooks';
import { getManagedChatDefaults, updateManagedChatDefaults } from '../../api';
import { MANAGED_CHAT_PROVIDERS, managedChatDefaultDescriptors, type ManagedChatDefaults as Defaults } from '../../../../src/managed-chat-defaults';

export function ManagedChatDefaults({ canSave }: { canSave: boolean }): JSX.Element {
  const [draft, setDraft] = useState<Defaults | null>(null);
  const [saved, setSaved] = useState<Defaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void getManagedChatDefaults().then(value => {
      if (active) { setDraft(value); setSaved(value); }
    }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, []);
  const save = async () => {
    if (!draft || saving) return;
    setSaving(true); setError(null);
    try { const value = await updateManagedChatDefaults(draft); setSaved(value); setDraft(value); }
    catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
  };
  return (
    <div>
      {draft ? MANAGED_CHAT_PROVIDERS.map(provider => {
        const name = provider === 'claude_code' ? 'Claude' : 'Codex';
        return <fieldset className="settings-view__chat-defaults" key={provider} disabled={!canSave || saving}>
          <legend>{name}</legend>
          {managedChatDefaultDescriptors(provider).map(option => {
            const id = option.id as 'model' | 'effort' | 'permission_mode';
            const value = draft[provider][id];
            const edit = (next: string) => setDraft(current => current ? { ...current, [provider]: { ...current[provider], [id]: next } } : current);
            return <label className="settings-view__select-row" data-settings-searchable key={id}>
              <span className="settings-view__select-label">{option.label}</span>
              {id === 'model' ? <>
                <input aria-label={`${name} model`} value={value} list={`chat-default-models-${provider}`} onInput={event => edit(event.currentTarget.value)} />
                <datalist id={`chat-default-models-${provider}`}>{option.choices.map(choice => <option value={choice.value}>{choice.label}</option>)}</datalist>
              </> : <NativeSelect aria-label={`${name} ${option.label}`} value={value} onChange={event => edit(event.currentTarget.value)}>
                {option.choices.map(choice => <option value={choice.value}>{choice.label}</option>)}
              </NativeSelect>}
            </label>;
          })}
        </fieldset>;
      }) : null}
      {error ? <p className="settings-view__warning" role="alert">{error}</p> : null}
      {draft ? <button type="button" disabled={!canSave || saving || JSON.stringify(saved) === JSON.stringify(draft)} onClick={() => { void save(); }}>Save chat defaults</button> : null}
    </div>
  );
}
