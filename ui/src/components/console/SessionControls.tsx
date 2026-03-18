import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useState } from 'preact/hooks';
import {
  updateConsoleSession,
  updateConsoleSessionOptions,
} from '../../api';

type SessionControlsProps = {
  sessionId: string;
  backendType: 'pty' | 'sdk';
  model: string | undefined;
  modelOptions: string[];
  onModelSaved?: (model: string | undefined) => void;
};

export function SessionControls({
  sessionId,
  backendType,
  model,
  modelOptions,
  onModelSaved,
}: SessionControlsProps): JSX.Element {
  const [draftModel, setDraftModel] = useState(model ?? '');
  const [permissionMode, setPermissionMode] = useState<'default' | 'acceptEdits' | 'bypassPermissions'>('default');
  const [maxTurns, setMaxTurns] = useState('');
  const [maxCostUsd, setMaxCostUsd] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftModel(model ?? '');
  }, [model]);

  const handleModelOnlySave = async (nextModel: string) => {
    setSaving(true);
    setError(null);
    try {
      await updateConsoleSession(sessionId, { model: nextModel || undefined });
      onModelSaved?.(nextModel || undefined);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to save model');
    } finally {
      setSaving(false);
    }
  };

  const handleSdkSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateConsoleSessionOptions(sessionId, {
        model: draftModel || undefined,
        permissionMode,
        maxTurns: maxTurns.trim() ? Number(maxTurns) : undefined,
        maxCostUsd: maxCostUsd.trim() ? Number(maxCostUsd) : undefined,
      });
      onModelSaved?.(draftModel || undefined);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to save session options');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="session-controls">
      <div className="session-controls__row">
        <label className="session-controls__field">
          <span className="session-controls__label">Model</span>
          <select
            className="session-controls__select"
            value={draftModel}
            disabled={saving}
            onChange={(event) => {
              const nextModel = event.currentTarget.value;
              setDraftModel(nextModel);
              if (backendType === 'pty') {
                void handleModelOnlySave(nextModel);
              }
            }}
          >
            <option value="">default</option>
            {modelOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>

        {backendType === 'sdk' && (
          <label className="session-controls__field">
            <span className="session-controls__label">Permissions</span>
            <select
              className="session-controls__select"
              value={permissionMode}
              disabled={saving}
              onChange={(event) => setPermissionMode(
                event.currentTarget.value as 'default' | 'acceptEdits' | 'bypassPermissions',
              )}
            >
              <option value="default">Ask each time</option>
              <option value="acceptEdits">Accept edits</option>
              <option value="bypassPermissions">Bypass permissions</option>
            </select>
          </label>
        )}
      </div>

      {backendType === 'sdk' && (
        <div className="session-controls__row">
          <label className="session-controls__field">
            <span className="session-controls__label">Max turns</span>
            <input
              className="session-controls__input"
              type="number"
              min="1"
              step="1"
              value={maxTurns}
              disabled={saving}
              onInput={(event) => setMaxTurns(event.currentTarget.value)}
              placeholder="Unlimited"
            />
          </label>
          <label className="session-controls__field">
            <span className="session-controls__label">Max cost (USD)</span>
            <input
              className="session-controls__input"
              type="number"
              min="0"
              step="0.01"
              value={maxCostUsd}
              disabled={saving}
              onInput={(event) => setMaxCostUsd(event.currentTarget.value)}
              placeholder="Unlimited"
            />
          </label>
          <div className="session-controls__actions">
            <button
              type="button"
              className="session-controls__button"
              disabled={saving}
              onClick={() => { void handleSdkSave(); }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {error && <div className="session-controls__error">{error}</div>}
    </div>
  );
}
