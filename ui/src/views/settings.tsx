import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { AppOperationalNoticeOutlet } from '../app-shell';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { ManagedChatDefaults } from '../components/settings/ManagedChatDefaults';
import SigningSettings from '../components/settings/SigningSettings';
import { formatRelativeTime } from '../lib/format';
import {
  getBackupStatus,
  getDelegatedSigningStatus,
  getDesktopDaemonStatus,
  getSecureLocalConnectionsStatus,
  isDesktopShell,
  navigateToDesktopBootstrap,
  removeDelegatedSigning,
  restartDesktopDaemon,
  runBackupNow,
  setDesktopDaemonLaunchMode,
  setupDelegatedSigning,
  startDesktopDaemon,
  setupSecureLocalConnections,
  stopDesktopDaemon,
  getInstructionDeliverySettings,
  updateBackupSettings,
  updateInstructionDeliverySettings,
  getProjectAccessSettings,
  listProjectsForPicker,
  updateProjectAccessSettings,
  canPerformOperation,
  type BackupStatus,
  type DelegatedSigningStatus,
  type DesktopDaemonLaunchMode,
  type InstructionDeliverySettings,
  type InstructionTarget,
  type InstructionTargetMode,
  type DesktopDaemonStatus,
  type SecureLocalConnectionsStatus,
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
import {
  createOrderedSettingSave,
  normalizeProtectedBranches,
  normalizeQuietHours,
  shouldFlushPendingSettingWrite,
  shouldPersistSettingValue,
} from './settings-behavior';

export type SettingsViewProps = {
  settings: Record<string, string>;
  onSave: (key: string, value: string) => Promise<void>;
  loadError?: string | null;
  onRefresh?: () => void;
  onClose?: () => void;
  instance?: InstanceInfo | null;
  typography?: TypographySettings;
  onTypographySave?: (key: UserTypographySettingKey, value: string) => Promise<void>;
};

type FeedbackState = {
  type: 'success' | 'error';
  message: string;
} | null;

function SettingsFeedback({ feedback }: { feedback: FeedbackState }): JSX.Element | null {
  if (!feedback) return null;
  return feedback.type === 'error' ? (
    <DetailPaneNotice severity="error" density="compact">{feedback.message}</DetailPaneNotice>
  ) : <span className="settings-view__feedback settings-view__feedback--success">{feedback.message}</span>;
}

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
  daemon: { id: 'settings-daemon', title: 'Local connections' },
  agentHooks: { id: 'settings-agent-hooks', title: 'Agent Hooks' },
  instructionDelivery: { id: 'settings-instruction-delivery', title: 'Instruction Delivery' },
  projectPermissions: { id: 'settings-project-permissions', title: 'Project permissions' },
  briefings: { id: 'settings-briefings', title: 'Briefings' },
  conversations: { id: 'settings-conversations', title: 'Conversations' },
  chatDefaults: { id: 'settings-chat-defaults', title: 'Chat defaults' },
  conversationBranching: { id: 'settings-conversation-branching', title: 'Conversation Branching' },
  workQueue: { id: 'settings-work-queue', title: 'Work Queue' },
  issues: { id: 'settings-issues', title: 'Issues' },
  appearance: { id: 'settings-appearance', title: 'Appearance' },
  auth: { id: 'auth-settings', title: 'Approvals' },
  authHooks: { id: 'settings-auth-hooks', title: 'Approval Hooks' },
  signing: { id: 'settings-signing', title: 'Signing keys' },
  versionControl: { id: 'settings-version-control', title: 'Version Control' },
  maintenance: { id: 'settings-maintenance', title: 'Maintenance' },
  backup: { id: 'settings-backup', title: 'Backup' },
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
}): JSX.Element {
  return (
    <div className="settings-view__section-header">
      <div>
        <h3 className="settings-view__section-title" id={`${props.section.id}-title`}>{props.section.title}</h3>
        <p className="settings-view__section-desc">{props.description}</p>
      </div>
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
  if (result.preview_only) {
    return result.configuration_saved
      ? 'Saved in this preview copy. Target files were not changed and the post-export hook was not run.'
      : 'Loaded from this preview copy. Target files were not changed and the post-export hook was not run.';
  }
  if (result.export?.ok === false) {
    const detail = result.export.stderr.trim() || result.export.stdout.trim() || 'The export did not complete.';
    return `${fallback}; export failed: ${detail}`;
  }
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
    <div className="settings-view__toggle-row" data-settings-searchable>
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

const normalizeTextValue = (value: string): string | null => value.trim();
const normalizeIssueDefaultFilter = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return 'status:open';
  for (const token of trimmed.split(/\s+/)) {
    const match = /^(status|kind|priority|resolution):(.*)$/i.exec(token);
    if (!match) continue;
    const [, key, values] = match;
    if (!values || values.split(',').some((part) => !/^[a-z0-9_-]+$/i.test(part))) return null;
    if (key.toLowerCase() === 'status' && !['all', 'open', 'closed'].includes(values.toLowerCase())) return null;
  }
  return trimmed;
};
const normalizeBackupDestination = (value: string): string | null => value.trim() || null;

function useDebouncedSettingSave(
  key: string,
  value: string,
  persistedValue: string,
  onSave: (key: string, value: string) => Promise<void>,
  normalize: (value: string) => string | null = normalizeTextValue,
  ready = true,
): { saving: boolean; error: string | null } {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const generation = useRef(0);
  const inFlight = useRef<string | null>(null);
  const mounted = useRef(true);
  const lastSaved = useRef(normalize(persistedValue));

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    if (!ready) return;
    const normalized = normalize(value);
    if (normalized == null) {
      setError(null);
      return;
    }
    if (!shouldPersistSettingValue(normalized, normalize(persistedValue), lastSaved.current, inFlight.current)) return;
    const currentSequence = ++sequence.current;
    let pending = true;
    const persist = async () => {
      pending = false;
      inFlight.current = normalized;
      if (mounted.current) {
        setSaving(true);
        setError(null);
      }
      try {
        await onSave(key, normalized);
        lastSaved.current = normalized;
        if (mounted.current && sequence.current === currentSequence) setError(null);
      } catch (err) {
        if (mounted.current && sequence.current === currentSequence) {
          setError(err instanceof Error ? err.message : 'Failed to save');
        }
      } finally {
        if (inFlight.current === normalized) inFlight.current = null;
        if (mounted.current && sequence.current === currentSequence) setSaving(false);
      }
    };
    const timer = window.setTimeout(() => { void persist(); }, 450);
    return () => {
      window.clearTimeout(timer);
      queueMicrotask(() => {
        if (shouldFlushPendingSettingWrite(pending, currentGeneration, generation.current)) void persist();
      });
    };
  }, [key, normalize, onSave, persistedValue, ready, value]);

  return { saving, error };
}

