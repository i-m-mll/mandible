import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  bootstrapRuntime,
  getBackupStatus,
  getAuthAutoApproveStatus,
  getDesktopDaemonStatus,
  getRuntimeStatus,
  isDesktopShell,
  navigateToDesktopBootstrap,
  resetRuntime,
  restartDesktopDaemon,
  rollbackRuntime,
  runBackupNow,
  setDesktopDaemonLaunchMode,
  setupDelegatedSigning,
  startDesktopDaemon,
  stopDesktopDaemon,
  updateBackupSettings,
  updateRuntime,
  type BackupStatus,
  type AuthAutoApproveStatus,
  type DesktopDaemonLaunchMode,
  type DesktopDaemonStatus,
  type RuntimeStatus,
} from '../api';

export type SettingsViewProps = {
  settings: Record<string, string>;
  onSave: (key: string, value: string) => Promise<void>;
};

type FeedbackState = {
  type: 'success' | 'error';
  message: string;
} | null;

const SOUNDS = ['Blow', 'Glass', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink'];
const THEMES = [
  'catppuccin-mocha',
  'catppuccin-macchiato',
  'catppuccin-frappe',
  'catppuccin-latte',
  'tokyo-night',
  'gruvbox',
  'nord',
];
const PROMPTS = ['powerlevel10k', 'starship'];
const MULTIPLEXERS = ['zellij', 'tmux', 'both', 'none'];
const RESUME_CONFLICT_POLICIES = ['prompt', 'auto_fork', 'allow_concurrent'];
const RESUME_CONFLICT_LABELS: Record<string, string> = {
  prompt: 'Ask me each time',
  auto_fork: 'Auto-fork (create new conversation)',
  allow_concurrent: 'Allow concurrent (resume in-place)',
};
// Bug: cbbb3d9 — auto-resume policy for work-unit continuations
const AUTO_RESUME_POLICIES = ['manual'];
const AUTO_RESUME_LABELS: Record<string, string> = {
  manual: 'Manual (user clicks Resume)',
};
const DESKTOP_DAEMON_MODES: DesktopDaemonLaunchMode[] = ['on_demand', 'manual'];

function Toggle(props: {
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      className={
        'settings-view__toggle' + (props.enabled ? ' settings-view__toggle--on' : '')
      }
      onClick={props.onToggle}
      disabled={props.disabled}
      role="switch"
      aria-checked={props.enabled}
      aria-label={props.label}
    >
      <span className="settings-view__toggle-knob" />
    </button>
  );
}

function ToggleRow(props: {
  title: string;
  desc: string;
  settingKey: string;
  settings: Record<string, string>;
  onSave: (key: string, value: string) => Promise<void>;
  warning?: string;
}) {
  const [toggling, setToggling] = useState(false);
  const enabled = props.settings[props.settingKey] === 'true';

  const handleToggle = useCallback(async () => {
    setToggling(true);
    try {
      await props.onSave(props.settingKey, enabled ? 'false' : 'true');
    } catch {
      // ignore
    } finally {
      setToggling(false);
    }
  }, [enabled, props.onSave, props.settingKey]);

  return (
    <div className="settings-view__toggle-row">
      <div className="settings-view__toggle-info">
        <h3 className="settings-view__section-title">{props.title}</h3>
        <p className="settings-view__section-desc">{props.desc}</p>
        {props.warning && !enabled && (
          <p className="settings-view__warning">{props.warning}</p>
        )}
      </div>
      <Toggle enabled={enabled} onToggle={handleToggle} disabled={toggling} label={`Toggle ${props.title}`} />
    </div>
  );
}

function NumberInput(props: {
  label: string;
  desc: string;
  settingKey: string;
  settings: Record<string, string>;
  onSave: (key: string, value: string) => Promise<void>;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const feedbackTimer = useRef<number | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    const incoming = props.settings[props.settingKey];
    if (typeof incoming === 'string' && !initialized.current) {
      setValue(incoming);
      initialized.current = true;
    }
  }, [props.settings[props.settingKey]]);

  const showFeedback = useCallback((state: FeedbackState) => {
    if (feedbackTimer.current != null) window.clearTimeout(feedbackTimer.current);
    setFeedback(state);
    if (state) {
      feedbackTimer.current = window.setTimeout(() => {
        setFeedback(null);
        feedbackTimer.current = null;
      }, 3000);
    }
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await props.onSave(props.settingKey, value);
      showFeedback({ type: 'success', message: 'Saved' });
    } catch (err) {
      showFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setSaving(false);
    }
  }, [value, props.onSave, props.settingKey, showFeedback]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleSave();
  }, [handleSave]);

  return (
    <div className="settings-view__number-row">
      <div className="settings-view__number-info">
        <span className="settings-view__number-label">{props.label}</span>
        {props.desc && <span className="settings-view__number-desc">{props.desc}</span>}
      </div>
      <div className="settings-view__number-controls">
        <input
          type="number"
          className="settings-view__number-input"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={handleKeyDown}
          min={props.min}
          max={props.max}
          disabled={saving}
        />
        {props.suffix && <span className="settings-view__number-suffix">{props.suffix}</span>}
        <button type="button" className="btn btn--active btn--sm" onClick={handleSave} disabled={saving}>
          {saving ? '...' : 'Save'}
        </button>
        {feedback && (
          <span className={feedback.type === 'success' ? 'settings-view__feedback settings-view__feedback--success' : 'settings-view__feedback settings-view__feedback--error'}>
            {feedback.message}
          </span>
        )}
      </div>
    </div>
  );
}

