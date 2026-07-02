import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useState } from 'preact/hooks';
import {
  type ConsoleSessionOptions,
  type ConsoleThinkingEffort,
  updateConsoleSession,
  updateConsoleSessionOptions,
} from '../../api';

const THINKING_EFFORT_OPTIONS: Array<{ value: ConsoleThinkingEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-high' },
  { value: 'max', label: 'Max' },
];

type SessionControlsProps = {
  sessionId: string;
  backendType: 'pty' | 'sdk' | 'acp';
  model: string | undefined;
  modelOptions: string[];
  allowedTools?: string[] | null;
  availableTools?: string[];
  onModelSaved?: (model: string | undefined) => void;
  hideModel?: boolean;
};

type SessionModelControlProps = Pick<
  SessionControlsProps,
  'sessionId' | 'backendType' | 'model' | 'modelOptions' | 'onModelSaved'
> & {
  compact?: boolean;
};

export function SessionModelControl({
  sessionId,
  backendType,
  model,
  modelOptions,
  onModelSaved,
  compact = false,
}: SessionModelControlProps): JSX.Element {
  const [draftModel, setDraftModel] = useState(model ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftModel(model ?? '');
  }, [model]);

  const handleModelOnlySave = async (nextModel: string) => {
    setSaving(true);
    setError(null);
    try {
      if (backendType === 'sdk') {
        await updateConsoleSessionOptions(sessionId, { model: nextModel || undefined });
      } else {
        await updateConsoleSession(sessionId, { model: nextModel || undefined });
      }
      onModelSaved?.(nextModel || undefined);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to save model');
    } finally {
      setSaving(false);
    }
  };

  return (
    <label className={compact ? 'session-controls__field session-controls__field--compact' : 'session-controls__field'}>
      <span className="session-controls__label">Model</span>
      <select
        className={compact ? 'session-controls__select session-controls__select--compact' : 'session-controls__select'}
        value={draftModel}
        disabled={saving}
        aria-label="Model"
        onChange={(event) => {
          const nextModel = event.currentTarget.value;
          setDraftModel(nextModel);
          if (compact || backendType === 'pty' || backendType === 'acp') {
            void handleModelOnlySave(nextModel);
          }
        }}
      >
        <option value="">default</option>
        {modelOptions.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
      {error && <span className="session-controls__error">{error}</span>}
    </label>
  );
}

export function SessionControls({
  sessionId,
  backendType,
  model,
  modelOptions,
  allowedTools,
  availableTools = [],
  onModelSaved,
  hideModel = false,
}: SessionControlsProps): JSX.Element {
  const [draftModel, setDraftModel] = useState(model ?? '');
  const [thinkingEffort, setThinkingEffort] = useState<ConsoleThinkingEffort | ''>('');
  const [permissionMode, setPermissionMode] = useState<'default' | 'acceptEdits' | 'bypassPermissions'>('default');
  const [maxTurns, setMaxTurns] = useState('');
  const [maxCostUsd, setMaxCostUsd] = useState('');
  const [draftAllowedTools, setDraftAllowedTools] = useState<string[]>(allowedTools ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supportsToolOptions = backendType === 'sdk' || backendType === 'acp';
  const supportsThinkingEffort = backendType === 'sdk';

  useEffect(() => {
    setDraftModel(model ?? '');
  }, [model]);

  useEffect(() => {
    setDraftAllowedTools(allowedTools ?? []);
  }, [allowedTools]);

  const handleSdkSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const nextOptions: ConsoleSessionOptions = {
        allowedTools: draftAllowedTools,
      };
      if (backendType === 'sdk') {
        nextOptions.model = draftModel || undefined;
        nextOptions.thinkingEffort = thinkingEffort || undefined;
        nextOptions.permissionMode = permissionMode;
        nextOptions.maxTurns = maxTurns.trim() ? Number(maxTurns) : undefined;
        nextOptions.maxCostUsd = maxCostUsd.trim() ? Number(maxCostUsd) : undefined;
      }
      await updateConsoleSessionOptions(sessionId, nextOptions);
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
        {!hideModel && (
          <SessionModelControl
            sessionId={sessionId}
            backendType={backendType}
            model={model}
            modelOptions={modelOptions}
            onModelSaved={onModelSaved}
          />
        )}

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

      {supportsToolOptions && (
        <div className="session-controls__row">
          {backendType === 'sdk' && (
            <>
              {supportsThinkingEffort && (
                <label className="session-controls__field">
                  <span className="session-controls__label">Thinking effort</span>
                  <select
                    className="session-controls__select"
                    value={thinkingEffort}
                    disabled={saving}
                    aria-label="Thinking effort"
                    onChange={(event) => setThinkingEffort(
                      event.currentTarget.value as ConsoleThinkingEffort | '',
                    )}
                  >
                    <option value="">Default</option>
                    {THINKING_EFFORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              )}
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
            </>
          )}
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

      {supportsToolOptions && (
        <div className="session-controls__tools">
          <div className="session-controls__label">Allowed tools</div>
          {availableTools.length === 0 ? (
            <div className="session-controls__placeholder">Waiting for session…</div>
          ) : (
          <div className="session-controls__tool-grid">
            {availableTools.map((tool) => {
              const enabled = draftAllowedTools.includes(tool);
              return (
                <label key={tool} className="session-controls__tool-toggle">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => {
                      setDraftAllowedTools((current) => (
                        current.includes(tool)
                          ? current.filter((entry) => entry !== tool)
                          : [...current, tool].sort()
                      ));
                    }}
                  />
                  <span>{tool}</span>
                </label>
              );
            })}
          </div>
          )}
        </div>
      )}

      {error && <div className="session-controls__error">{error}</div>}
    </div>
  );
}
