import { createContext, type ComponentChildren } from 'preact';
import { useContext } from 'preact/hooks';
import { authReviewHash } from './auth-review-navigation';
import type { DiffFileIdentity } from '../components/diff-file-identity';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { AuthChangeFile, AuthChangeFileRole, AuthChangeKind, AuthChangeReport } from '../../../src/contracts';
import { CollapsiblePanel } from '../components/shared/CollapsiblePanel';
import { DisclosureChevronIcon } from '../components/shared/DisclosureChevronIcon';
import { usePersistedScrollPosition } from '../hooks/usePersistedScrollPosition';
import { usePersistedViewState } from '../hooks/usePersistedViewState';
import {
  AUTH_CHANGE_BREAKDOWN_VIEWS,
  DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE,
  authChangeBreakdownStorageKey,
  normalizeAuthChangeBreakdownViewState,
  type AuthChangeBreakdownView,
  type AuthChangeBreakdownViewState,
} from './auth-change-breakdown-state';

type FileNavigation = { requestId: string; activate?: (file: AuthChangeFile) => void };
const FileNavigationContext = createContext<FileNavigation>({ requestId: '' });

type ChangeGroup = {
  id: string;
  label: string;
  files: AuthChangeFile[];
  additions: number;
  deletions: number;
};

const VIEW_LABELS: Record<AuthChangeBreakdownView, string> = {
  language: 'Language',
  directory: 'Directory',
  role: 'File role',
  flags: 'Generated / vendor',
  largest: 'Largest files',
};

const ROLE_LABELS: Record<AuthChangeFileRole, string> = {
  fixtures_data: 'Fixtures / data',
  tests: 'Tests',
  documentation: 'Documentation',
  configuration: 'Configuration',
  implementation: 'Implementation',
  other: 'Other',
};

function formatCount(value: number): string {
  return value.toLocaleString();
}

function changedLines(file: AuthChangeFile): number | null {
  if (file.additions === null || file.deletions === null) return null;
  return file.additions + file.deletions;
}

function displayPath(file: AuthChangeFile): string {
  return file.new_path ?? file.old_path ?? '(unknown path)';
}

function compareFiles(left: AuthChangeFile, right: AuthChangeFile): number {
  const lineDifference = (changedLines(right) ?? -1) - (changedLines(left) ?? -1);
  return lineDifference || displayPath(left).localeCompare(displayPath(right));
}

function newChangeGroup(id: string, label: string): ChangeGroup {
  return { id, label, files: [], additions: 0, deletions: 0 };
}

function addFileToGroup(group: ChangeGroup, file: AuthChangeFile): void {
  group.files.push(file);
  group.additions += file.additions ?? 0;
  group.deletions += file.deletions ?? 0;
}

function finishGroups(groups: Iterable<ChangeGroup>): ChangeGroup[] {
  return Array.from(groups)
    .map((group) => ({ ...group, files: group.files.sort(compareFiles) }))
    .sort((left, right) => {
      const changedDifference = groupChangedLines(right) - groupChangedLines(left);
      return changedDifference || left.label.localeCompare(right.label);
    });
}

function groupFiles(
  files: AuthChangeFile[],
  groupFor: (file: AuthChangeFile) => { id: string; label: string },
): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();
  for (const file of files) {
    const identity = groupFor(file);
    const group = groups.get(identity.id) ?? newChangeGroup(identity.id, identity.label);
    addFileToGroup(group, file);
    groups.set(identity.id, group);
  }
  return finishGroups(groups.values());
}

function groupChangedLines(group: ChangeGroup): number {
  return group.additions + group.deletions;
}

function formatShare(lines: number, totalLines: number): string {
  if (totalLines === 0) return '—';
  if (lines === 0) return '0%';
  const share = lines / totalLines * 100;
  return `${share < 0.1 && share > 0 ? '<0.1' : share.toFixed(share >= 10 ? 0 : 1)}%`;
}