function SelectInput(props: {
  label: string;
  desc: string;
  settingKey: string;
  settings: Record<string, string>;
  onSave: (key: string, value: string) => Promise<void>;
  options: string[];
  requiresRestart?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const current = props.settings[props.settingKey] ?? props.options[0];

  const handleChange = useCallback(async (e: Event) => {
    const newValue = (e.target as HTMLSelectElement).value;
    setSaving(true);
    try {
      await props.onSave(props.settingKey, newValue);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }, [props.onSave, props.settingKey]);

  return (
    <div className="settings-view__select-row">
      <div className="settings-view__select-info">
        <span className="settings-view__select-label">{props.label}</span>
        {props.desc && <span className="settings-view__select-desc">{props.desc}</span>}
        {props.requiresRestart && (
          <span className="settings-view__badge--restart">shell restart</span>
        )}
      </div>
      <select
        className="settings-view__select"
        value={current}
        onChange={handleChange}
        disabled={saving}
      >
        {props.options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </div>
  );
}

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function DelegatedSigningSection(): JSX.Element {
  const [status, setStatus] = useState<AuthAutoApproveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  const load = useCallback(() => {
    getAuthAutoApproveStatus()
      .then(setStatus)
      .catch((err) => setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to load auth status',
      }));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSetup = useCallback(async () => {
    setBusy(true);
    setFeedback(null);
    try {
      await setupDelegatedSigning({});
      load();
      setFeedback({ type: 'success', message: 'Delegated signing key created' });
    } catch (err) {
      setFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Setup failed' });
    } finally {
      setBusy(false);
    }
  }, [load]);

  const signing = status?.signing;

  return (
    <div className="settings-view__delegated-signing">
      <div className="settings-view__number-row">
        <div className="settings-view__number-info">
          <span className="settings-view__number-label">Delegated signing key</span>
          <span className="settings-view__number-desc">
            {signing?.configured
              ? 'Ready for temporary auto-approve leases.'
              : 'Create a local signing key wrapped by a YubiKey age identity.'}
          </span>
        </div>
        <div className="settings-view__number-controls">
          <button
            type="button"
            className="btn btn--active btn--sm"
            onClick={handleSetup}
            disabled={busy || signing?.configured === true}
          >
            {busy ? 'Setting up...' : signing?.configured ? 'Configured' : 'Set up'}
          </button>
          {signing && signing.missing_tools.length > 0 && (
            <span className="settings-view__feedback settings-view__feedback--error">
              Missing {signing.missing_tools.join(', ')}
            </span>
          )}
        </div>
      </div>
      {signing?.public_key && (
        <div className="settings-view__field">
          <textarea
            className="settings-view__input settings-view__input--mono"
            value={signing.public_key}
            readOnly
            rows={3}
          />
        </div>
      )}
      {feedback && (
        <div className={feedback.type === 'success' ? 'settings-view__feedback settings-view__feedback--success' : 'settings-view__feedback settings-view__feedback--error'}>
          {feedback.message}
        </div>
      )}
    </div>
  );
}

function formatDaemonState(state: DesktopDaemonStatus['state']): string {
  switch (state) {
    case 'running':
      return 'Running';
    case 'starting':
      return 'Starting';
    case 'stale_pid':
      return 'Stale PID';
    case 'port_conflict':
      return 'Port conflict';
    default:
      return 'Stopped';
  }
}

function DesktopDaemonSection(): JSX.Element | null {
  const desktopShell = isDesktopShell();
  const [status, setStatus] = useState<DesktopDaemonStatus | null>(null);
  const [loading, setLoading] = useState(desktopShell);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!desktopShell) {
      return;
    }
    try {
      const next = await getDesktopDaemonStatus();
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load daemon status');
    } finally {
      setLoading(false);
    }
  }, [desktopShell]);

  useEffect(() => {
    if (!desktopShell) {
      return;
    }
    let cancelled = false;

    const load = async () => {
      try {
        const next = await getDesktopDaemonStatus();
        if (!cancelled) {
          setStatus(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load daemon status');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [desktopShell]);

  const handleLaunchModeChange = useCallback(async (e: Event) => {
    const value = (e.target as HTMLSelectElement).value as DesktopDaemonLaunchMode;
    setAction('mode');
    try {
      const next = await setDesktopDaemonLaunchMode(value);
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update launch mode');
    } finally {
      setAction(null);
    }
  }, []);

  const handleStart = useCallback(async () => {
    setAction('start');
    try {
      const next = await startDesktopDaemon();
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start daemon');
    } finally {
      setAction(null);
    }
  }, []);

  const handleStop = useCallback(async () => {
    setAction('stop');
    try {
      await stopDesktopDaemon();
      await navigateToDesktopBootstrap();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop daemon');
      setAction(null);
    }
  }, []);

  const handleRestart = useCallback(async () => {
    setAction('restart');
    try {
      await restartDesktopDaemon();
      await navigateToDesktopBootstrap();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart daemon');
      setAction(null);
    }
  }, []);

  if (!desktopShell) {
    return null;
  }

  return (
    <div className="settings-view__section">
      <div className="settings-view__section-header">
        <h3 className="settings-view__section-title">Mandible Daemon</h3>
        <p className="settings-view__section-desc">
          Desktop shell lifecycle controls for the local Mandible daemon.
        </p>
      </div>

      <div className="settings-view__section-body">
        <div className="settings-view__select-row">
          <div className="settings-view__select-info">
            <span className="settings-view__select-label">Launch mode</span>
            <span className="settings-view__select-desc">
              Choose whether opening the desktop app should start Mandible automatically.
            </span>
          </div>
          <select
            className="settings-view__select"
            value={status?.launch_mode ?? 'on_demand'}
            onChange={handleLaunchModeChange}
            disabled={action === 'mode' || loading}
          >
            {DESKTOP_DAEMON_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode === 'on_demand' ? 'on demand' : 'manual'}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-view__daemon-card">
          <div className="settings-view__daemon-status-row">
            <div>
              <div className="settings-view__daemon-title">
                Status
                {status && (
                  <span className={`settings-view__daemon-badge settings-view__daemon-badge--${status.state}`}>
                    {formatDaemonState(status.state)}
                  </span>
                )}
              </div>
              <div className="settings-view__daemon-meta">
                {loading ? 'Checking daemon health…' : `Port ${status?.port ?? 19420}`}
                {status?.pid ? ` • PID ${status.pid}` : ''}
              </div>
            </div>
            <div className="settings-view__daemon-actions">
              <button
                type="button"
                className="btn btn--active btn--sm"
                onClick={handleStart}
                disabled={loading || action != null || status?.healthy === true}
              >
                {action === 'start' ? '...' : 'Start'}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={handleRestart}
                disabled={loading || action != null || !status}
              >
                {action === 'restart' ? '...' : 'Restart'}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={handleStop}
                disabled={loading || action != null || !status || status.state === 'stopped'}
              >
                {action === 'stop' ? '...' : 'Stop'}
              </button>
              <a href="#/logs" className="btn btn--sm">
                View logs
              </a>
            </div>
          </div>
          {status?.detail && (
            <div className="settings-view__daemon-detail">{status.detail}</div>
          )}
          {status && (
            <div className="settings-view__daemon-paths">
              <span>PID file: {status.pid_file}</span>
              <span>Log file: {status.log_file}</span>
            </div>
          )}
          {error && (
            <div className="settings-view__daemon-error">{error}</div>
          )}
          <div className="settings-view__daemon-footer">
            {status?.launch_mode === 'manual'
              ? 'Manual mode leaves the daemon stopped until you start it explicitly from the desktop shell.'
              : 'On-demand mode starts Mandible automatically when the desktop shell opens and the daemon is absent.'}
          </div>
          <button type="button" className="btn btn--sm" onClick={refreshStatus} disabled={loading || action != null}>
            Refresh status
          </button>
        </div>
      </div>
    </div>
  );
}

function BackupSection(): JSX.Element {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    getBackupStatus().then(setStatus).catch(() => {});
  }, []);

  const handleToggle = useCallback(async () => {
    if (!status) return;
    setToggling(true);
    try {
      const newEnabled = !status.enabled;
      await updateBackupSettings({ enabled: newEnabled });
      setStatus((prev) => prev ? { ...prev, enabled: newEnabled } : prev);
    } catch {
      // ignore
    } finally {
      setToggling(false);
    }
  }, [status]);

  const handleIntervalChange = useCallback(async (e: Event) => {
    const hours = parseInt((e.target as HTMLSelectElement).value, 10);
    if (!Number.isFinite(hours)) return;
    try {
      await updateBackupSettings({ interval_hours: hours });
      setStatus((prev) => prev ? { ...prev, interval_hours: hours } : prev);
    } catch {
      // ignore
    }
  }, []);

  const handleRunNow = useCallback(async () => {
    setRunning(true);
    setRunError(null);
    try {
      const result = await runBackupNow();
      if (result.ok) {
        // Refresh status to get updated last_run_at / last_size_bytes
        const updated = await getBackupStatus();
        setStatus(updated);
      } else {
        setRunError(result.error ?? 'Backup failed');
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Backup failed');
    } finally {
      setRunning(false);
    }
  }, []);

  const enabled = status?.enabled ?? true;

  return (
    <div className="settings-view__section">
      <div className="settings-view__section-header">
        <h3 className="settings-view__section-title">Backup</h3>
        <p className="settings-view__section-desc">
          Automatic metadata dump to private/backups/.
        </p>
      </div>

      <div className="settings-view__section-body">
        {/* Toggle row */}
        <div className="settings-view__toggle-row">
          <div className="settings-view__toggle-info">
            <h3 className="settings-view__section-title">Automatic backup</h3>
            <p className="settings-view__section-desc">Run mandible-backup on a schedule.</p>
          </div>
          <Toggle
            enabled={enabled}
            onToggle={handleToggle}
            disabled={toggling || status === null}
            label="Toggle automatic backup"
          />
        </div>

        {/* Interval selector — only shown when enabled */}
        {enabled && (
          <div className="settings-view__select-row">
            <div className="settings-view__select-info">
              <span className="settings-view__select-label">Interval</span>
            </div>
            <select
              className="settings-view__select"
              value={status?.interval_hours ?? 6}
              onChange={handleIntervalChange}
            >
              <option value={6}>6h</option>
              <option value={12}>12h</option>
              <option value={24}>24h</option>
            </select>
          </div>
        )}

        {/* Status row */}
        <div className="settings-view__number-row">
          <div className="settings-view__number-info">
            <span className="settings-view__number-label">Last backup</span>
          </div>
          <div className="settings-view__number-controls">
            {status === null ? (
              <span className="text-muted">Loading...</span>
            ) : status.last_run_at ? (
              <span>
                {formatRelativeTime(status.last_run_at)}
                {status.last_size_bytes != null && (
                  <span className="text-muted"> &mdash; {formatBytes(status.last_size_bytes)}</span>
                )}
              </span>
            ) : (
              <span className="text-muted">Never</span>
            )}
            {status?.last_error && (
              <span style={{ color: 'var(--color-error, #f38ba8)', marginLeft: '0.5rem' }}>
                {status.last_error}
              </span>
            )}
          </div>
        </div>

        {/* Run Now button */}
        <div className="settings-view__number-row">
          <div className="settings-view__number-info">
            <span className="settings-view__number-label">Manual run</span>
          </div>
          <div className="settings-view__number-controls">
            <button
              type="button"
              className="btn btn--active btn--sm"
              onClick={handleRunNow}
              disabled={running || status === null}
            >
              {running ? '...' : 'Run Now'}
            </button>
            {runError && (
              <span className="settings-view__feedback settings-view__feedback--error">
                {runError}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Bug: cc4688b — Zone 2 mutable runtime section
function RuntimeSection(): JSX.Element {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getRuntimeStatus();
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runtime status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleBootstrap = useCallback(async () => {
    setAction('bootstrap');
    setFeedback(null);
    try {
      await bootstrapRuntime();
      setFeedback('Bootstrap started. This may take a minute...');
      // Poll for completion
      const timer = window.setInterval(async () => {
        try {
          const next = await getRuntimeStatus();
          setStatus(next);
          if (next.available) {
            window.clearInterval(timer);
            setFeedback('Zone 2 runtime initialized successfully.');
            setAction(null);
          }
        } catch {
          // keep polling
        }
      }, 3000);
      // Safety timeout: stop polling after 3 minutes
      window.setTimeout(() => {
        window.clearInterval(timer);
        setAction(null);
      }, 180_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bootstrap failed');
      setAction(null);
    }
  }, []);

  const handleUpdate = useCallback(async () => {
    setAction('update');
    setFeedback(null);
    try {
      const result = await updateRuntime();
      if (result.updated) {
        setFeedback('Update applied successfully.');
      } else {
        setFeedback(result.message ?? 'Already up to date.');
      }
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setAction(null);
    }
  }, [refreshStatus]);

  const handleRollback = useCallback(async () => {
    setAction('rollback');
    setFeedback(null);
    try {
      await rollbackRuntime();
      setFeedback('Last patch rolled back.');
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rollback failed');
    } finally {
      setAction(null);
    }
  }, [refreshStatus]);

  const handleReset = useCallback(async () => {
    setAction('reset');
    setFeedback(null);
    try {
      await resetRuntime();
      setFeedback('Reset to upstream complete.');
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setAction(null);
    }
  }, [refreshStatus]);

  return (
    <div className="settings-view__section">
      <div className="settings-view__section-header">
        <h3 className="settings-view__section-title">Runtime</h3>
        <p className="settings-view__section-desc">
          Zone 2 mutable runtime for self-modification and patching.
        </p>
      </div>

      <div className="settings-view__section-body">
        {/* Install mode */}
        <div className="settings-view__number-row">
          <div className="settings-view__number-info">
            <span className="settings-view__number-label">Install mode</span>
          </div>
          <div className="settings-view__number-controls">
            {loading ? (
              <span className="text-muted">Loading...</span>
            ) : (
              <span>{status?.installMode ?? 'unknown'}</span>
            )}
          </div>
        </div>

        {/* Zone 2 path */}
        <div className="settings-view__number-row">
          <div className="settings-view__number-info">
            <span className="settings-view__number-label">Zone 2 path</span>
          </div>
          <div className="settings-view__number-controls">
            {loading ? (
              <span className="text-muted">Loading...</span>
            ) : (
              <span className="text-muted" style={{ fontSize: '0.85em', wordBreak: 'break-all' }}>
                {status?.zone2Path ?? 'N/A'}
                {status?.available ? ' (active)' : ' (not initialized)'}
              </span>
            )}
          </div>
        </div>

        {/* Git info (only when available) */}
        {status?.available && (
          <>
            <div className="settings-view__number-row">
              <div className="settings-view__number-info">
                <span className="settings-view__number-label">Commit</span>
              </div>
              <div className="settings-view__number-controls">
                <span className="text-muted" style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
                  {status.commit ? status.commit.slice(0, 12) : 'unknown'}
                </span>
                {status.branch && (
                  <span className="text-muted" style={{ marginLeft: '0.5rem' }}>
                    ({status.branch})
                  </span>
                )}
              </div>
            </div>

            <div className="settings-view__number-row">
              <div className="settings-view__number-info">
                <span className="settings-view__number-label">Local patches</span>
              </div>
              <div className="settings-view__number-controls">
                <span>{status.patchCount}</span>
              </div>
            </div>
          </>
        )}

        {/* Actions */}
        <div className="settings-view__number-row">
          <div className="settings-view__number-info">
            <span className="settings-view__number-label">Actions</span>
          </div>
          <div className="settings-view__number-controls" style={{ gap: '0.5rem', display: 'flex', flexWrap: 'wrap' }}>
            {!status?.available && (
              <button
                type="button"
                className="btn btn--active btn--sm"
                onClick={handleBootstrap}
                disabled={loading || action != null}
              >
                {action === 'bootstrap' ? '...' : 'Initialize Runtime'}
              </button>
            )}
            {status?.available && (
              <>
                <button
                  type="button"
                  className="btn btn--active btn--sm"
                  onClick={handleUpdate}
                  disabled={loading || action != null}
                >
                  {action === 'update' ? '...' : 'Check for Updates'}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={handleRollback}
                  disabled={loading || action != null || (status.patchCount ?? 0) === 0}
                >
                  {action === 'rollback' ? '...' : 'Rollback Last Patch'}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={handleReset}
                  disabled={loading || action != null}
                >
                  {action === 'reset' ? '...' : 'Reset to Upstream'}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Feedback / error */}
        {feedback && (
          <div className="settings-view__number-row">
            <div className="settings-view__number-info" />
            <div className="settings-view__number-controls">
              <span className="settings-view__feedback settings-view__feedback--success">
                {feedback}
              </span>
            </div>
          </div>
        )}
        {error && (
          <div className="settings-view__number-row">
            <div className="settings-view__number-info" />
            <div className="settings-view__number-controls">
              <span className="settings-view__feedback settings-view__feedback--error">
                {error}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function SettingsView(props: SettingsViewProps): JSX.Element {
  const { settings, onSave } = props;
  const [protectedBranches, setProtectedBranches] = useState('');
  const [quietHours, setQuietHours] = useState('');
  const [issueDefaultFilter, setIssueDefaultFilter] = useState('status:open');
  const [saving, setSaving] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const feedbackTimer = useRef<number | null>(null);
  const initialized = useRef(false);
  const quietInitialized = useRef(false);

  useEffect(() => {
    if (typeof settings.protected_branches === 'string' && !initialized.current) {
      setProtectedBranches(settings.protected_branches);
      initialized.current = true;
    }
  }, [settings.protected_branches]);

  useEffect(() => {
    if (typeof settings.quiet_hours === 'string' && !quietInitialized.current) {
      setQuietHours(settings.quiet_hours);
      quietInitialized.current = true;
    }
  }, [settings.quiet_hours]);

  useEffect(() => {
    setIssueDefaultFilter(settings['issues.default_filter']?.trim() || 'status:open');
  }, [settings['issues.default_filter']]);

  const showFeedback = useCallback((state: FeedbackState) => {
    if (feedbackTimer.current != null) window.clearTimeout(feedbackTimer.current);
    setFeedback(state);
    if (state) {
      feedbackTimer.current = window.setTimeout(() => {
        setFeedback(null);
        feedbackTimer.current = null;
      }, 3000);
    }
  }, []);

  const handleSaveField = useCallback(async (key: string, value: string) => {
    setSaving(key);
    try {
      await onSave(key, value);
      showFeedback({ type: 'success', message: 'Saved' });
    } catch (err) {
      showFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setSaving(null);
    }
  }, [onSave, showFeedback]);

  const handleKeyDown = useCallback(
    (key: string, value: string) => (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleSaveField(key, value);
    },
    [handleSaveField],
  );

  return (
    <div className="settings-view">
      <div className="view-header">
        <div>
          <h2>Settings</h2>
          <div className="text-muted">Mandible configuration.</div>
        </div>
      </div>

      {/* ── Section 1: Notifications ── */}
      <div className="settings-view__section">
        <div className="settings-view__section-header">
          <h3 className="settings-view__section-title">Notifications</h3>
          <p className="settings-view__section-desc">
            Desktop alerts when AI tools finish and are waiting for input.
          </p>
        </div>

        <div className="settings-view__section-body">
          <ToggleRow
            title="Claude notifications"
            desc="Show desktop notification when Claude Code stops."
            settingKey="claude_notifications_enabled"
            settings={settings}
            onSave={onSave}
          />
          <ToggleRow
            title="Codex notifications"
            desc="Show desktop notification when Codex CLI stops."
            settingKey="codex_notifications_enabled"
            settings={settings}
            onSave={onSave}
          />
          <SelectInput
            label="Sound"
            desc="macOS notification sound"
            settingKey="notification_sound"
            settings={settings}
            onSave={onSave}
            options={SOUNDS}
          />
          <div className="settings-view__text-row">
            <div className="settings-view__text-info">
              <span className="settings-view__text-label">Quiet hours</span>
              <span className="settings-view__text-desc">Suppress notifications during this window (HH:MM-HH:MM)</span>
            </div>
            <div className="settings-view__text-controls">
              <input
                type="text"
                className="settings-view__input settings-view__input--narrow"
                value={quietHours}
                onInput={(e) => setQuietHours((e.target as HTMLInputElement).value)}
                onKeyDown={handleKeyDown('quiet_hours', quietHours)}
                placeholder="22:00-08:00"
                disabled={saving === 'quiet_hours'}
              />
              <button
                type="button"
                className="btn btn--active btn--sm"
                onClick={() => void handleSaveField('quiet_hours', quietHours)}
                disabled={saving === 'quiet_hours'}
              >
                {saving === 'quiet_hours' ? '...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Section 2: Process Management ── */}
      <DesktopDaemonSection />

      <div className="settings-view__section">
        <div className="settings-view__section-header">
          <h3 className="settings-view__section-title">Process Management</h3>
          <p className="settings-view__section-desc">
            Automatic cleanup of idle AI processes in multiplexer panes.
          </p>
        </div>

        <div className="settings-view__section-body">
          <ToggleRow
            title="Reaper"
            desc="Automatically terminate idle Claude/Codex processes."
            settingKey="reaper_enabled"
            settings={settings}
            onSave={onSave}
          />
          <NumberInput
            label="Claude idle threshold"
            desc=""
            settingKey="reaper_claude_idle_minutes"
            settings={settings}
            onSave={onSave}
            min={5}
            max={480}
            suffix="min"
          />
          <NumberInput
            label="Codex idle threshold"
            desc=""
            settingKey="reaper_codex_idle_minutes"
            settings={settings}
            onSave={onSave}
            min={5}
            max={480}
            suffix="min"
          />
          <ToggleRow
            title="Dry run"
            desc="Log what would be reaped without actually terminating."
            settingKey="reaper_dry_run"
            settings={settings}
            onSave={onSave}
          />
          <ToggleRow
            title="Cleanup orphan MCPs"
            desc="Terminate MCP server processes whose parent has exited."
            settingKey="reaper_cleanup_orphan_mcps"
            settings={settings}
            onSave={onSave}
          />
        </div>
      </div>

      {/* ── Section 3: Agent Hooks ── */}
      <div className="settings-view__section">
        <div className="settings-view__section-header">
          <h3 className="settings-view__section-title">Agent Hooks</h3>
          <p className="settings-view__section-desc">
            PreToolUse safety hooks and subagent behavior.
          </p>
        </div>

        <div className="settings-view__section-body">
          <ToggleRow
            title="PreToolUse hooks"
            desc="Safety hooks that block dangerous git operations (merge into protected branch, raw commit, etc)."
            settingKey="pretool_hooks_enabled"
            settings={settings}
            onSave={onSave}
            warning="Disabling hooks removes safety guards. Agents may execute dangerous operations unchecked."
          />
          <ToggleRow
            title="Subagent panes"
            desc="Spawn Zellij panes for subagent output streams. Requires Zellij and a working zj-control plugin."
            settingKey="subagent_panes_enabled"
            settings={settings}
            onSave={onSave}
          />
        </div>
      </div>

      {/* ── Section: Conversation Branching ── */}
      <div className="settings-view__section">
        <div className="settings-view__section-header">
          <h3 className="settings-view__section-title">Conversation Branching</h3>
          <p className="settings-view__section-desc">
            How to handle resume when the conversation is already active in Console.
          </p>
        </div>

        <div className="settings-view__section-body">
          <div className="settings-view__select-row">
            <div className="settings-view__select-info">
              <span className="settings-view__select-label">Resume conflict policy</span>
              <span className="settings-view__select-desc">
                What to do when resuming a conversation that is already active in Console.
              </span>
            </div>
            <select
              className="settings-view__select"
              value={settings.resume_conflict_policy ?? 'prompt'}
              onChange={async (e) => {
                try {
                  await onSave('resume_conflict_policy', (e.target as HTMLSelectElement).value);
                } catch { /* ignore */ }
              }}
            >
              {RESUME_CONFLICT_POLICIES.map((p) => (
                <option key={p} value={p}>{RESUME_CONFLICT_LABELS[p] ?? p}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ── Section: Work Queue ── Bug: cbbb3d9 */}
      <div className="settings-view__section">
        <div className="settings-view__section-header">
          <h3 className="settings-view__section-title">Work Queue</h3>
          <p className="settings-view__section-desc">
            How to handle work-unit continuations (handoff notes from ended sessions).
          </p>
        </div>

        <div className="settings-view__section-body">
          <div className="settings-view__select-row">
            <div className="settings-view__select-info">
              <span className="settings-view__select-label">Auto-resume policy</span>
              <span className="settings-view__select-desc">
                When a session ends with a continuation, how should the work be resumed?
              </span>
            </div>
            <select
              className="settings-view__select"
              value={settings.auto_resume_policy ?? 'manual'}
              onChange={async (e) => {
                try {
                  await onSave('auto_resume_policy', (e.target as HTMLSelectElement).value);
                } catch { /* ignore */ }
              }}
            >
              {AUTO_RESUME_POLICIES.map((p) => (
                <option key={p} value={p}>{AUTO_RESUME_LABELS[p] ?? p}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ── Section: Issues ── */}
      <div className="settings-view__section">
        <div className="settings-view__section-header">
          <h3 className="settings-view__section-title">Issues</h3>
          <p className="settings-view__section-desc">
            Defaults for the issue ledger browser.
          </p>
        </div>

        <div className="settings-view__section-body">
          <div className="settings-view__text-row">
            <div className="settings-view__text-info">
              <span className="settings-view__text-label">Default filter</span>
              <span className="settings-view__text-desc">
                Applied when the Issues tab opens. Supports status, kind, and priority tokens.
              </span>
            </div>
            <div className="settings-view__text-controls">
              <input
                type="text"
                className="settings-view__input settings-view__input--wide"
                value={issueDefaultFilter}
                onInput={(e) => setIssueDefaultFilter((e.target as HTMLInputElement).value)}
                onKeyDown={handleKeyDown('issues.default_filter', issueDefaultFilter)}
                placeholder="status:open"
                disabled={saving === 'issues.default_filter'}
              />
              <button
                type="button"
                className="btn btn--active btn--sm"
                onClick={() => void handleSaveField('issues.default_filter', issueDefaultFilter.trim() || 'status:open')}
                disabled={saving === 'issues.default_filter'}
              >
                {saving === 'issues.default_filter' ? '...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Section 4: Appearance ── */}
      <div className="settings-view__section">
        <div className="settings-view__section-header">
          <h3 className="settings-view__section-title">Appearance</h3>
          <p className="settings-view__section-desc">
            Shell theme, prompt, and multiplexer. Changes take effect in new shell sessions.
          </p>
        </div>

        <div className="settings-view__section-body">
          {/* Bug: 914e9d7 — Header tab display mode */}
          <div className="settings-view__select-row">
            <div className="settings-view__select-info">
              <span className="settings-view__select-label">Header tabs</span>
              <span className="settings-view__select-desc">Show text labels, icons, or both in header tabs</span>
            </div>
            <select
              className="settings-view__select"
              value={settings.header_display_mode ?? 'text'}
              onChange={async (e) => {
                try {
                  await onSave('header_display_mode', (e.target as HTMLSelectElement).value);
                } catch { /* ignore */ }
              }}
            >
              <option value="text">Text only</option>
              <option value="icons">Icons only</option>
              <option value="both">Both</option>
            </select>
          </div>
          <SelectInput
            label="Theme"
            desc="Color theme for Neovim, Zellij, and tmux"
            settingKey="theme"
            settings={settings}
            onSave={onSave}
            options={THEMES}
            requiresRestart
          />
          <SelectInput
            label="Prompt"
            desc="Shell prompt engine"
            settingKey="prompt"
            settings={settings}
            onSave={onSave}
            options={PROMPTS}
            requiresRestart
          />
          <SelectInput
            label="Multiplexer"
            desc="Terminal multiplexer preference"
            settingKey="multiplexer"
            settings={settings}
            onSave={onSave}
            options={MULTIPLEXERS}
            requiresRestart
          />
        </div>
      </div>

      <div className="settings-view__section">
        <div className="settings-view__section-header">
          <h3 className="settings-view__section-title">Auth</h3>
          <p className="settings-view__section-desc">
            Temporary approval windows for protected operations.
          </p>
        </div>
        <div className="settings-view__section-body">
          <NumberInput
            label="Auto-approve lease"
            desc="How long the Auth tab switch stays active after YubiKey unlock."
            settingKey="auth_auto_approve_duration_minutes"
            settings={settings}
            onSave={onSave}
            min={1}
            max={480}
            suffix="min"
          />
          <ToggleRow
            title="Rebuild artifacts on approval"
            desc="For Mandible self-merges, run the generated-artifact rebuild before approving."
            settingKey="auth_rebuild_artifacts_on_approval"
            settings={settings}
            onSave={onSave}
          />
          <DelegatedSigningSection />
        </div>
      </div>

      {/* ── Section 5: Version Control ── */}
      <div className="settings-view__section">
        <div className="settings-view__section-header">
          <h3 className="settings-view__section-title">Version Control</h3>
          <p className="settings-view__section-desc">
            Comma-separated branch names that are pinned in the Work tab and used as the baseline
            for ahead/behind counts.
          </p>
        </div>
        <div className="settings-view__field">
          <input
            type="text"
            className="settings-view__input"
            value={protectedBranches}
            onInput={(e) => setProtectedBranches((e.target as HTMLInputElement).value)}
            onKeyDown={handleKeyDown('protected_branches', protectedBranches)}
            placeholder="main, develop"
            disabled={saving === 'protected_branches'}
          />
          <div className="settings-view__field-actions">
            <button
              type="button"
              className="btn btn--active"
              onClick={() => void handleSaveField('protected_branches', protectedBranches)}
              disabled={saving === 'protected_branches'}
            >
              {saving === 'protected_branches' ? 'Saving...' : 'Save'}
            </button>
            {feedback && (
              <span
                className={
                  feedback.type === 'success'
                    ? 'settings-view__feedback settings-view__feedback--success'
                    : 'settings-view__feedback settings-view__feedback--error'
                }
              >
                {feedback.message}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Section 6: Maintenance ── */}
      <div className="settings-view__section">
        <div className="settings-view__section-header">
          <h3 className="settings-view__section-title">Maintenance</h3>
          <p className="settings-view__section-desc">
            Log retention and housekeeping.
          </p>
        </div>

        <div className="settings-view__section-body">
          <NumberInput
            label="Log retention"
            desc="Days to keep Mandible logs"
            settingKey="log_retention_days"
            settings={settings}
            onSave={onSave}
            min={1}
            max={365}
            suffix="days"
          />
        </div>
      </div>

      {/* ── Section 7: Backup ── */}
      <BackupSection />

      {/* ── Section 8: Runtime ── Bug: cc4688b */}
      <RuntimeSection />
    </div>
  );
}
