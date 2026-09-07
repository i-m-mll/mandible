import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { formatRelativeTime } from '../lib/format';
import {
  bootstrapRuntime,
  getBackupStatus,
  getDelegatedSigningStatus,
  getDesktopDaemonStatus,
  getRuntimeStatus,
  isDesktopShell,
  navigateToDesktopBootstrap,
  resetRuntime,
  removeDelegatedSigning,
  restartDesktopDaemon,
  rollbackRuntime,
  runBackupNow,
  setDesktopDaemonLaunchMode,
  setupDelegatedSigning,
  startDesktopDaemon,
  stopDesktopDaemon,
  getInstructionDeliverySettings,
  updateBackupSettings,
  updateInstructionDeliverySettings,
  updateRuntime,
  getProjectAccessSettings,
  listProjectsForPicker,
  updateProjectAccessSettings,
  type BackupStatus,
  type DelegatedSigningStatus,
  type DesktopDaemonLaunchMode,
  type InstructionDeliverySettings,
  type InstructionTarget,
  type InstructionTargetMode,
  type DesktopDaemonStatus,
  type RuntimeStatus,
  type ProjectAccessSettings,
  type ProjectPickerItem,
} from '../api';
import type { InstanceInfo } from '../api';
import type { UserTypographySettingKey } from '../api';
import {
  DEFAULT_TYPOGRAPHY_SETTINGS,
  typographySettingValue,
  type TypographySettings,
} from '../typography-settings';
import { AuthHooksPanel } from './auth';
import {
  APP_THEME_MODES,
  TERMINAL_THEME_IDS,
  TERMINAL_THEME_LABELS,
  normalizeAppThemeMode,
  normalizeTerminalThemeId,
} from '../theme';
import {
  SIDEBAR_GROUP_LIMIT_DEFAULT,
  SIDEBAR_GROUP_LIMIT_MAX,
  SIDEBAR_GROUP_LIMIT_MIN,
  normalizeSidebarGroupLimit,
} from '../components/shared/sidebar-group-settings';
import { BRIEFING_KEEP_SUBMITTED_ANNOTATIONS_SETTING } from './feedback/briefing-preferences';
import {
  AUTH_AUTO_RETURN_TO_OVERVIEW_SETTING,
  AUTH_AUTO_SHOW_CONSOLE_SETTING,
  AUTH_RETAIN_FINALIZED_SELECTION_SETTING,
} from '../auth-preferences';

export type SettingsViewProps = {
  settings: Record<string, string>;
  onSave: (key: string, value: string) => Promise<void>;
  onClose?: () => void;
  instance?: InstanceInfo | null;
  typography?: TypographySettings;
  onTypographySave?: (key: UserTypographySettingKey, value: string) => Promise<void>;
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
const APP_THEME_LABELS: Record<string, string> = {
  system: 'System',
  dark: 'Dark',
  light: 'Light',
};
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
const MARKDOWN_BODY_ESCAPE_POLICIES = ['warn', 'reject', 'allow'];
const DESKTOP_DAEMON_MODES: DesktopDaemonLaunchMode[] = ['on_demand', 'manual'];
const INSTRUCTION_TARGET_MODES = ['managed-block', 'standalone'] as const;

type SettingsSectionDefinition = {
  id: string;
  title: string;
  desktopOnly?: boolean;
};

const SETTINGS_SECTIONS = {
  notifications: { id: 'settings-notifications', title: 'Notifications' },
  daemon: { id: 'settings-daemon', title: 'Mandible Daemon', desktopOnly: true },
  agentHooks: { id: 'settings-agent-hooks', title: 'Agent Hooks' },
  instructionDelivery: { id: 'settings-instruction-delivery', title: 'Instruction Delivery' },
  projectPermissions: { id: 'settings-project-permissions', title: 'Project permissions' },
  briefings: { id: 'settings-briefings', title: 'Briefings' },
  conversations: { id: 'settings-conversations', title: 'Conversations' },
  conversationBranching: { id: 'settings-conversation-branching', title: 'Conversation Branching' },
  workQueue: { id: 'settings-work-queue', title: 'Work Queue' },
  issues: { id: 'settings-issues', title: 'Issues' },
  appearance: { id: 'settings-appearance', title: 'Appearance' },
  auth: { id: 'auth-settings', title: 'Auth' },
  authHooks: { id: 'settings-auth-hooks', title: 'Auth Hooks' },
  versionControl: { id: 'settings-version-control', title: 'Version Control' },
  maintenance: { id: 'settings-maintenance', title: 'Maintenance' },
  backup: { id: 'settings-backup', title: 'Backup' },
  runtime: { id: 'settings-runtime', title: 'Runtime' },
} as const;

const SETTINGS_SECTION_LIST: readonly SettingsSectionDefinition[] = Object.values(SETTINGS_SECTIONS);

function SettingsSectionShell(props: {
  section: SettingsSectionDefinition;
  children: ComponentChildren;
  testId?: string;
}): JSX.Element {
  return (
    <section
      className="settings-view__section"
      id={props.section.id}
      aria-labelledby={`${props.section.id}-title`}
      data-testid={props.testId}
    >
      {props.children}
    </section>
  );
}

function SettingsSectionHeader(props: {
  section: SettingsSectionDefinition;
  description: string;
  action?: ComponentChildren;
}): JSX.Element {
  return (
    <div className={`settings-view__section-header${props.action ? ' settings-view__section-header--action' : ''}`}>
      <div>
        <h3 className="settings-view__section-title" id={`${props.section.id}-title`}>{props.section.title}</h3>
        <p className="settings-view__section-desc">{props.description}</p>
      </div>
      {props.action}
    </div>
  );
}

function isInstructionTargetMode(value: string): value is InstructionTargetMode {
  return (INSTRUCTION_TARGET_MODES as readonly string[]).includes(value);
}

function parseInstructionTargets(value: string | undefined): InstructionTarget[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((target) => {
        if (!target || typeof target !== 'object') return null;
        const record = target as Record<string, unknown>;
        const targetPath = typeof record.path === 'string' ? record.path.trim() : '';
        const mode = typeof record.mode === 'string' && isInstructionTargetMode(record.mode)
          ? record.mode
          : 'managed-block';
        return targetPath ? { path: targetPath, mode } : null;
      })
      .filter((target): target is InstructionTarget => target !== null);
  } catch {
    return [];
  }
}