function formatBytes(value: number | null): string {
  if (value === null) return 'unknown';
  if (value < 1024) return `${formatCount(value)} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let amount = value / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index]!;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
}

function isGitlinkChange(file: AuthChangeFile): boolean {
  return file.file_type_before === 'gitlink' || file.file_type_after === 'gitlink';
}

function fileKindLabels(file: AuthChangeFile): string[] {
  const labels: string[] = [];
  if ((file.additions === null || file.deletions === null) && !isGitlinkChange(file)) labels.push('binary');
  for (const type of [file.file_type_before, file.file_type_after]) {
    if ((type === 'symlink' || type === 'gitlink') && !labels.includes(type)) labels.push(type);
  }
  return labels;
}

const FILE_STATUS: Record<AuthChangeKind, { letter: string; label: string }> = {
  added: { letter: 'A', label: 'Added' },
  deleted: { letter: 'D', label: 'Deleted' },
  modified: { letter: 'M', label: 'Modified' },
  renamed: { letter: 'R', label: 'Renamed' },
  copied: { letter: 'C', label: 'Copied' },
  type_changed: { letter: 'T', label: 'Type changed' },
};

function fullPath(file: AuthChangeFile): string {
  return (file.change_kind === 'renamed' || file.change_kind === 'copied')
    && file.old_path && file.new_path && file.old_path !== file.new_path
    ? `${file.old_path} → ${file.new_path}` : displayPath(file);
}

function specialMetrics(file: AuthChangeFile): string {
  return isGitlinkChange(file) ? 'submodule' : `${formatBytes(file.bytes_before)} → ${formatBytes(file.bytes_after)}`;
}

function FileMetrics({ file, totalLines }: { file: AuthChangeFile; totalLines: number }): JSX.Element {
  const lines = changedLines(file);
  if (lines === null) {
    if (isGitlinkChange(file)) {
      return <span className="auth-change-file__special-change" title="Submodule reference changed">submodule</span>;
    }
    return (
      <span className="auth-change-file__binary-size">
        {specialMetrics(file)}
      </span>
    );
  }
  return (
    <>
      <span className="auth-change-file__added" title="Additions">+{formatCount(file.additions ?? 0)}</span>
      <span className="auth-change-file__deleted" title="Deletions">−{formatCount(file.deletions ?? 0)}</span>
      <span title="Share of changed text lines">{formatShare(lines, totalLines)}</span>
    </>
  );
}

function ChangeGroupMetrics({
  group,
  totalLines,
}: {
  group: ChangeGroup;
  totalLines: number;
}): JSX.Element {
  return (
    <>
      <span>{formatCount(group.files.length)}</span>
      <span>+{formatCount(group.additions)}</span>
      <span>−{formatCount(group.deletions)}</span>
      <span>{formatShare(groupChangedLines(group), totalLines)}</span>
    </>
  );
}

function ChangeFileRow({ file, totalLines }: { file: AuthChangeFile; totalLines: number }): JSX.Element {
  const navigation = useContext(FileNavigationContext);
  const identity: DiffFileIdentity = { oldPath: file.old_path, newPath: file.new_path };
  const status = FILE_STATUS[file.change_kind];
  const metadata = [...fileKindLabels(file), ...(file.generated ? ['generated'] : []), ...(file.vendor ? ['vendor'] : [])];
  const description = [fullPath(file), ...metadata].join(' · ');
  return (
    <li>
      <a className="auth-change-file" href={authReviewHash(window.location.hash, navigation.requestId, 'diff', identity)}
        onClick={event => {
          if (!navigation.activate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          navigation.activate(file);
        }}>
      <div className="auth-change-file__identity">
        <span className={`auth-change-file__status auth-change-file__status--${file.change_kind}`} aria-label={status.label} title={status.label}>{status.letter}</span>
        <code className="auth-change-file__path" title={description} aria-label={description}>{fullPath(file)}</code>
      </div>
      <div
        className={`auth-change-file__metrics${changedLines(file) === null ? ' auth-change-file__metrics--non-text' : ''}`}
        aria-label={changedLines(file) === null ? isGitlinkChange(file) ? 'Submodule reference change' : 'Binary byte sizes' : 'Additions, deletions, and share'}
      >
        <FileMetrics file={file} totalLines={totalLines} />
      </div>
      </a>
    </li>
  );
}

function toggleExpandedGroup(
  state: AuthChangeBreakdownViewState,
  setState: (next: AuthChangeBreakdownViewState) => void,
  id: string,
): void {
  const expanded = new Set(state.expandedGroups);
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  setState({ ...state, expandedGroups: Array.from(expanded) });
}

type BreakdownViewModel = {
  kind: 'groups' | 'directory' | 'files';
  groups: ChangeGroup[];
  files: AuthChangeFile[];
};

function breakdownView(report: AuthChangeReport, state: AuthChangeBreakdownViewState): BreakdownViewModel {
  if (state.view === 'largest') return { kind: 'files', groups: [], files: [...report.files].sort(compareFiles) };
  if (state.view === 'directory') {
    const nested = new Map<string, ChangeGroup>();
    const files: AuthChangeFile[] = [];
    for (const file of report.files) {
      const parts = displayPath(file).split('/');
      if (!state.directoryPath.every((part, index) => parts[index] === part)) continue;
      const next = parts[state.directoryPath.length];
      if (!next || parts.length === state.directoryPath.length + 1) files.push(file);
      else {
        const group = nested.get(next) ?? newChangeGroup(`directory:${[...state.directoryPath, next].join('/')}`, next);
        addFileToGroup(group, file);
        nested.set(next, group);
      }
    }
    return { kind: 'directory', groups: finishGroups(nested.values()), files: files.sort(compareFiles) };
  }
  const groups = state.view === 'language'
    ? groupFiles(report.files, file => ({ id: `language:${file.language}`, label: file.language }))
    : state.view === 'role'
      ? groupFiles(report.files, file => ({ id: `role:${file.file_role}`, label: ROLE_LABELS[file.file_role] }))
      : groupFiles(report.files, file => file.generated
        ? { id: 'flag:generated', label: 'Generated' } : { id: 'flag:not-generated', label: 'Not generated' })
        .concat(groupFiles(report.files, file => file.vendor
          ? { id: 'flag:vendor', label: 'Vendor' } : { id: 'flag:not-vendor', label: 'Not vendor' }));
  return { kind: 'groups', groups, files: [] };
}

function DirectoryBreadcrumbs({ state, setState }: {
  state: AuthChangeBreakdownViewState;
  setState: (next: AuthChangeBreakdownViewState) => void;
}): JSX.Element {
  return (
    <nav className="auth-change-directory__breadcrumbs" aria-label="Change report directory">
      <button type="button" onClick={() => setState({ ...state, directoryPath: [] })}>root</button>
      {state.directoryPath.map((part, index) => (
        <span key={`${part}:${index}`}>
          <span aria-hidden="true">/</span>
          <button type="button" onClick={() => setState({ ...state, directoryPath: state.directoryPath.slice(0, index + 1) })}>{part}</button>
        </span>
      ))}
    </nav>
  );
}

function ChangeFiles({ files, totalLines }: { files: AuthChangeFile[]; totalLines: number }): JSX.Element {
  return <ul className="auth-change-files">
    {files.map((file, index) => <ChangeFileRow key={`${displayPath(file)}:${index}`} file={file} totalLines={totalLines} />)}
  </ul>;
}

function ItemViewport({ storageKey, label, groupId, id, children, initialOffsets }: {
  storageKey: string; label: string; groupId?: string; id?: string; children: ComponentChildren; initialOffsets?: Map<string, number>;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [initialPosition] = useState(() => {
    const position = initialOffsets?.get(storageKey);
    initialOffsets?.delete(storageKey);
    return position;
  });
  usePersistedScrollPosition(ref, storageKey, { initialPosition });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const updateGutter = () => node.closest<HTMLElement>('.auth-change-breakdown__table-content')?.style.setProperty('--auth-change-scrollbar-width', `${node.offsetWidth - node.clientWidth}px`);
    updateGutter();
    const observer = new ResizeObserver(updateGutter);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} id={id} data-change-group={groupId} data-auth-scroll-key={storageKey}
    className={`auth-change-breakdown__items${groupId ? ' auth-change-breakdown__items--group' : ''}`}
    role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

function BreakdownItems({ requestId, model, state, setState, totalLines, initialOffsets }: {
  requestId: string;
  model: BreakdownViewModel;
  state: AuthChangeBreakdownViewState;
  setState: (next: AuthChangeBreakdownViewState) => void;
  totalLines: number;
  initialOffsets?: Map<string, number>;
}): JSX.Element {
  if (model.kind === 'groups') {
    return <div className="auth-change-group-stack">
      {model.groups.map(group => {
        const expanded = state.expandedGroups.includes(group.id);
        const bodyId = `auth-change-group-${encodeURIComponent(requestId)}-${encodeURIComponent(group.id)}`;
        return <div className="auth-change-group" key={group.id}>
          <button type="button" className="auth-change-group__row auth-change-group__row--outside"
            aria-expanded={expanded} aria-controls={bodyId}
            onClick={() => toggleExpandedGroup(state, setState, group.id)}>
            <span className="auth-change-group__name"><DisclosureChevronIcon expanded={expanded} size={13} /><span>{group.label}</span></span>
            <ChangeGroupMetrics group={group} totalLines={totalLines} />
          </button>
          {expanded && <ItemViewport initialOffsets={initialOffsets} id={bodyId} groupId={group.id} label={`${group.label} files`}
            storageKey={`auth-breakdown-scroll:${requestId}:${state.view}:group:${encodeURIComponent(group.id)}`}>
            <ChangeFiles files={group.files} totalLines={totalLines} />
          </ItemViewport>}
        </div>;
      })}
    </div>;
  }
  const directory = state.view === 'directory' ? state.directoryPath.map(encodeURIComponent).join('/') : '';
  return <ItemViewport key={`auth-breakdown-scroll:${requestId}:${state.view}:${directory}`} initialOffsets={initialOffsets} label="Change breakdown items" storageKey={`auth-breakdown-scroll:${requestId}:${state.view}:${directory}`}>
    {model.groups.map(group => <button type="button" className="auth-change-group__row" key={group.id}
      onClick={() => setState({ ...state, directoryPath: [...state.directoryPath, group.label] })}>
      <span className="auth-change-group__name"><span>{group.label}/</span></span>
      <ChangeGroupMetrics group={group} totalLines={totalLines} />
    </button>)}
    {model.files.length > 0 && <ChangeFiles files={model.files} totalLines={totalLines} />}
  </ItemViewport>;
}

export function AuthChangeBreakdown({
  requestId,
  report,
  initialState,
  initialOffsets,
  onFileActivate,
}: {
  requestId: string;
  report: AuthChangeReport | null | undefined;
  initialState?: AuthChangeBreakdownViewState;
  initialOffsets?: Record<string, number>;
  onFileActivate?: (file: AuthChangeFile, state: AuthChangeBreakdownViewState) => void;
}): JSX.Element {
  const [state, setState] = usePersistedViewState(
    authChangeBreakdownStorageKey(requestId),
    normalizeAuthChangeBreakdownViewState,
    DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE,
    initialState,
  );
  const restorationOffsets = useMemo(() => new Map(Object.entries(initialOffsets ?? {})), [initialOffsets]);
  const viewPanelId = `auth-change-breakdown-panel-${encodeURIComponent(requestId)}`;
  const model = useMemo(() => report ? breakdownView(report, state) : null, [report, state.view, state.directoryPath]);
  const columnWidths = useMemo(() => {
    if (!report) return {};
    const specialWidth = report.files.reduce((width, file) => changedLines(file) === null ? Math.max(width, specialMetrics(file).length) : width, 0);
    const specialNumberWidth = Math.ceil((specialWidth - 7) / 2);
    return {
      '--auth-change-files-width': `${Math.max(5, formatCount(report.totals.files).length)}ch`,
      '--auth-change-add-width': `${Math.max(3, specialNumberWidth, formatCount(report.totals.additions).length + 1)}ch`,
      '--auth-change-del-width': `${Math.max(3, specialNumberWidth, formatCount(report.totals.deletions).length + 1)}ch`,
    };
  }, [report]);

  return (
    <FileNavigationContext.Provider value={{ requestId, activate: onFileActivate ? file => onFileActivate(file, state) : undefined }}>
    <CollapsiblePanel
      title="Change breakdown"
      availability={report === undefined ? 'unknown' : report === null ? 'unavailable' : 'available'}
      expanded={state.expanded}
      onExpandedChange={(expanded) => setState({ ...state, expanded })}
      className="auth-change-breakdown"
      bodyClassName="auth-change-breakdown__body"
      actions={report ? (
        <div className="auth-change-breakdown__totals" aria-label="Change totals">
          <span><strong>{formatCount(report.totals.files)}</strong> files</span>
          <span><strong className="auth-change-breakdown__added">+{formatCount(report.totals.additions)}</strong> added</span>
          <span><strong className="auth-change-breakdown__deleted">−{formatCount(report.totals.deletions)}</strong> deleted</span>
          {report.totals.binary_files > 0 && <span><strong>{formatCount(report.totals.binary_files)}</strong> binary</span>}
        </div>
      ) : null}
    >
      {report != null && (
        <>
          <div className="auth-change-breakdown__tabs" role="tablist" aria-label="Change breakdown view">
            {AUTH_CHANGE_BREAKDOWN_VIEWS.map((view) => (
              <button
                type="button"
                role="tab"
                aria-selected={state.view === view}
                aria-controls={viewPanelId}
                id={`${viewPanelId}-tab-${view}`}
                key={view}
                onClick={() => setState({ ...state, view })}
              >
                {VIEW_LABELS[view]}
              </button>
            ))}
          </div>
          <div className="auth-change-breakdown__view" role="tabpanel" id={viewPanelId}
            aria-labelledby={`${viewPanelId}-tab-${state.view}`}>
            {state.view === 'flags' && <p className="auth-change-breakdown__hint">
              Generated and vendor are independent flags, so each file appears once in each pair.
            </p>}
            {state.view === 'directory' && <DirectoryBreadcrumbs state={state} setState={setState} />}
            {model && report.files.length > 0 ? (
              <div className="auth-change-breakdown__table" style={columnWidths}>
                <div className="auth-change-breakdown__table-content">
                  <div className={`auth-change-columns-header${model.kind === 'files' ? ' auth-change-columns-header--files' : ''}`} aria-hidden="true">
                    <span>{model.kind === 'directory' ? 'Directory' : model.kind === 'files' ? 'File' : 'Group'}</span>
                    {model.kind !== 'files' && <span>Files</span>}
                    <span>+</span><span>−</span><span>Share</span>
                  </div>
                  {model.groups.length + model.files.length > 0
                    ? <BreakdownItems initialOffsets={restorationOffsets} requestId={requestId} model={model} state={state} setState={setState} totalLines={report.totals.additions + report.totals.deletions} />
                    : <p className="auth-change-breakdown__empty">This directory is not present in the captured report.</p>}
                </div>
              </div>
            ) : <p className="auth-change-breakdown__empty">The reviewed commits contain no file changes.</p>}
          </div>
          <p className="auth-change-breakdown__footnote">
            Language and file-role labels are rule-based classifications of the frozen reviewed files, not semantic guarantees.
          </p>
        </>
      )}
    </CollapsiblePanel>
    </FileNavigationContext.Provider>
  );
}