function PlusIcon(): JSX.Element {
  return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>;
}

function MinusIcon(): JSX.Element {
  return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>;
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
  const initialized = useRef(false);
  const persistedValue = props.settings[props.settingKey]
    ?? (props.defaultValue != null ? String(props.defaultValue) : '');
  const normalizeValue = useCallback((next: string): string | null => {
    if (!/^\d+$/.test(next)) return null;
    const number = Number(next);
    if ((props.min != null && number < props.min) || (props.max != null && number > props.max)) return null;
    return String(props.normalize ? props.normalize(next) : number);
  }, [props.max, props.min, props.normalize]);
  const saveState = useDebouncedSettingSave(
    props.settingKey,
    value,
    persistedValue,
    props.onSave,
    normalizeValue,
    initialized.current,
  );

  useEffect(() => {
    const incoming = props.settings[props.settingKey] ?? (props.defaultValue != null ? String(props.defaultValue) : undefined);
    if (typeof incoming === 'string' && !initialized.current) {
      setValue(props.normalize ? String(props.normalize(incoming)) : incoming);
      initialized.current = true;
    }
  }, [props.settings[props.settingKey]]);

  return (
    <div className="settings-view__number-row" data-settings-searchable>
      <div className="settings-view__number-info">
        <span className="settings-view__number-label">{props.label}</span>
        {props.desc && <span className="settings-view__number-desc">{props.desc}</span>}
      </div>
      <div className="settings-view__number-controls">
        <input
          type="number"
          className="settings-view__number-input"
          aria-label={props.label}
          aria-invalid={saveState.error != null || (value !== '' && normalizeValue(value) == null)}
          value={value}
          onInput={(e) => {
            initialized.current = true;
            setValue((e.target as HTMLInputElement).value);
          }}
          min={props.min}
          max={props.max}
        />
        {props.suffix && <span className="settings-view__number-suffix">{props.suffix}</span>}
        {saveState.saving && <span className="settings-view__text-desc" role="status">Saving</span>}
        {saveState.error && <SettingsFeedback feedback={{ type: 'error', message: saveState.error }} />}
        {!saveState.error && value !== '' && normalizeValue(value) == null && (
          <span className="settings-view__warning" role="status">Enter a whole number within the allowed range.</span>
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
    <div className="settings-view__select-row" data-settings-searchable>
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
  readAllowed: boolean;
  settingsAllowed: boolean;
  exportRunsOnSave: boolean;
}): JSX.Element {
  const [targets, setTargets] = useState<InstructionTarget[]>([]);
  const [targetPath, setTargetPath] = useState('');
  const [targetMode, setTargetMode] = useState<InstructionTargetMode>('managed-block');
  const [targetPathDrafts, setTargetPathDrafts] = useState<Record<string, string>>({});
  const [postExport, setPostExport] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [targetsLoaded, setTargetsLoaded] = useState(false);
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
    if (state?.type === 'success') {
      window.setTimeout(() => setFeedback(null), 3000);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!props.readAllowed) {
      setTargetsLoaded(true);
      return () => { cancelled = true; };
    }
    getInstructionDeliverySettings()
      .then((delivery) => {
        if (cancelled) return;
        setTargets(delivery.targets);
        setPostExport(delivery.postExport);
        setTargetsLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        const fallbackTargets = parseInstructionTargets(props.settings['instructions.targets']);
        setTargets(fallbackTargets);
        setPostExport(props.settings['instructions.post_export'] ?? '');
        setTargetsLoaded(true);
        showFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Failed to load instruction delivery settings' });
      });
    return () => {
      cancelled = true;
    };
  }, [props.readAllowed, props.settings, showFeedback]);

  const applyInstructionDelivery = useCallback(async (
    request: { targets?: InstructionTarget[]; postExport?: string; cleanupRemovedTargets?: boolean; resetToDefaults?: boolean },
    successMessage: string,
  ) => {
    if (!props.settingsAllowed) return;
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
      throw err;
    } finally {
      setSaving(null);
    }
  }, [props.onSave, props.settingsAllowed, showFeedback]);

  const saveTargets = useCallback(async (nextTargets: InstructionTarget[], cleanupRemovedTargets: boolean) => {
    try {
      await applyInstructionDelivery(
        { targets: nextTargets, cleanupRemovedTargets },
        'Targets saved and exported',
      );
    } catch {
      // The section feedback already reports the failed update.
    }
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
    if (!props.exportRunsOnSave) {
      // Removing a target from the copied configuration never cleans files.
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
  }, [props.exportRunsOnSave, saveTargets, showFeedback, targets]);

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
  const postExportSaveState = useDebouncedSettingSave(
    'instructions.post_export',
    postExport,
    props.settings['instructions.post_export'] ?? '',
    useCallback((_key, value) => savePostExport(value), [savePostExport]),
    normalizeTextValue,
    targetsLoaded,
  );

  return (
    <SettingsSectionShell section={props.section}>
      <SettingsSectionHeader
        section={props.section}
        description="Where Mandible writes its generated instruction fragment after rebuilds."
      />

      <div className="settings-view__section-body">
        <div className="settings-view__instruction-targets">
          {!props.readAllowed ? (
            <div className="settings-view__empty">Instruction targets are unavailable in this instance.</div>
          ) : !targetsLoaded ? (
            <div className="settings-view__empty">Loading instruction targets...</div>
          ) : targets.length === 0 ? (
            <div className="settings-view__empty">No instruction targets are configured.</div>
          ) : (
            targets.map((target) => (
              <div className="settings-view__instruction-target" data-settings-searchable data-settings-search-text={targetPathDrafts[target.path] ?? target.path} key={target.path}>
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
                  disabled={!props.settingsAllowed || saving === 'instructions.delivery'}
                  title={target.path}
                  aria-label={`Instruction target ${target.path}`}
                />
                <select
                  className="settings-view__select settings-view__select--compact"
                  value={target.mode}
                  disabled={!props.settingsAllowed || saving === 'instructions.delivery'}
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
                  className="btn btn--sm settings-view__collection-action"
                  onClick={() => void removeTarget(target.path)}
                  disabled={!props.settingsAllowed || saving === 'instructions.delivery'}
                  aria-label={`Remove instruction target ${target.path}`}
                >
                  <MinusIcon />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="settings-view__instruction-target" data-settings-searchable data-settings-search-text={`add instruction target path mode ${targetPath}`}>
          <input
            type="text"
            className="settings-view__input settings-view__input--wide"
            value={targetPath}
            onInput={(e) => setTargetPath((e.target as HTMLInputElement).value)}
            disabled={!props.settingsAllowed || saving === 'instructions.delivery'}
            aria-label="New instruction target path"
          />
          <select
            className="settings-view__select settings-view__select--compact"
            value={targetMode}
            disabled={!props.settingsAllowed || saving === 'instructions.delivery'}
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
            className="btn btn--active btn--sm settings-view__collection-action"
            onClick={() => void addTarget()}
            disabled={!props.settingsAllowed || saving === 'instructions.delivery'}
            aria-label="Add instruction target"
          >
            <PlusIcon />
          </button>
        </div>

        <div className="settings-view__text-row" data-settings-searchable>
          <div className="settings-view__text-info">
            <span className="settings-view__text-label">Post-export hook</span>
            <span className="settings-view__text-desc">
              {props.exportRunsOnSave
                ? 'Optional command run after all targets refresh.'
                : 'Optional command saved in this copy but not run by a preview.'}
            </span>
          </div>
          <div className="settings-view__text-controls">
            <input
              type="text"
              className="settings-view__input settings-view__input--wide"
              value={postExport}
              onInput={(e) => setPostExport((e.target as HTMLInputElement).value)}
              disabled={!props.settingsAllowed || saving === 'instructions.delivery'}
              aria-label="Instructions post-export hook"
            />
            {postExportSaveState.saving && <span className="settings-view__text-desc" role="status">Saving</span>}
          </div>
        </div>

        {(postExportSaveState.error || feedback) && (
          <div data-settings-searchable data-settings-search-text="instruction targets post-export hook">
            <SettingsFeedback feedback={postExportSaveState.error
              ? { type: 'error', message: postExportSaveState.error }
              : feedback} />
          </div>
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

export function DelegatedSigningSection({ instance }: { instance?: InstanceInfo | null }): JSX.Element {
  const [signing, setSigning] = useState<DelegatedSigningStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const readAllowed = canPerformOperation(instance, 'GET', '/api/auth/clearances/signing');
  const setupAllowed = canPerformOperation(instance, 'POST', '/api/auth/clearances/signing/setup');
  const removeAllowed = canPerformOperation(instance, 'DELETE', '/api/auth/clearances/signing');

  const load = useCallback(() => {
    if (!readAllowed) return;
    getDelegatedSigningStatus()
      .then(setSigning)
      .catch((err) => setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to load auth status',
      }));
  }, [readAllowed]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRemove = useCallback(async () => {
    if (!removeAllowed) return;
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
  }, [removeAllowed]);

  const handleSetup = useCallback(async () => {
    if (!setupAllowed) return;
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
  }, [load, setupAllowed]);

  return (
    <div className="settings-view__delegated-signing">
      <div className="settings-view__number-row" data-settings-searchable>
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
            disabled={!setupAllowed || busy || signing?.configured === true}
          >
            {busy ? 'Setting up...' : signing?.configured ? 'Configured' : 'Set up'}
          </button>
          {signing?.configured && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setConfirmRemove(true)}
              disabled={!removeAllowed || busy}
            >
              Remove
            </button>
          )}
          {signing && signing.missing_tools?.length > 0 && (
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
            <button type="button" className="btn btn--active btn--sm" onClick={handleRemove} disabled={!removeAllowed || busy}>
              {busy ? 'Removing...' : 'Remove key material'}
            </button>
          </div>
        </div>
      )}
      {!readAllowed ? (
        <DetailPaneNotice severity="info" density="compact" title="Credential status unavailable">
          This instance cannot read delegated signing credentials.
        </DetailPaneNotice>
      ) : !setupAllowed || !removeAllowed ? (
        <DetailPaneNotice severity="info" density="compact" title="Credential changes unavailable">
          Credential setup and removal are unavailable in this instance.
        </DetailPaneNotice>
      ) : null}
      {readAllowed && signing?.public_key && (
        <div className="settings-view__field" data-settings-searchable data-settings-search-text="delegated signing public key">
          <textarea
            className="settings-view__input settings-view__input--mono"
            value={signing.public_key}
            readOnly
            rows={3}
          />
        </div>
      )}
      {feedback && (
        <div data-settings-searchable data-settings-search-text="delegated signing key">
          <SettingsFeedback feedback={feedback} />
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
    case 'gateway_unavailable':
      return 'Dashboard unavailable';
    case 'port_conflict':
      return 'Port conflict';
    default:
      return 'Stopped';
  }
}

function DesktopDaemonSection(props: { section: SettingsSectionDefinition; instance?: InstanceInfo | null }): JSX.Element | null {
  const desktopShell = isDesktopShell();
  const hostStatusAllowed = Boolean(props.instance?.allowed_effects.includes('files:production')
    && props.instance.allowed_effects.includes('process:external'));
  const hostActionsAllowed = hostStatusAllowed;
  const connectionSetupAllowed = canPerformOperation(props.instance, 'POST', '/api/system/open-path');
  const [status, setStatus] = useState<DesktopDaemonStatus | null>(null);
  const [loading, setLoading] = useState(desktopShell && hostStatusAllowed);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [caStatus, setCaStatus] = useState<SecureLocalConnectionsStatus | null>(null);
  const [caError, setCaError] = useState<string | null>(null);
  const [caAction, setCaAction] = useState(false);

  const refreshCaStatus = useCallback(async () => {
    if (!desktopShell || !hostStatusAllowed) return;
    try {
      setCaStatus(await getSecureLocalConnectionsStatus());
      setCaError(null);
    } catch (err) {
      setCaError(err instanceof Error ? err.message : 'Failed to inspect secure local connections');
    }
  }, [desktopShell, hostStatusAllowed]);

  useEffect(() => { void refreshCaStatus(); }, [refreshCaStatus]);

  const handleCaSetup = useCallback(async () => {
    if (!connectionSetupAllowed) return;
    setCaAction(true);
    try {
      setCaStatus(await setupSecureLocalConnections());
      setCaError(null);
    } catch (err) {
      setCaError(err instanceof Error ? err.message : 'Secure local connections setup failed');
    } finally {
      setCaAction(false);
    }
  }, [connectionSetupAllowed]);

  const refreshStatus = useCallback(async () => {
    if (!desktopShell || !hostStatusAllowed) {
      setLoading(false);
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
  }, [desktopShell, hostStatusAllowed]);

  useEffect(() => {
    if (!desktopShell || !hostStatusAllowed) {
      setLoading(false);
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
  }, [desktopShell, hostStatusAllowed]);

  const handleLaunchModeChange = useCallback(async (e: Event) => {
    if (!hostActionsAllowed) return;
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
  }, [hostActionsAllowed]);

  const handleStart = useCallback(async () => {
    if (!hostActionsAllowed) return;
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
  }, [hostActionsAllowed]);

  const handleStop = useCallback(async () => {
    if (!hostActionsAllowed) return;
    setAction('stop');
    try {
      await stopDesktopDaemon();
      await navigateToDesktopBootstrap(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop daemon');
      setAction(null);
    }
  }, [hostActionsAllowed]);

  const handleRestart = useCallback(async () => {
    if (!hostActionsAllowed) return;
    setAction('restart');
    try {
      await restartDesktopDaemon();
      await navigateToDesktopBootstrap(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart daemon');
      setAction(null);
    }
  }, [hostActionsAllowed]);

  if (!desktopShell) {
    return (
      <SettingsSectionShell section={props.section}>
        <SettingsSectionHeader section={props.section} description="Set up the trusted local HTTPS connection before using a new browser origin." />
        <div className="settings-view__section-body">
          <div data-settings-searchable data-settings-search-text="secure local connections HTTPS trust setup">
            <p className="settings-view__daemon-footer">Open the installed macOS app to set up secure local connections for this Mac account. macOS may ask you to authorize the one-time setup; new previews reuse it.</p>
            <a className="btn btn--active btn--sm" href="mandible://connections/setup">Open macOS setup</a>
          </div>
        </div>
      </SettingsSectionShell>
    );
  }

  return (
    <SettingsSectionShell section={props.section}>
      <SettingsSectionHeader
        section={props.section}
        description="Desktop controls for the local Mandible backend and trusted dashboard gateway."
      />
      {(error || caError) && (
        <DetailPaneNotice severity="error" density="compact" title="Local connections need attention">
          {error && <div>{error}</div>}
          {caError && <div>{caError}</div>}
        </DetailPaneNotice>
      )}
      {!hostActionsAllowed || !hostStatusAllowed ? (
        <DetailPaneNotice severity="info" density="compact" title="Host controls unavailable">
          Desktop services and secure local connection setup cannot be changed in this instance.
        </DetailPaneNotice>
      ) : null}

      <div className="settings-view__section-body">
        <div className="settings-view__select-row" data-settings-searchable>
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
            disabled={!hostActionsAllowed || action === 'mode' || loading}
          >
            {DESKTOP_DAEMON_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode === 'on_demand' ? 'on demand' : 'manual'}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-view__daemon-card" data-settings-searchable data-settings-search-text="local backend dashboard gateway daemon">
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
                {loading ? 'Checking local services…' : `${status?.healthy ? 'Backend healthy' : 'Backend unavailable'} · port ${status?.port ?? 0}`}
                {status?.pid ? ` • PID ${status.pid}` : ''}
              </div>
            </div>
            <div className="settings-view__daemon-actions">
              <button
                type="button"
                className="btn btn--active btn--sm"
                onClick={handleStart}
                disabled={!hostActionsAllowed || loading || action != null || status?.dashboard_ready === true || status?.state === 'port_conflict'}
              >
                {action === 'start' ? '...' : 'Start'}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={handleRestart}
                disabled={!hostActionsAllowed || loading || action != null || !status}
              >
                {action === 'restart' ? '...' : 'Restart'}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={handleStop}
                disabled={!hostActionsAllowed || loading || action != null || !status || (status.state === 'stopped' && status.gateway_state !== 'running')}
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
            <div className="settings-view__daemon-detail">
              Dashboard: {status.dashboard_ready ? `ready at ${status.dashboard_origin}` : `unavailable (${status.gateway_state})`}
              {status.gateway_error ? ` — ${status.gateway_error}` : ''}
            </div>
          )}
          {status && (
            <div className="settings-view__daemon-paths">
              <span>PID file: {status.pid_file}</span>
              <span>Log file: {status.log_file}</span>
              <span>Gateway log: {status.gateway_log_file}</span>
            </div>
          )}
          <div className="settings-view__daemon-footer">
            {status?.launch_mode === 'manual'
              ? 'Manual mode leaves stopped services alone until you start Mandible from the desktop shell.'
              : 'On-demand mode starts or recovers Mandible when the desktop shell opens and the backend or dashboard is unavailable.'}
          </div>
          <button type="button" className="btn btn--sm" onClick={refreshStatus} disabled={loading || action != null}>
            Check status
          </button>
        </div>
        <div className="settings-view__local-connections" data-settings-searchable data-settings-search-text="secure local connections HTTPS certificate trust">
          <div className="settings-view__daemon-status-row">
            <div>
              <div className="settings-view__daemon-title">Secure local connections</div>
              <div className="settings-view__daemon-meta">
                {caStatus?.state === 'trusted' ? 'Ready for this Mac account.'
                  : caStatus?.state === 'prepared' ? 'Setup is prepared; Mac authorization or connection verification remains.'
                    : caStatus?.state === 'untracked_root' ? 'Setup needs to verify existing local connection material.'
                      : 'One-time setup has not completed.'}
              </div>
            </div>
            <div className="settings-view__daemon-actions">
              <button type="button" className="btn btn--active btn--sm" onClick={handleCaSetup} disabled={!connectionSetupAllowed || caAction}>
                {caAction ? 'Setting up…' : caStatus?.state === 'trusted' ? 'Verify connection' : 'Set up'}
              </button>
              <button type="button" className="btn btn--sm" onClick={refreshCaStatus} disabled={caAction}>Check status</button>
            </div>
          </div>
          <div className="settings-view__daemon-footer">
            This is a one-time setup for secure local connections on this Mac account. macOS controls any account authorization; Mandible never asks for your password. New previews, restarts, and routine renewals reuse the setup without another request. If this page cannot load before initial setup, use Connections → Set up secure local connections… in the macOS app menu.
          </div>
          <details className="settings-view__daemon-detail"><summary>Details</summary>Mandible pins one Caddy HTTPS root and its signing key to this installation. macOS stores an SSL trust rule for this account, not a computer-wide administrator rule. That SSL rule is not limited to Mandible hostnames; keep the root signing key private. Browser sign-in is separate. To remove this trust later, use this account's Keychain Access certificate settings. {caStatus?.root_digest && <>Root SHA-256: <code>{caStatus.root_digest}</code>.</>}</details>
          {caStatus?.verified_at && <div className="settings-view__daemon-detail">Last verified: {caStatus.verified_at}</div>}
        </div>
      </div>
    </SettingsSectionShell>
  );
}

function BackupSection(props: { section: SettingsSectionDefinition; instance?: InstanceInfo | null }): JSX.Element {
  const readAllowed = canPerformOperation(props.instance, 'GET', '/api/backup/status');
  const settingsAllowed = canPerformOperation(props.instance, 'PUT', '/api/backup/settings');
  const runAllowed = canPerformOperation(props.instance, 'POST', '/api/backup/run');
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(readAllowed);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [destinationInput, setDestinationInput] = useState('');

  const refreshStatus = useCallback(async () => {
    if (!readAllowed) {
      setStatus(null);
      setLoadError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      setStatus(await getBackupStatus());
    } catch (err) {
      setStatus(null);
      setLoadError(err instanceof Error ? err.message : 'Failed to load backup status');
    } finally {
      setLoading(false);
    }
  }, [readAllowed]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.destination) {
      setDestinationInput(status.destination);
    }
  }, [status?.destination]);

  const handleToggle = useCallback(async () => {
    if (!settingsAllowed || !status) return;
    setToggling(true);
    setActionError(null);
    try {
      const newEnabled = !status.enabled;
      await updateBackupSettings({ enabled: newEnabled });
      setStatus((prev) => prev ? { ...prev, enabled: newEnabled } : prev);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update backup schedule');
    } finally {
      setToggling(false);
    }
  }, [settingsAllowed, status]);

  const handleIntervalChange = useCallback(async (e: Event) => {
    if (!settingsAllowed) return;
    const hours = parseInt((e.target as HTMLSelectElement).value, 10);
    if (!Number.isFinite(hours)) return;
    setActionError(null);
    try {
      await updateBackupSettings({ interval_hours: hours });
      setStatus((prev) => prev ? { ...prev, interval_hours: hours } : prev);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update backup interval');
    }
  }, [settingsAllowed]);

  const saveDestination = useCallback(async (_key: string, destination: string) => {
    if (!settingsAllowed) return;
    setActionError(null);
    await updateBackupSettings({ destination });
    setStatus((prev) => prev ? { ...prev, destination } : prev);
  }, [settingsAllowed]);
  const destinationSaveState = useDebouncedSettingSave(
    'backup.destination', destinationInput, status?.destination ?? '', saveDestination, normalizeBackupDestination, Boolean(status),
  );

  const handleRunNow = useCallback(async () => {
    if (!runAllowed) return;
    setRunning(true);
    setRunError(null);
    try {
      const result = await runBackupNow();
      if (result.ok) {
        await refreshStatus();
      } else {
        setRunError(result.error ?? 'Backup failed');
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Backup failed');
    } finally {
      setRunning(false);
    }
  }, [refreshStatus, runAllowed]);

  return (
    <SettingsSectionShell section={props.section}>
      <SettingsSectionHeader
        section={props.section}
        description="Automatic metadata dump to a configured Mandible backup file."
      />
      {!readAllowed ? (
        <DetailPaneNotice severity="info" density="compact" title="Backup unavailable">
          Backup status and controls access files outside this copy, so they are unavailable in this instance.
        </DetailPaneNotice>
      ) : !settingsAllowed || !runAllowed ? (
        <DetailPaneNotice severity="info" density="compact" title="Some backup actions unavailable">
          This instance cannot change backup settings or run a backup.
        </DetailPaneNotice>
      ) : null}
      {loadError && readAllowed && (
        <DetailPaneNotice severity="error" density="compact" title="Backup status could not be loaded" actions={
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refreshStatus()}>Retry</button>
        }>{loadError}</DetailPaneNotice>
      )}
      {actionError && <DetailPaneNotice severity="error" density="compact" title="Backup settings update failed">{actionError}</DetailPaneNotice>}
      {runError && <DetailPaneNotice severity="error" density="compact" title="Backup run failed">{runError}</DetailPaneNotice>}

      {readAllowed && loading && (
        <div className="settings-view__section-body settings-view__empty">Loading backup status...</div>
      )}
      {readAllowed && !loading && !loadError && status && (
      <div className="settings-view__section-body">
        {/* Toggle row */}
        <div className="settings-view__toggle-row" data-settings-searchable>
          <div className="settings-view__toggle-info">
            <h3 className="settings-view__section-title">Automatic backup</h3>
            <p className="settings-view__section-desc">Run Mandible's metadata dump on a schedule.</p>
          </div>
          <Toggle
            enabled={status.enabled}
            onToggle={handleToggle}
            disabled={!settingsAllowed || toggling}
            label="Toggle automatic backup"
          />
        </div>

        {/* Interval selector — only shown when enabled */}
        {status.enabled && (
          <div className="settings-view__select-row" data-settings-searchable>
            <div className="settings-view__select-info">
              <span className="settings-view__select-label">Interval</span>
            </div>
            <select
              className="settings-view__select"
              value={status.interval_hours}
              onChange={handleIntervalChange}
              disabled={!settingsAllowed}
            >
              <option value={6}>6h</option>
              <option value={12}>12h</option>
              <option value={24}>24h</option>
            </select>
          </div>
        )}

        <div className="settings-view__text-row" data-settings-searchable>
          <div className="settings-view__text-info">
            <span className="settings-view__text-label">Destination</span>
          </div>
          <div className="settings-view__text-controls">
            <input
              className="settings-view__input settings-view__input--wide"
              type="text"
              value={destinationInput}
              onInput={(e) => setDestinationInput((e.target as HTMLInputElement).value)}
              aria-label="Backup destination"
              aria-invalid={destinationSaveState.error != null || normalizeBackupDestination(destinationInput) == null}
              disabled={!settingsAllowed}
            />
            {destinationSaveState.saving && <span className="settings-view__text-desc" role="status">Saving</span>}
            {destinationSaveState.error && <span className="settings-view__warning" role="alert">{destinationSaveState.error}</span>}
            {!destinationSaveState.error && normalizeBackupDestination(destinationInput) == null && (
              <span className="settings-view__warning" role="status">Enter a backup destination.</span>
            )}
          </div>
        </div>

        {/* Status row */}
        <div className="settings-view__number-row" data-settings-searchable>
          <div className="settings-view__number-info">
            <span className="settings-view__number-label">Last backup</span>
          </div>
          <div className="settings-view__number-controls">
            {status.last_run_at ? (
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
        <div className="settings-view__number-row" data-settings-searchable>
          <div className="settings-view__number-info">
            <span className="settings-view__number-label">Manual run</span>
          </div>
          <div className="settings-view__number-controls">
            <button
              type="button"
              className="btn btn--active btn--sm"
              onClick={handleRunNow}
              disabled={!runAllowed || running}
            >
              {running ? '...' : 'Run Now'}
            </button>
          </div>
        </div>
      </div>
      )}
      {readAllowed && !loading && !loadError && !status && (
        <div className="settings-view__section-body settings-view__empty">Backup status is unavailable.</div>
      )}
    </SettingsSectionShell>
  );
}

function ProjectPermissionsSection(props: { section: SettingsSectionDefinition; instance?: InstanceInfo | null }): JSX.Element {
  const [projects, setProjects] = useState<ProjectPickerItem[]>([]);
  const [selected, setSelected] = useState('');
  const [access, setAccess] = useState<ProjectAccessSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const readAllowed = canPerformOperation(props.instance, 'GET', '/api/projects');
  const mutationsAllowed = Boolean(selected && canPerformOperation(
    props.instance,
    'PATCH',
    `/api/projects/${encodeURIComponent(selected)}/access`,
    { restricted: !Boolean(access?.restricted) },
  ));

  useEffect(() => {
    if (!readAllowed) {
      setError('Project permissions are unavailable in this instance.');
      return;
    }
    void listProjectsForPicker().then((items) => {
      setProjects(items);
      if (!selected && items[0]) setSelected(items[0].project_key);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Failed to load projects'));
  }, [props.instance, readAllowed]);

  useEffect(() => {
    if (!readAllowed || !selected) {
      setAccess(null);
      return;
    }
    setError('');
    void getProjectAccessSettings(selected)
      .then(setAccess)
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Failed to load access'));
  }, [props.instance, readAllowed, selected]);

  const toggleRestricted = useCallback(async () => {
    if (!mutationsAllowed || !selected || !access) return;
    setBusy(true);
    setError('');
    try {
      setAccess(await updateProjectAccessSettings(selected, !access.restricted));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to update access');
    } finally {
      setBusy(false);
    }
  }, [selected, access, mutationsAllowed]);

  return (
    <SettingsSectionShell section={props.section} testId="project-permissions-settings">
      <SettingsSectionHeader
        section={props.section}
        description="Projects remain unrestricted until this toggle is enabled. Grants are managed with the user CLI."
      />
      {!mutationsAllowed ? (
        <DetailPaneNotice severity="info" density="compact" title="Project settings unavailable">
          This instance cannot change project restrictions.
        </DetailPaneNotice>
      ) : null}
      {error && <DetailPaneNotice severity="error" density="compact" title="Project permissions unavailable">{error}</DetailPaneNotice>}
      <div className="settings-view__section-body">
        <div className="settings-view__select-row" data-settings-searchable>
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
            <div className="settings-view__toggle-row" data-settings-searchable>
              <div className="settings-view__toggle-info">
                <h3 className="settings-view__section-title">Restricted</h3>
                <p className="settings-view__section-desc">Require an explicit read, write, or admin grant.</p>
              </div>
              <Toggle enabled={access.restricted} onToggle={() => void toggleRestricted()}
                disabled={!mutationsAllowed || busy} label="Toggle project restriction" />
            </div>
            <div className="settings-view__text-row" data-settings-searchable>
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
      </div>
    </SettingsSectionShell>
  );
}

export function SettingsView(props: SettingsViewProps): JSX.Element {
  const {
    settings,
    onSave,
    loadError = null,
    onRefresh = () => undefined,
    instance = null,
    typography = DEFAULT_TYPOGRAPHY_SETTINGS,
    onTypographySave = async () => undefined,
  } = props;
  const onSaveRef = useRef(onSave);
  const onTypographySaveRef = useRef(onTypographySave);
  onSaveRef.current = onSave;
  onTypographySaveRef.current = onTypographySave;
  const saveSetting = useMemo(() => createOrderedSettingSave((key, value) => onSaveRef.current(key, value)), []);
  const saveTypographySetting = useMemo(() => createOrderedSettingSave(
    (key, value) => onTypographySaveRef.current(key as UserTypographySettingKey, value),
  ), []);
  const canSaveTypography = (key: UserTypographySettingKey) => canPerformOperation(instance, 'PUT', `/api/user-settings/${key}`);
  const appThemeAllowed = canPerformOperation(instance, 'PUT', '/api/host-preferences/app-theme');
  const instructionReadAllowed = canPerformOperation(instance, 'GET', '/api/settings/instructions-delivery');
  const instructionSettingsAllowed = canPerformOperation(instance, 'PUT', '/api/settings/instructions-delivery', {
    targets: [],
    cleanupRemovedTargets: false,
  });
  // Preview accepts these copied-setting writes but deliberately skips the host export.
  const exportRunsOnSave = instance?.role !== 'preview';
  const [protectedBranches, setProtectedBranches] = useState('');
  const [quietHours, setQuietHours] = useState('');
  const [issueDefaultFilter, setIssueDefaultFilter] = useState('status:open');
  const [saving, setSaving] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const issueFilterInitialized = useRef(false);
  const feedbackTimer = useRef<number | null>(null);
  const initialized = useRef(false);
  const quietInitialized = useRef(false);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [activeSection, setActiveSection] = useState<string>(SETTINGS_SECTIONS.notifications.id);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState(0);
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
    if (!issueFilterInitialized.current && settings['issues.default_filter'] != null) {
      setIssueDefaultFilter(settings['issues.default_filter'].trim() || 'status:open');
      issueFilterInitialized.current = true;
    }
  }, [settings['issues.default_filter']]);

  const quietHoursSaveState = useDebouncedSettingSave(
    'quiet_hours', quietHours, settings.quiet_hours ?? '', saveSetting, normalizeQuietHours, quietInitialized.current,
  );
  const issueFilterSaveState = useDebouncedSettingSave(
    'issues.default_filter',
    issueDefaultFilter,
    settings['issues.default_filter']?.trim() || 'status:open',
    saveSetting,
    normalizeIssueDefaultFilter,
    issueFilterInitialized.current,
  );
  const protectedBranchesSaveState = useDebouncedSettingSave(
    'protected_branches',
    protectedBranches,
    normalizeProtectedBranches(settings.protected_branches ?? '') ?? '',
    saveSetting,
    normalizeProtectedBranches,
    initialized.current,
  );

  const showFeedback = useCallback((state: FeedbackState) => {
    if (feedbackTimer.current != null) window.clearTimeout(feedbackTimer.current);
    setFeedback(state);
    if (state?.type === 'success') {
      feedbackTimer.current = window.setTimeout(() => {
        setFeedback(null);
        feedbackTimer.current = null;
      }, 3000);
    }
  }, []);

  const handleTypographyField = useCallback(async (key: UserTypographySettingKey, value: string) => {
    if (!canSaveTypography(key)) return;
    setSaving(key);
    try {
      await saveTypographySetting(key, value);
      showFeedback({ type: 'success', message: 'Saved' });
    } catch (err) {
      showFeedback({ type: 'error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setSaving(null);
    }
  }, [instance, saveTypographySetting, showFeedback]);

  const handleSectionNavigation = useCallback((sectionId: string) => {
    setActiveSection(sectionId);
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    const root = viewRef.current;
    const content = root?.querySelector('.settings-view__content');
    if (!root || !content) return;
    const query = searchQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const rowSelector = '[data-settings-searchable]';
    const update = () => {
      let matches = 0;
      for (const section of Array.from(content.querySelectorAll<HTMLElement>('.settings-view__section'))) {
        const candidates = Array.from(section.querySelectorAll<HTMLElement>(rowSelector)).filter((row) => (
          !row.parentElement?.closest(rowSelector)
        ));
        let sectionMatches = 0;
        for (const row of candidates) {
          const sectionTitle = section.querySelector('.settings-view__section-title')?.textContent ?? '';
          const searchableText = `${sectionTitle} ${row.textContent ?? ''} ${row.dataset.settingsSearchText ?? ''}`.toLocaleLowerCase();
          const matched = query.length === 0 || query.every((term) => searchableText.includes(term));
          row.hidden = !matched;
          if (matched) {
            sectionMatches += 1;
            matches += 1;
          }
        }
        section.hidden = query.length > 0 && sectionMatches === 0;
        const tocLink = root.querySelector<HTMLElement>(`[aria-controls="${section.id}"]`);
        if (tocLink) tocLink.hidden = section.hidden;
      }
      setSearchMatches(matches);
      const firstVisibleSection = visibleSections.find((section) => {
        const element = content.querySelector<HTMLElement>(`#${section.id}`);
        return element && !element.hidden;
      });
      if (firstVisibleSection) {
        setActiveSection((current) => content.querySelector<HTMLElement>(`#${current}`)?.hidden
          ? firstVisibleSection.id
          : current);
      }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(content, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-settings-search-text'],
      subtree: true,
    });
    return () => observer.disconnect();
  }, [searchQuery, desktopShell]);

  useEffect(() => {
    const root = viewRef.current;
    if (!root) return;
    let frame = 0;
    const updateActiveSection = () => {
      frame = 0;
      const rootTop = root.getBoundingClientRect().top;
      const currentlyVisibleSections = visibleSections.filter((section) => {
        const element = document.getElementById(section.id);
        return element && !element.hidden;
      });
      let current = currentlyVisibleSections[0]?.id ?? SETTINGS_SECTIONS.notifications.id;
      for (const section of currentlyVisibleSections) {
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
  }, [desktopShell, searchMatches]);

  return (
    <div className="settings-view" ref={viewRef}>
      <div className="view-header">
        <h2>Settings</h2>
      </div>
      <AppOperationalNoticeOutlet registerAsMain />
      {loadError ? (
        <DetailPaneNotice
          severity="error"
          source="settings-load"
          title="Settings could not be loaded"
          actions={<button type="button" onClick={onRefresh}>Retry</button>}
        >
          {loadError}
        </DetailPaneNotice>
      ) : null}

      <div className="settings-view__layout">
        <nav className="settings-view__toc" aria-label="Settings sections">
          <div className="settings-view__search-label">
            <input
              type="search"
              className="settings-view__input"
              value={searchQuery}
              onInput={(event) => setSearchQuery((event.target as HTMLInputElement).value)}
              aria-label="Search individual settings"
              placeholder="Find a setting"
            />
          </div>
          {visibleSections.map((section) => {
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
          {searchQuery.trim() && searchMatches === 0 && (
            <p className="settings-view__empty" role="status">No settings match “{searchQuery.trim()}”.</p>
          )}

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
            onSave={saveSetting}
          />
          <ToggleRow
            title="Codex notifications"
            desc="Show desktop notification when Codex CLI stops."
            settingKey="codex_notifications_enabled"
            settings={settings}
            onSave={saveSetting}
          />
          <SelectInput
            label="Sound"
            desc="macOS notification sound"
            settingKey="notification_sound"
            settings={settings}
            onSave={saveSetting}
            options={SOUNDS}
          />
          <div className="settings-view__text-row" data-settings-searchable>
            <div className="settings-view__text-info">
              <span className="settings-view__text-label">Quiet hours</span>
              <span className="settings-view__text-desc">Suppress notifications during this window (HH:MM-HH:MM)</span>
            </div>
            <div className="settings-view__text-controls">
              <input
                type="text"
                className="settings-view__input settings-view__input--narrow"
                value={quietHours}
                onInput={(e) => {
                  quietInitialized.current = true;
                  setQuietHours((e.target as HTMLInputElement).value);
                }}
                placeholder="22:00-08:00"
                aria-invalid={quietHoursSaveState.error != null || normalizeQuietHours(quietHours) == null}
              />
              {quietHoursSaveState.saving && <span className="settings-view__text-desc" role="status">Saving</span>}
              {quietHoursSaveState.error && <span className="settings-view__warning" role="alert">{quietHoursSaveState.error}</span>}
              {!quietHoursSaveState.error && normalizeQuietHours(quietHours) == null && (
                <span className="settings-view__warning" role="status">Use HH:MM-HH:MM with valid times.</span>
              )}
            </div>
          </div>
        </div>
      </SettingsSectionShell>

      <DesktopDaemonSection section={SETTINGS_SECTIONS.daemon} instance={instance} />

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
            onSave={saveSetting}
            warning="Disabling hooks removes safety guards. Agents may execute dangerous operations unchecked."
          />
          <ToggleRow
            title="Subagent panes"
            desc="Spawn Zellij panes for subagent output streams. Requires Zellij and a working zj-control plugin."
            settingKey="subagent_panes_enabled"
            settings={settings}
            onSave={saveSetting}
          />
        </div>
      </SettingsSectionShell>

      <InstructionsDeliverySection
        section={SETTINGS_SECTIONS.instructionDelivery}
        settings={settings}
        onSave={saveSetting}
        readAllowed={instructionReadAllowed}
        settingsAllowed={instructionSettingsAllowed}
        exportRunsOnSave={exportRunsOnSave}
      />

      <ProjectPermissionsSection section={SETTINGS_SECTIONS.projectPermissions} instance={instance} />

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
            onSave={saveSetting}
          />
        </div>
      </SettingsSectionShell>

      <SettingsSectionShell section={SETTINGS_SECTIONS.chatDefaults}>
        <SettingsSectionHeader section={SETTINGS_SECTIONS.chatDefaults} description="Choose the model, effort and permissions used for new chats. Existing chats keep their own choices." />
        <div className="settings-view__section-body">
          <ManagedChatDefaults canSave={canPerformOperation(instance, 'PUT', '/api/user-settings/managed_chat_defaults')} />
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
            onSave={saveSetting}
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
            onSave={saveSetting}
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
          <div className="settings-view__select-row" data-settings-searchable>
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
                  await saveSetting('resume_conflict_policy', (e.target as HTMLSelectElement).value);
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
          <div className="settings-view__select-row" data-settings-searchable>
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
                  await saveSetting('auto_resume_policy', (e.target as HTMLSelectElement).value);
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
            onSave={saveSetting}
            options={MARKDOWN_BODY_ESCAPE_POLICIES}
          />
          <div className="settings-view__text-row" data-settings-searchable>
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
                onInput={(e) => {
                  issueFilterInitialized.current = true;
                  setIssueDefaultFilter((e.target as HTMLInputElement).value);
                }}
                placeholder="status:open"
                aria-invalid={issueFilterSaveState.error != null || normalizeIssueDefaultFilter(issueDefaultFilter) == null}
              />
              {issueFilterSaveState.saving && <span className="settings-view__text-desc" role="status">Saving</span>}
              {issueFilterSaveState.error && <span className="settings-view__warning" role="alert">{issueFilterSaveState.error}</span>}
              {!issueFilterSaveState.error && normalizeIssueDefaultFilter(issueDefaultFilter) == null && (
                <span className="settings-view__warning" role="status">Complete any status, kind, or priority token.</span>
              )}
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
            <div className="settings-view__select-row" data-settings-searchable key={key}>
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
                  disabled={!canSaveTypography(key) || saving === key}
                  onChange={(event) => void handleTypographyField(key, (event.target as HTMLSelectElement).value)}
                >
                  {options.map(([value, text]) => <option value={value} key={value}>{text}</option>)}
                </select>
              </div>
            </div>
          ))}
          {([
            ['ui_font_size', 'UI size', 'Base size for chrome and controls.'],
            ['detail_font_size', 'Detail content size', 'Base size for ordinary entity-detail prose.'],
          ] as const).map(([key, label, desc]) => (
            <div className="settings-view__text-row" data-settings-searchable key={key}>
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
                  disabled={!canSaveTypography(key) || saving === key}
                  onChange={(event) => {
                    const value = (event.target as HTMLInputElement).value;
                    if (Number.isInteger(Number(value)) && Number(value) >= 10 && Number(value) <= 20) {
                      void handleTypographyField(key, value);
                    }
                  }}
                />
              </div>
            </div>
          ))}
          <div className="settings-view__select-row" data-settings-searchable>
            <div className="settings-view__select-info">
              <label className="settings-view__select-label" htmlFor="settings-app-theme">App theme</label>
              <span id="settings-app-theme-description" className="settings-view__select-desc">Follow the system appearance or pin Mandible to dark or light</span>
            </div>
            <select
              id="settings-app-theme"
              className="settings-view__select"
              aria-describedby="settings-app-theme-description"
              value={normalizeAppThemeMode(settings.app_theme)}
              disabled={!appThemeAllowed}
              onChange={async (e) => {
                if (!appThemeAllowed) return;
                try {
                  await saveSetting('app_theme', normalizeAppThemeMode((e.target as HTMLSelectElement).value));
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
            const themeAllowed = canPerformOperation(instance, 'PUT', `/api/settings/${key}`);
            const descriptionId = `settings-${key}-description`;
            return (
              <div className="settings-view__select-row" data-settings-searchable key={key}>
                <div className="settings-view__select-info">
                  <label className="settings-view__select-label" htmlFor={`settings-${key}`}>{label}</label>
                  <span id={descriptionId} className="settings-view__select-desc">{description}</span>
                </div>
                <select
                  id={`settings-${key}`}
                  className="settings-view__select"
                  aria-describedby={descriptionId}
                  value={normalizeTerminalThemeId(settings[key])}
                  disabled={!themeAllowed}
                  onChange={async (event) => {
                    if (!themeAllowed) return;
                    try {
                      await saveSetting(key, normalizeTerminalThemeId((event.target as HTMLSelectElement).value));
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
            onSave={saveSetting}
            defaultEnabled
          />
          {/* Bug: 914e9d7 — Header tab display mode */}
          <div className="settings-view__select-row" data-settings-searchable>
            <div className="settings-view__select-info">
              <span className="settings-view__select-label">Header tabs</span>
              <span className="settings-view__select-desc">Show text labels, icons, or both in header tabs</span>
            </div>
            <select
              className="settings-view__select"
              value={settings.header_display_mode ?? 'text'}
              onChange={async (e) => {
                try {
                  await saveSetting('header_display_mode', (e.target as HTMLSelectElement).value);
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
            onSave={saveSetting}
            options={THEMES}
            requiresRestart
          />
          <SelectInput
            label="Prompt"
            desc="Shell prompt engine"
            settingKey="prompt"
            settings={settings}
            onSave={saveSetting}
            options={PROMPTS}
            requiresRestart
          />
          <SelectInput
            label="Multiplexer"
            desc="Terminal multiplexer preference"
            settingKey="multiplexer"
            settings={settings}
            onSave={saveSetting}
            options={MULTIPLEXERS}
            requiresRestart
          />
          <SettingsFeedback feedback={feedback} />
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
            onSave={saveSetting}
            defaultEnabled
          />
          <ToggleRow
            title="Return to overview after approval"
            desc="Switch back to the request overview after approval finishes successfully."
            settingKey={AUTH_AUTO_RETURN_TO_OVERVIEW_SETTING}
            settings={settings}
            onSave={saveSetting}
            defaultEnabled
          />
          <ToggleRow
            title="Keep the finalized request selected"
            desc="When Active requests are shown, keep a just-finalized request visible until another request is selected."
            settingKey={AUTH_RETAIN_FINALIZED_SELECTION_SETTING}
            settings={settings}
            onSave={saveSetting}
            defaultEnabled
          />
          <DelegatedSigningSection instance={instance} />
        </div>
      </SettingsSectionShell>

      <SettingsSectionShell section={SETTINGS_SECTIONS.authHooks}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.authHooks}
          description="Repo-specific post-approval hook configuration."
        />
        <div className="settings-view__section-body">
          <AuthHooksPanel
            instance={instance}
          />
        </div>
      </SettingsSectionShell>

      <SettingsSectionShell section={SETTINGS_SECTIONS.signing}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.signing}
          description="Register the public key Git uses to sign commits."
        />
        <div className="settings-view__section-body" data-testid="settings-signing-content">
          <SigningSettings instance={instance} />
        </div>
      </SettingsSectionShell>

      {/* ── Section 5: Version Control ── */}
      <SettingsSectionShell section={SETTINGS_SECTIONS.versionControl}>
        <SettingsSectionHeader
          section={SETTINGS_SECTIONS.versionControl}
          description="Comma-separated branch names that are pinned in the Work tab and used as the baseline for ahead/behind counts."
        />
        <div className="settings-view__field" data-settings-searchable data-settings-search-text="protected branches pinned Work tab baseline counts">
          <input
            type="text"
            className="settings-view__input"
            value={protectedBranches}
            onInput={(e) => {
              initialized.current = true;
              setProtectedBranches((e.target as HTMLInputElement).value);
            }}
            placeholder="main, develop"
            aria-label="Protected branches"
            aria-invalid={protectedBranchesSaveState.error != null || normalizeProtectedBranches(protectedBranches) == null}
          />
          {protectedBranchesSaveState.saving && <span className="settings-view__text-desc" role="status">Saving</span>}
          {protectedBranchesSaveState.error && <span className="settings-view__warning" role="alert">{protectedBranchesSaveState.error}</span>}
          {!protectedBranchesSaveState.error && normalizeProtectedBranches(protectedBranches) == null && (
            <span className="settings-view__warning" role="status">Complete each branch name between commas.</span>
          )}
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
            onSave={saveSetting}
            min={1}
            max={365}
            suffix="days"
          />
        </div>
      </SettingsSectionShell>

      {/* ── Section 7: Backup ── */}
      <BackupSection section={SETTINGS_SECTIONS.backup} instance={instance} />

        </div>
      </div>
    </div>
  );
}