function serializeInstructionTargets(targets: InstructionTarget[]): string {
  return JSON.stringify(targets);
}

function instructionTargetKey(target: InstructionTarget): string {
  return `${target.mode}\t${target.path}`;
}

function hasRemovedInstructionTargets(previous: InstructionTarget[], next: InstructionTarget[]): boolean {
  const nextKeys = new Set(next.map(instructionTargetKey));
  return previous.some((target) => !nextKeys.has(instructionTargetKey(target)));
}

function formatInstructionExportFeedback(result: InstructionDeliverySettings, fallback: string): string {
  const cleanupCount = result.cleanup?.filter((item) => item.ok).length ?? 0;
  if (cleanupCount > 0) {
    return `${fallback}; cleaned ${cleanupCount} previous target${cleanupCount === 1 ? '' : 's'}`;
  }
  return fallback;
}

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
  defaultEnabled?: boolean;
}) {
  const [toggling, setToggling] = useState(false);
  const enabled = props.settings[props.settingKey] == null
    ? props.defaultEnabled === true
    : props.settings[props.settingKey] === 'true';

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
  defaultValue?: number;
  normalize?: (value: string) => number;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const feedbackTimer = useRef<number | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    const incoming = props.settings[props.settingKey] ?? (props.defaultValue != null ? String(props.defaultValue) : undefined);
    if (typeof incoming === 'string' && !initialized.current) {
      setValue(props.normalize ? String(props.normalize(incoming)) : incoming);
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
      const savedValue = props.normalize ? String(props.normalize(value)) : value;
      setValue(savedValue);
      await props.onSave(props.settingKey, savedValue);
      showFeedback({ type: 'success', message: 'Saved' });
    } catch (err) {
      showFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setSaving(false);
    }
  }, [value, props.onSave, props.settingKey, props.normalize, showFeedback]);

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
          aria-label={props.label}
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

function InstructionsDeliverySection(props: {
  section: SettingsSectionDefinition;
  settings: Record<string, string>;
  onSave: (key: string, value: string) => Promise<void>;
}): JSX.Element {
  const [targets, setTargets] = useState<InstructionTarget[]>([]);
  const [targetPath, setTargetPath] = useState('');
  const [targetMode, setTargetMode] = useState<InstructionTargetMode>('managed-block');
  const [targetPathDrafts, setTargetPathDrafts] = useState<Record<string, string>>({});
  const [postExport, setPostExport] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    secondaryLabel?: string;
    onConfirm: () => void;
    onSecondary?: () => void;
  } | null>(null);

  const showFeedback = useCallback((state: FeedbackState) => {
    setFeedback(state);
    if (state) {
      window.setTimeout(() => setFeedback(null), 3000);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getInstructionDeliverySettings()
      .then((delivery) => {
        if (cancelled) return;
        setTargets(delivery.targets);
        setPostExport(delivery.postExport);
      })
      .catch((err) => {
        if (cancelled) return;
        const fallbackTargets = parseInstructionTargets(props.settings['instructions.targets']);
        setTargets(fallbackTargets);
        setPostExport(props.settings['instructions.post_export'] ?? '');
        showFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load instruction delivery settings' });
      });
    return () => {
      cancelled = true;
    };
  }, [props.settings, showFeedback]);

  const applyInstructionDelivery = useCallback(async (
    request: { targets?: InstructionTarget[]; postExport?: string; cleanupRemovedTargets?: boolean; resetToDefaults?: boolean },
    successMessage: string,
  ) => {
    setSaving('instructions.delivery');
    try {
      const result = await updateInstructionDeliverySettings(request);
      setTargets(result.targets);
      setTargetPathDrafts({});
      setPostExport(result.postExport);
      if (request.targets || request.resetToDefaults) {
        await props.onSave('instructions.targets', serializeInstructionTargets(result.targets));
      }
      if (request.postExport !== undefined) {
        await props.onSave('instructions.post_export', result.postExport);
      }
      showFeedback({ type: 'success', message: formatInstructionExportFeedback(result, successMessage) });
    } catch (err) {
      showFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Failed to update instruction delivery' });
    } finally {
      setSaving(null);
    }
  }, [props.onSave, showFeedback]);

  const saveTargets = useCallback(async (nextTargets: InstructionTarget[], cleanupRemovedTargets: boolean) => {
    await applyInstructionDelivery(
      { targets: nextTargets, cleanupRemovedTargets },
      'Targets saved and exported',
    );
  }, [applyInstructionDelivery]);

  const requestTargetSave = useCallback((nextTargets: InstructionTarget[]) => {
    if (nextTargets.length === 0) {
      showFeedback({ type: 'error', message: 'At least one target is required' });
      return;
    }
    if (!hasRemovedInstructionTargets(targets, nextTargets)) {
      void saveTargets(nextTargets, false);
      return;
    }
    setConfirmAction({
      title: 'Clean previous instruction target?',
      body: 'Mandible can remove the old managed block or delete an exact generated standalone file before writing the new target list.',
      confirmLabel: 'Clean and apply',
      secondaryLabel: 'Apply only',
      onConfirm: () => {
        setConfirmAction(null);
        void saveTargets(nextTargets, true);
      },
      onSecondary: () => {
        setConfirmAction(null);
        void saveTargets(nextTargets, false);
      },
    });
  }, [saveTargets, showFeedback, targets]);

  const addTarget = useCallback(async () => {
    const trimmed = targetPath.trim();
    if (!trimmed) {
      showFeedback({ type: 'error', message: 'Target path is required' });
      return;
    }
    const nextTargets = targets.filter((target) => target.path !== trimmed);
    nextTargets.push({ path: trimmed, mode: targetMode });
    requestTargetSave(nextTargets);
    setTargetPath('');
  }, [requestTargetSave, showFeedback, targetMode, targetPath, targets]);

  const removeTarget = useCallback(async (targetPathToRemove: string) => {
    requestTargetSave(targets.filter((target) => target.path !== targetPathToRemove));
  }, [requestTargetSave, targets]);

  const updateTargetMode = useCallback(async (targetPathToUpdate: string, mode: InstructionTargetMode) => {
    requestTargetSave(targets.map((target) => (
      target.path === targetPathToUpdate ? { ...target, mode } : target
    )));
  }, [requestTargetSave, targets]);

  const updateTargetPath = useCallback((targetPathToUpdate: string, nextPath: string) => {
    const trimmed = nextPath.trim();
    if (!trimmed || trimmed === targetPathToUpdate) {
      setTargetPathDrafts((drafts) => {
        const next = { ...drafts };
        delete next[targetPathToUpdate];
        return next;
      });
      return;
    }
    requestTargetSave(targets.map((target) => (
      target.path === targetPathToUpdate ? { ...target, path: trimmed } : target
    )));
  }, [requestTargetSave, targets]);

  const savePostExport = useCallback(async (value: string) => {
    await applyInstructionDelivery(
      { postExport: value.trim() },
      value.trim() ? 'Hook saved and exported' : 'Hook cleared and exported',
    );
  }, [applyInstructionDelivery]);

  const resetToDefaults = useCallback(() => {
    setConfirmAction({
      title: 'Reset instruction delivery?',
      body: 'This will restore the default Claude and Codex instruction targets and refresh the export immediately.',
      confirmLabel: 'Reset to defaults',
      onConfirm: () => {
        setConfirmAction(null);
        void applyInstructionDelivery(
          { resetToDefaults: true, cleanupRemovedTargets: true },
          'Defaults restored and exported',
        );
      },
    });
  }, [applyInstructionDelivery]);

  return (
    <SettingsSectionShell section={props.section}>
      <SettingsSectionHeader
        section={props.section}
        description="Where Mandible writes its generated instruction fragment after rebuilds."
        action={<button
          type="button"
          className="btn btn--sm"
          onClick={resetToDefaults}
          disabled={saving === 'instructions.delivery'}
        >
          Reset
        </button>}
      />

      <div className="settings-view__section-body">
        <div className="settings-view__instruction-targets">
          {targets.length === 0 ? (
            <div className="settings-view__empty">Loading instruction targets...</div>
          ) : (
            targets.map((target) => (
              <div className="settings-view__instruction-target" key={target.path}>
                <input
                  type="text"
                  className="settings-view__input settings-view__input--wide"
                  value={targetPathDrafts[target.path] ?? target.path}
                  onInput={(e) => {
                    const value = (e.target as HTMLInputElement).value;
                    setTargetPathDrafts((drafts) => ({ ...drafts, [target.path]: value }));
                  }}
                  onBlur={(e) => updateTargetPath(target.path, (e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  disabled={saving === 'instructions.delivery'}
                  title={target.path}
                  aria-label={`Instruction target ${target.path}`}
                />
                <select
                  className="settings-view__select settings-view__select--compact"
                  value={target.mode}
                  disabled={saving === 'instructions.delivery'}
                  onChange={(e) => {
                    const nextMode = (e.target as HTMLSelectElement).value;
                    if (isInstructionTargetMode(nextMode)) void updateTargetMode(target.path, nextMode);
                  }}
                  aria-label={`Mode for ${target.path}`}
                >
                  <option value="managed-block">Managed block</option>
                  <option value="standalone">Standalone</option>
                </select>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void removeTarget(target.path)}
                  disabled={saving === 'instructions.delivery'}
                >
                  Remove
                </button>
              </div>
            ))
          )}
        </div>

        <div className="settings-view__instruction-target">
          <input
            type="text"
            className="settings-view__input settings-view__input--wide"
            value={targetPath}
            onInput={(e) => setTargetPath((e.target as HTMLInputElement).value)}
            disabled={saving === 'instructions.delivery'}
            aria-label="New instruction target path"
          />
          <select
            className="settings-view__select settings-view__select--compact"
            value={targetMode}
            disabled={saving === 'instructions.delivery'}
            onChange={(e) => {
              const nextMode = (e.target as HTMLSelectElement).value;
              if (isInstructionTargetMode(nextMode)) setTargetMode(nextMode);
            }}
            aria-label="New instruction target mode"
          >
            <option value="managed-block">Managed block</option>
            <option value="standalone">Standalone</option>
          </select>
          <button
            type="button"
            className="btn btn--active btn--sm"
            onClick={() => void addTarget()}
            disabled={saving === 'instructions.delivery'}
          >
            Add target
          </button>
        </div>

        <div className="settings-view__text-row">
          <div className="settings-view__text-info">
            <span className="settings-view__text-label">Post-export hook</span>
            <span className="settings-view__text-desc">Optional command run after all targets refresh.</span>
          </div>
          <div className="settings-view__text-controls">
            <input
              type="text"
              className="settings-view__input settings-view__input--wide"
              value={postExport}
              onInput={(e) => setPostExport((e.target as HTMLInputElement).value)}
              disabled={saving === 'instructions.delivery'}
              aria-label="Instructions post-export hook"
            />
            <button
              type="button"
              className="btn btn--active btn--sm"
              aria-label="Save instructions post-export hook"
              onClick={() => void savePostExport(postExport)}
              disabled={saving === 'instructions.delivery'}
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn--sm"
              aria-label="Clear instructions post-export hook"
              onClick={() => void savePostExport('')}
              disabled={saving === 'instructions.delivery' || postExport.length === 0}
            >
              Clear
            </button>
          </div>
        </div>

        {feedback && (
          <span className={feedback.type === 'success' ? 'settings-view__feedback settings-view__feedback--success' : 'settings-view__feedback settings-view__feedback--error'}>
            {feedback.message}
          </span>
        )}
      </div>

      {confirmAction && (
        <div className="settings-view__confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="instruction-delivery-confirm-title">
          <div className="settings-view__confirm">
            <h4 className="settings-view__confirm-title" id="instruction-delivery-confirm-title">{confirmAction.title}</h4>
            <p className="settings-view__confirm-body">{confirmAction.body}</p>
            <div className="settings-view__confirm-actions">
              <button type="button" className="btn btn--sm" onClick={() => setConfirmAction(null)}>Cancel</button>
              {confirmAction.onSecondary && confirmAction.secondaryLabel && (
                <button type="button" className="btn btn--sm" onClick={confirmAction.onSecondary}>{confirmAction.secondaryLabel}</button>
              )}
              <button type="button" className="btn btn--active btn--sm" onClick={confirmAction.onConfirm}>{confirmAction.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </SettingsSectionShell>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

export function DelegatedSigningSection(): JSX.Element {
  const [signing, setSigning] = useState<DelegatedSigningStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  const load = useCallback(() => {
    getDelegatedSigningStatus()
      .then(setSigning)
      .catch((err) => setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to load auth status',
      }));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRemove = useCallback(async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const removed = await removeDelegatedSigning();
      setSigning(removed);
      setConfirmRemove(false);
      setFeedback({ type: 'success', message: 'Delegated signing material removed' });
    } catch (err) {
      setFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Removal failed' });
    } finally {
      setBusy(false);
    }
  }, []);

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

  return (
    <div className="settings-view__delegated-signing">
      <div className="settings-view__number-row">
        <div className="settings-view__number-info">
          <span className="settings-view__number-label">Delegated signing key</span>
          <span className="settings-view__number-desc">
            {signing?.configured
              ? 'Ready to issue scoped protected-merge clearances.'
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
          {signing?.configured && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setConfirmRemove(true)}
              disabled={busy}
            >
              Remove
            </button>
          )}
          {signing && signing.missing_tools.length > 0 && (
            <span className="settings-view__feedback settings-view__feedback--error">
              Missing {signing.missing_tools.join(', ')}
            </span>
          )}
        </div>
      </div>
      {confirmRemove && (
        <div className="settings-view__confirm" role="alertdialog" aria-labelledby="delegated-signing-remove-title">
          <div className="settings-view__confirm-body">
            <strong id="delegated-signing-remove-title">Remove delegated signing material?</strong>
            <span>This revokes the runtime signer handles and deletes the local delegated key files. Existing clearance audit rows remain, but cannot execute.</span>
          </div>
          <div className="settings-view__confirm-actions">
            <button type="button" className="btn btn--sm" onClick={() => setConfirmRemove(false)} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn--active btn--sm" onClick={handleRemove} disabled={busy}>
              {busy ? 'Removing...' : 'Remove key material'}
            </button>
          </div>
        </div>
      )}
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

function DesktopDaemonSection(props: { section: SettingsSectionDefinition }): JSX.Element | null {
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
    <SettingsSectionShell section={props.section}>
      <SettingsSectionHeader
        section={props.section}
        description="Desktop shell lifecycle controls for the local Mandible daemon."
      />

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
            Check status
          </button>
        </div>
      </div>
    </SettingsSectionShell>
  );
}

function BackupSection(props: { section: SettingsSectionDefinition }): JSX.Element {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [destinationInput, setDestinationInput] = useState('');
  const [savingDestination, setSavingDestination] = useState(false);
  const [destinationFeedback, setDestinationFeedback] = useState<string | null>(null);

  useEffect(() => {
    getBackupStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    if (status?.destination) {
      setDestinationInput(status.destination);
    }
  }, [status?.destination]);

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

  const handleDestinationSave = useCallback(async () => {
    const destination = destinationInput.trim();
    if (!destination) {
      setDestinationFeedback('Destination is required');
      return;
    }
    setSavingDestination(true);
    setDestinationFeedback(null);
    try {
      await updateBackupSettings({ destination });
      setStatus((prev) => prev ? { ...prev, destination } : prev);
      setDestinationFeedback('Saved');
    } catch (err) {
      setDestinationFeedback(err instanceof Error ? err.message : 'Failed to save destination');
    } finally {
      setSavingDestination(false);
    }
  }, [destinationInput]);

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
    <SettingsSectionShell section={props.section}>
      <SettingsSectionHeader
        section={props.section}
        description="Automatic metadata dump to a configured Mandible backup file."
      />

      <div className="settings-view__section-body">
        {/* Toggle row */}
        <div className="settings-view__toggle-row">
          <div className="settings-view__toggle-info">
            <h3 className="settings-view__section-title">Automatic backup</h3>
            <p className="settings-view__section-desc">Run Mandible's metadata dump on a schedule.</p>
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

        <div className="settings-view__text-row">
          <div className="settings-view__text-info">
            <span className="settings-view__text-label">Destination</span>
          </div>
          <div className="settings-view__text-controls">
            <input
              className="settings-view__input settings-view__input--wide"
              type="text"
              value={destinationInput}
              onInput={(e) => setDestinationInput((e.target as HTMLInputElement).value)}
              disabled={status === null || savingDestination}
            />
            <button
              type="button"
              className="btn btn--sm"
              onClick={handleDestinationSave}
              disabled={status === null || savingDestination || destinationInput.trim() === status?.destination}
            >
              {savingDestination ? '...' : 'Save'}
            </button>
            {destinationFeedback && (
              <span className="settings-view__feedback">
                {destinationFeedback}
              </span>
            )}
          </div>
        </div>

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
                {formatRelativeTime(status.last_run_at, { style: 'verbose' })}
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
    </SettingsSectionShell>
  );
}

// Bug: cc4688b — Zone 2 mutable runtime section
function RuntimeSection(props: { section: SettingsSectionDefinition }): JSX.Element {
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
    <SettingsSectionShell section={props.section}>
      <SettingsSectionHeader
        section={props.section}
        description="Zone 2 mutable runtime for self-modification and patching."
      />

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
    </SettingsSectionShell>
  );
}

function ProjectPermissionsSection(props: { section: SettingsSectionDefinition }): JSX.Element {
  const [projects, setProjects] = useState<ProjectPickerItem[]>([]);
  const [selected, setSelected] = useState('');
  const [access, setAccess] = useState<ProjectAccessSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void listProjectsForPicker().then((items) => {
      setProjects(items);
      if (!selected && items[0]) setSelected(items[0].project_key);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Failed to load projects'));
  }, []);

  useEffect(() => {
    if (!selected) {
      setAccess(null);
      return;
    }
    setError('');
    void getProjectAccessSettings(selected)
      .then(setAccess)
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Failed to load access'));
  }, [selected]);

  const toggleRestricted = useCallback(async () => {
    if (!selected || !access) return;
    setBusy(true);
    setError('');
    try {
      setAccess(await updateProjectAccessSettings(selected, !access.restricted));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to update access');
    } finally {
      setBusy(false);
    }
  }, [selected, access]);

  return (
    <SettingsSectionShell section={props.section} testId="project-permissions-settings">
      <SettingsSectionHeader
        section={props.section}
        description="Projects remain unrestricted until this toggle is enabled. Grants are managed with the user CLI."
      />
      <div className="settings-view__section-body">
        <div className="settings-view__select-row">
          <div className="settings-view__select-info">
            <span className="settings-view__select-label">Project</span>
          </div>
          <select className="settings-view__select" value={selected}
            onChange={(event) => setSelected((event.target as HTMLSelectElement).value)}>
            {projects.map((project) => (
              <option key={project.id} value={project.project_key}>
                {project.display_name || project.project_key}
              </option>
            ))}
          </select>
        </div>
        {access && (
          <>
            <div className="settings-view__toggle-row">
              <div className="settings-view__toggle-info">
                <h3 className="settings-view__section-title">Restricted</h3>
                <p className="settings-view__section-desc">Require an explicit read, write, or admin grant.</p>
              </div>
              <Toggle enabled={access.restricted} onToggle={() => void toggleRestricted()}
                disabled={busy} label="Toggle project restriction" />
            </div>
            <div className="settings-view__text-row">
              <div className="settings-view__text-info">
                <span className="settings-view__text-label">Grants</span>
                {access.grants.length === 0 ? (
                  <span className="settings-view__text-desc">No explicit grants.</span>
                ) : access.grants.map((grant) => (
                  <span key={grant.id} className="settings-view__text-desc">
                    {grant.subject_type}:{grant.subject_id} — {grant.permission}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}
        {error && <span className="settings-view__feedback settings-view__feedback--error">{error}</span>}
      </div>
    </SettingsSectionShell>
  );
}

export function SettingsView(props: SettingsViewProps): JSX.Element {
  const {
    settings,
    onSave,
    instance = null,
    typography = DEFAULT_TYPOGRAPHY_SETTINGS,
    onTypographySave = async () => undefined,
  } = props;
  const operationalMutationsAllowed = !instance || instance.operational_mutations === 'allow';
  const [protectedBranches, setProtectedBranches] = useState('');
  const [quietHours, setQuietHours] = useState('');
  const [issueDefaultFilter, setIssueDefaultFilter] = useState('status:open');
  const [saving, setSaving] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const feedbackTimer = useRef<number | null>(null);
  const initialized = useRef(false);
  const quietInitialized = useRef(false);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [activeSection, setActiveSection] = useState<string>(SETTINGS_SECTIONS.notifications.id);
  const desktopShell = isDesktopShell();
  const visibleSections = SETTINGS_SECTION_LIST.filter((section) => !section.desktopOnly || desktopShell);

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

  const handleTypographyField = useCallback(async (key: UserTypographySettingKey, value: string) => {
    setSaving(key);
    try {
      await onTypographySave(key, value);
      showFeedback({ type: 'success', message: 'Saved' });
    } catch (err) {
      showFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setSaving(null);
    }
  }, [onTypographySave, showFeedback]);

  const handleKeyDown = useCallback(
    (key: string, value: string) => (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleSaveField(key, value);
    },
    [handleSaveField],
  );

  const handleSectionNavigation = useCallback((sectionId: string) => {
    setActiveSection(sectionId);
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    const root = viewRef.current;
    if (!root) return;
    let frame = 0;
    const updateActiveSection = () => {
      frame = 0;
      const rootTop = root.getBoundingClientRect().top;
      let current = visibleSections[0]?.id ?? SETTINGS_SECTIONS.notifications.id;
      for (const section of visibleSections) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top - rootTop <= 112) current = section.id;
        else break;
      }
      setActiveSection(current);
    };
    const scheduleUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(updateActiveSection);
    };
    updateActiveSection();
    root.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      root.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
    };
  }, [desktopShell]);

  return (
    <div className="settings-view" ref={viewRef}>
      <div className="view-header">
        <h2>Settings</h2>
      </div>

      <div className="settings-view__layout">
        <nav className="settings-view__toc" aria-label="Settings sections">
          {SETTINGS_SECTION_LIST.map((section) => {
            if (section.desktopOnly && !desktopShell) return null;
            const isActive = activeSection === section.id;
            return (
              <button
                type="button"
                className={`settings-view__toc-link${isActive ? ' settings-view__toc-link--active' : ''}`}
                aria-controls={section.id}
                aria-current={isActive ? 'location' : undefined}
                onClick={() => handleSectionNavigation(section.id)}
                key={section.id}
              >
                {section.title}
              </button>
            );
          })}
        </nav>

        <div className="settings-view__content">

      {/* ── Section 1: Notifications ── */}
      <SettingsSectionShell section={SETTINGS_SECTIONS.notifications}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.notifications}
          description="Desktop alerts when AI tools finish and are waiting for input."
        />

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
      </SettingsSectionShell>

      <DesktopDaemonSection section={SETTINGS_SECTIONS.daemon} />

      {/* ── Agent Hooks ── */}
      <SettingsSectionShell section={SETTINGS_SECTIONS.agentHooks}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.agentHooks}
          description="PreToolUse safety hooks and subagent behavior."
        />

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
      </SettingsSectionShell>

      <InstructionsDeliverySection section={SETTINGS_SECTIONS.instructionDelivery} settings={settings} onSave={onSave} />

      <ProjectPermissionsSection section={SETTINGS_SECTIONS.projectPermissions} />

      <SettingsSectionShell section={SETTINGS_SECTIONS.briefings}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.briefings}
          description="Submission display behavior for Briefing review rounds."
        />
        <div className="settings-view__section-body">
          <ToggleRow
            title="Keep submitted annotations displayed"
            desc="Leave the annotations from a just-submitted Briefing visible instead of clearing the document overlay."
            settingKey={BRIEFING_KEEP_SUBMITTED_ANNOTATIONS_SETTING}
            settings={settings}
            onSave={onSave}
          />
        </div>
      </SettingsSectionShell>

      <SettingsSectionShell section={SETTINGS_SECTIONS.conversations}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.conversations}
          description="Disclosure defaults for the Chat sidebar."
        />
        <div className="settings-view__section-body">
          <NumberInput
            label="Chats per group"
            desc="Initial rows and rows added each time Show more is used."
            settingKey="conversations.sidebar_group_limit"
            settings={settings}
            onSave={onSave}
            min={SIDEBAR_GROUP_LIMIT_MIN}
            max={SIDEBAR_GROUP_LIMIT_MAX}
            defaultValue={SIDEBAR_GROUP_LIMIT_DEFAULT}
            normalize={normalizeSidebarGroupLimit}
          />
          <SelectInput
            label="Chat entity links"
            desc="Choose what an ordinary click does. The context menu and keyboard menu always offer both actions."
            settingKey="chat_entity_link_action"
            settings={settings}
            onSave={onSave}
            options={['preview', 'open']}
          />
        </div>
      </SettingsSectionShell>

      {/* ── Section: Conversation Branching ── */}
      <SettingsSectionShell section={SETTINGS_SECTIONS.conversationBranching}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.conversationBranching}
          description="How to handle resume when the conversation is already active in Console."
        />

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
      </SettingsSectionShell>

      {/* ── Section: Work Queue ── Bug: cbbb3d9 */}
      <SettingsSectionShell section={SETTINGS_SECTIONS.workQueue}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.workQueue}
          description="How to handle work-unit continuations (handoff notes from ended sessions)."
        />

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
      </SettingsSectionShell>

      {/* ── Section: Issues ── */}
      <SettingsSectionShell section={SETTINGS_SECTIONS.issues}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.issues}
          description="Defaults for the issue ledger browser."
        />

        <div className="settings-view__section-body">
          <SelectInput
            label="Escaped Markdown writes"
            desc="Warn, reject, or allow issue and comment bodies that look like Markdown accidentally submitted with literal \\n escapes."
            settingKey="ledger.markdown_body_escape_policy"
            settings={settings}
            onSave={onSave}
            options={MARKDOWN_BODY_ESCAPE_POLICIES}
          />
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
      </SettingsSectionShell>

      {/* ── Section 4: Appearance ── */}
      <SettingsSectionShell section={SETTINGS_SECTIONS.appearance}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.appearance}
          description="App display and shell launch defaults."
        />

        <div className="settings-view__section-body">
          {([
            ['ui_font_face', 'UI font', 'Chrome, lists, controls, and headers.', [
              ['system-ui', 'System UI'], ['space-grotesk', 'Space Grotesk'],
            ]],
            ['detail_font_face', 'Detail content font', 'Ordinary entity-detail prose, excluding Timeline.', [
              ['system-ui', 'System UI'], ['space-grotesk', 'Space Grotesk'],
            ]],
          ] as const).map(([key, label, desc, options]) => (
            <div className="settings-view__select-row" key={key}>
              <div className="settings-view__select-info">
                <label className="settings-view__select-label" for={`settings-${key}`}>{label}</label>
                <span className="settings-view__select-desc" id={`settings-${key}-description`}>{desc}</span>
              </div>
              <div className="settings-view__number-controls">
                <select
                  id={`settings-${key}`}
                  className="settings-view__select"
                  aria-describedby={`settings-${key}-description`}
                  value={typographySettingValue(typography, key)}
                  disabled={!operationalMutationsAllowed || saving === key}
                  onChange={(event) => void handleTypographyField(key, (event.target as HTMLSelectElement).value)}
                >
                  {options.map(([value, text]) => <option value={value} key={value}>{text}</option>)}
                </select>
                <button
                  type="button"
                  className="btn btn--sm"
                  aria-label={`Reset ${label}`}
                  disabled={!operationalMutationsAllowed || saving === key}
                  onClick={() => void handleTypographyField(key, typographySettingValue(DEFAULT_TYPOGRAPHY_SETTINGS, key))}
                >Reset</button>
              </div>
            </div>
          ))}
          {([
            ['ui_font_size', 'UI size', 'Base size for chrome and controls.'],
            ['detail_font_size', 'Detail content size', 'Base size for ordinary entity-detail prose.'],
          ] as const).map(([key, label, desc]) => (
            <div className="settings-view__text-row" key={key}>
              <div className="settings-view__text-info">
                <label className="settings-view__text-label" for={`settings-${key}`}>{label}</label>
                <span className="settings-view__text-desc" id={`settings-${key}-description`}>{desc}</span>
              </div>
              <div className="settings-view__number-controls">
                <input
                  id={`settings-${key}`}
                  className="settings-view__number-input"
                  type="number"
                  min="10"
                  max="20"
                  step="1"
                  aria-describedby={`settings-${key}-description`}
                  value={typographySettingValue(typography, key)}
                  disabled={!operationalMutationsAllowed || saving === key}
                  onChange={(event) => {
                    const value = (event.target as HTMLInputElement).value;
                    if (Number.isInteger(Number(value)) && Number(value) >= 10 && Number(value) <= 20) {
                      void handleTypographyField(key, value);
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn--sm"
                  aria-label={`Reset ${label}`}
                  disabled={!operationalMutationsAllowed || saving === key}
                  onClick={() => void handleTypographyField(key, typographySettingValue(DEFAULT_TYPOGRAPHY_SETTINGS, key))}
                >Reset</button>
              </div>
            </div>
          ))}
          <div className="settings-view__select-row">
            <div className="settings-view__select-info">
              <label className="settings-view__select-label" htmlFor="settings-app-theme">App theme</label>
              <span id="settings-app-theme-description" className="settings-view__select-desc">Follow the system appearance or pin Mandible to dark or light</span>
            </div>
            <select
              id="settings-app-theme"
              className="settings-view__select"
              aria-describedby="settings-app-theme-description"
              value={normalizeAppThemeMode(settings.app_theme)}
              disabled={!operationalMutationsAllowed}
              onChange={async (e) => {
                if (!operationalMutationsAllowed) return;
                try {
                  await onSave('app_theme', normalizeAppThemeMode((e.target as HTMLSelectElement).value));
                } catch { /* ignore */ }
              }}
            >
              {APP_THEME_MODES.map((mode) => (
                <option key={mode} value={mode}>{APP_THEME_LABELS[mode]}</option>
              ))}
            </select>
          </div>
          {([
            ['light', 'Light-mode terminal', 'Terminal palette used while Mandible is light'],
            ['dark', 'Dark-mode terminal', 'Terminal palette used while Mandible is dark'],
          ] as const).map(([mode, label, description]) => {
            const key = `terminal_theme_${mode}`;
            const descriptionId = `settings-${key}-description`;
            return (
              <div className="settings-view__select-row" key={key}>
                <div className="settings-view__select-info">
                  <label className="settings-view__select-label" htmlFor={`settings-${key}`}>{label}</label>
                  <span id={descriptionId} className="settings-view__select-desc">{description}</span>
                </div>
                <select
                  id={`settings-${key}`}
                  className="settings-view__select"
                  aria-describedby={descriptionId}
                  value={normalizeTerminalThemeId(settings[key])}
                  disabled={!operationalMutationsAllowed}
                  onChange={async (event) => {
                    if (!operationalMutationsAllowed) return;
                    try {
                      await onSave(key, normalizeTerminalThemeId((event.target as HTMLSelectElement).value));
                    } catch { /* ignore */ }
                  }}
                >
                  {TERMINAL_THEME_IDS.map((theme) => (
                    <option key={theme} value={theme}>{TERMINAL_THEME_LABELS[theme]}</option>
                  ))}
                </select>
              </div>
            );
          })}
          <ToggleRow
            title="Experimental features"
            desc="Show Timeline, Graph, and Workspaces in the experimental navigation group."
            settingKey="show_experimental_features"
            settings={settings}
            onSave={onSave}
            defaultEnabled
          />
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
      </SettingsSectionShell>

      <SettingsSectionShell section={SETTINGS_SECTIONS.auth}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.auth}
          description="Approval display, queue retention, and hardware-backed delegated signing."
        />
        <div className="settings-view__section-body">
          <ToggleRow
            title="Show approval console automatically"
            desc="Switch to Console when approval execution starts."
            settingKey={AUTH_AUTO_SHOW_CONSOLE_SETTING}
            settings={settings}
            onSave={onSave}
            defaultEnabled
          />
          <ToggleRow
            title="Return to overview after approval"
            desc="Switch back to the request overview after approval finishes successfully."
            settingKey={AUTH_AUTO_RETURN_TO_OVERVIEW_SETTING}
            settings={settings}
            onSave={onSave}
            defaultEnabled
          />
          <ToggleRow
            title="Keep the finalized request selected"
            desc="When Active requests are shown, keep a just-finalized request visible until another request is selected."
            settingKey={AUTH_RETAIN_FINALIZED_SELECTION_SETTING}
            settings={settings}
            onSave={onSave}
            defaultEnabled
          />
          <DelegatedSigningSection />
        </div>
      </SettingsSectionShell>

      <SettingsSectionShell section={SETTINGS_SECTIONS.authHooks}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.authHooks}
          description="Repo-specific post-auth hook configuration."
        />
        <div className="settings-view__section-body">
          <AuthHooksPanel mutationsAllowed={operationalMutationsAllowed} />
        </div>
      </SettingsSectionShell>

      {/* ── Section 5: Version Control ── */}
      <SettingsSectionShell section={SETTINGS_SECTIONS.versionControl}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.versionControl}
          description="Comma-separated branch names that are pinned in the Work tab and used as the baseline for ahead/behind counts."
        />
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
      </SettingsSectionShell>

      {/* ── Section 6: Maintenance ── */}
      <SettingsSectionShell section={SETTINGS_SECTIONS.maintenance}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.maintenance}
          description="Log retention and housekeeping."
        />

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
      </SettingsSectionShell>

      {/* ── Section 7: Backup ── */}
      <BackupSection section={SETTINGS_SECTIONS.backup} />

      {/* ── Section 8: Runtime ── Bug: cc4688b */}
      <RuntimeSection section={SETTINGS_SECTIONS.runtime} />
        </div>
      </div>
    </div>
  );
}
