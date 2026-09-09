import { useMemo } from 'preact/hooks';

import type { AuthChangeFile, AuthChangeFileRole, AuthChangeReport } from '../../../src/contracts';
import { CollapsiblePanel } from '../components/shared/CollapsiblePanel';
import { DisclosureChevronIcon } from '../components/shared/DisclosureChevronIcon';
import { usePersistedViewState } from '../hooks/usePersistedViewState';
import {
  AUTH_CHANGE_BREAKDOWN_VIEWS,
  DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE,
  authChangeBreakdownStorageKey,
  normalizeAuthChangeBreakdownViewState,
  type AuthChangeBreakdownView,
  type AuthChangeBreakdownViewState,
} from './auth-change-breakdown-state';

type ChangeGroup = {
  id: string;
  label: string;
  files: AuthChangeFile[];
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

function groupFiles(
  files: AuthChangeFile[],
  groupFor: (file: AuthChangeFile) => { id: string; label: string },
): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();
  for (const file of files) {
    const group = groupFor(file);
    const existing = groups.get(group.id);
    if (existing) existing.files.push(file);
    else groups.set(group.id, { ...group, files: [file] });
  }
  return Array.from(groups.values())
    .map((group) => ({ ...group, files: group.files.sort(compareFiles) }))
    .sort((left, right) => {
      const changedDifference = groupChangedLines(right) - groupChangedLines(left);
      return changedDifference || left.label.localeCompare(right.label);
    });
}

function groupAdditions(group: ChangeGroup): number {
  return group.files.reduce((total, file) => total + (file.additions ?? 0), 0);
}

function groupDeletions(group: ChangeGroup): number {
  return group.files.reduce((total, file) => total + (file.deletions ?? 0), 0);
}

function groupChangedLines(group: ChangeGroup): number {
  return groupAdditions(group) + groupDeletions(group);
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

function fileKindLabels(file: AuthChangeFile): string[] {
  const type = file.file_type_after === 'absent' ? file.file_type_before : file.file_type_after;
  const labels: string[] = [];
  if (file.additions === null || file.deletions === null) labels.push('binary');
  if (type === 'symlink' || type === 'gitlink') labels.push(type);
  return labels;
}

function FilePath({ file }: { file: AuthChangeFile }): JSX.Element {
  const oldPath = file.old_path;
  const newPath = file.new_path;
  if ((file.change_kind === 'renamed' || file.change_kind === 'copied')
      && oldPath && newPath && oldPath !== newPath) {
    return <><span>{oldPath}</span><span className="auth-change-file__arrow"> → </span><span>{newPath}</span></>;
  }
  return <>{displayPath(file)}</>;
}

function FileMetrics({ file, totalLines }: { file: AuthChangeFile; totalLines: number }): JSX.Element {
  const lines = changedLines(file);
  if (lines === null) {
    return (
      <span className="auth-change-file__binary-size">
        {formatBytes(file.bytes_before)} → {formatBytes(file.bytes_after)}
      </span>
    );
  }
  return (
    <>
      <span title="Additions">{formatCount(file.additions ?? 0)}</span>
      <span title="Deletions">{formatCount(file.deletions ?? 0)}</span>
      <span title="Share of changed text lines">{formatShare(lines, totalLines)}</span>
    </>
  );
}

function ChangeFileRow({ file, totalLines }: { file: AuthChangeFile; totalLines: number }): JSX.Element {
  const kinds = fileKindLabels(file);
  return (
    <li className="auth-change-file">
      <div className="auth-change-file__identity">
        <code className="auth-change-file__path"><FilePath file={file} /></code>
        <span className="auth-change-file__badges">
          <span className="auth-change-file__kind">{file.change_kind.replace('_', ' ')}</span>
          {kinds.map((kind) => <span className="auth-change-file__kind" key={kind}>{kind}</span>)}
          {file.generated && <span className="auth-change-file__kind">generated</span>}
          {file.vendor && <span className="auth-change-file__kind">vendor</span>}
        </span>
      </div>
      <div
        className={`auth-change-file__metrics${changedLines(file) === null ? ' auth-change-file__metrics--binary' : ''}`}
        aria-label={changedLines(file) === null ? 'Binary byte sizes' : 'Additions, deletions, and share'}
      >
        <FileMetrics file={file} totalLines={totalLines} />
      </div>
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

function ChangeGroupRows({
  groups,
  state,
  setState,
  totalLines,
}: {
  groups: ChangeGroup[];
  state: AuthChangeBreakdownViewState;
  setState: (next: AuthChangeBreakdownViewState) => void;
  totalLines: number;
}): JSX.Element {
  return (
    <div className="auth-change-groups">
      <div className="auth-change-groups__header" aria-hidden="true">
        <span>Group</span><span>Files</span><span>+</span><span>−</span><span>Share</span>
      </div>
      {groups.map((group) => {
        const expanded = state.expandedGroups.includes(group.id);
        const bodyId = `auth-change-group-${encodeURIComponent(group.id)}`;
        return (
          <div className="auth-change-group" key={group.id}>
            <button
              type="button"
              className="auth-change-group__row"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => toggleExpandedGroup(state, setState, group.id)}
            >
              <span className="auth-change-group__name">
                <DisclosureChevronIcon expanded={expanded} size={13} />
                <span>{group.label}</span>
              </span>
              <span>{formatCount(group.files.length)}</span>
              <span>{formatCount(groupAdditions(group))}</span>
              <span>{formatCount(groupDeletions(group))}</span>
              <span>{formatShare(groupChangedLines(group), totalLines)}</span>
            </button>
            {expanded && (
              <ul id={bodyId} className="auth-change-files">
                {group.files.map((file, index) => (
                  <ChangeFileRow key={`${displayPath(file)}:${index}`} file={file} totalLines={totalLines} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DirectoryBreakdown({
  report,
  state,
  setState,
}: {
  report: AuthChangeReport;
  state: AuthChangeBreakdownViewState;
  setState: (next: AuthChangeBreakdownViewState) => void;
}): JSX.Element {
  const totalLines = report.totals.additions + report.totals.deletions;
  const directory = state.directoryPath;
  const matching = report.files.filter((file) => {
    const parts = displayPath(file).split('/');
    return directory.every((part, index) => parts[index] === part);
  });
  const nested = new Map<string, AuthChangeFile[]>();
  const direct: AuthChangeFile[] = [];
  for (const file of matching) {
    const parts = displayPath(file).split('/');
    const next = parts[directory.length];
    if (!next || parts.length === directory.length + 1) direct.push(file);
    else nested.set(next, [...(nested.get(next) ?? []), file]);
  }
  const groups = Array.from(nested, ([name, files]) => ({
    id: `directory:${[...directory, name].join('/')}`,
    label: name,
    files: files.sort(compareFiles),
  })).sort((left, right) => left.label.localeCompare(right.label));

  return (
    <div className="auth-change-directory">
      <nav className="auth-change-directory__breadcrumbs" aria-label="Change report directory">
        <button type="button" onClick={() => setState({ ...state, directoryPath: [] })}>root</button>
        {directory.map((part, index) => (
          <span key={`${part}:${index}`}>
            <span aria-hidden="true">/</span>
            <button
              type="button"
              onClick={() => setState({ ...state, directoryPath: directory.slice(0, index + 1) })}
            >
              {part}
            </button>
          </span>
        ))}
      </nav>
      {groups.length > 0 && (
        <div className="auth-change-directory__groups">
          {groups.map((group) => (
            <button
              type="button"
              className="auth-change-directory__entry"
              key={group.id}
              onClick={() => setState({
                ...state,
                directoryPath: [...directory, group.label],
              })}
            >
              <span className="auth-change-directory__name">{group.label}/</span>
              <span>{formatCount(group.files.length)} files</span>
              <span>{formatShare(groupChangedLines(group), totalLines)}</span>
            </button>
          ))}
        </div>
      )}
      {direct.length > 0 && (
        <ul className="auth-change-files auth-change-files--direct">
          {direct.sort(compareFiles).map((file, index) => (
            <ChangeFileRow key={`${displayPath(file)}:${index}`} file={file} totalLines={totalLines} />
          ))}
        </ul>
      )}
      {groups.length === 0 && direct.length === 0 && (
        <p className="auth-change-breakdown__empty">This directory is not present in the captured report.</p>
      )}
    </div>
  );
}

function BreakdownContent({
  report,
  state,
  setState,
}: {
  report: AuthChangeReport;
  state: AuthChangeBreakdownViewState;
  setState: (next: AuthChangeBreakdownViewState) => void;
}): JSX.Element {
  const totalLines = report.totals.additions + report.totals.deletions;
  const groups = useMemo(() => {
    switch (state.view) {
      case 'language':
        return groupFiles(report.files, (file) => ({ id: `language:${file.language}`, label: file.language }));
      case 'role':
        return groupFiles(report.files, (file) => ({ id: `role:${file.file_role}`, label: ROLE_LABELS[file.file_role] }));
      case 'flags':
        return [
          { id: 'flag:generated', label: 'Generated', files: report.files.filter((file) => file.generated) },
          { id: 'flag:not-generated', label: 'Not generated', files: report.files.filter((file) => !file.generated) },
          { id: 'flag:vendor', label: 'Vendor', files: report.files.filter((file) => file.vendor) },
          { id: 'flag:not-vendor', label: 'Not vendor', files: report.files.filter((file) => !file.vendor) },
        ].filter((group) => group.files.length > 0).map((group) => ({
          ...group,
          files: group.files.sort(compareFiles),
        }));
      default:
        return [];
    }
  }, [report.files, state.view]);

  if (report.files.length === 0) {
    return <p className="auth-change-breakdown__empty">The reviewed commits contain no file changes.</p>;
  }
  if (state.view === 'directory') {
    return <DirectoryBreakdown report={report} state={state} setState={setState} />;
  }
  if (state.view === 'largest') {
    return (
      <div className="auth-change-largest">
        <div className="auth-change-largest__header" aria-hidden="true">
          <span>File</span><span>+</span><span>−</span><span>Share</span>
        </div>
        <ul className="auth-change-files auth-change-files--largest">
          {[...report.files].sort(compareFiles).map((file, index) => (
            <ChangeFileRow key={`${displayPath(file)}:${index}`} file={file} totalLines={totalLines} />
          ))}
        </ul>
      </div>
    );
  }
  return <ChangeGroupRows groups={groups} state={state} setState={setState} totalLines={totalLines} />;
}

export function AuthChangeBreakdown({
  requestId,
  report,
}: {
  requestId: string;
  report: AuthChangeReport | null;
}): JSX.Element {
  const [state, setState] = usePersistedViewState(
    authChangeBreakdownStorageKey(requestId),
    normalizeAuthChangeBreakdownViewState,
    DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE,
  );
  const summary = report
    ? `${formatCount(report.totals.files)} files · +${formatCount(report.totals.additions)} −${formatCount(report.totals.deletions)}`
    : 'Unavailable';
  const viewPanelId = `auth-change-breakdown-panel-${encodeURIComponent(requestId)}`;

  return (
    <CollapsiblePanel
      title="Change breakdown"
      expanded={state.expanded}
      onExpandedChange={(expanded) => setState({ ...state, expanded })}
      className="auth-change-breakdown"
      bodyClassName="auth-change-breakdown__body"
      actions={<span className="auth-change-breakdown__summary">{summary}</span>}
    >
      {report === null ? (
        <p className="auth-change-breakdown__unavailable">
          No captured breakdown is available for this request. Older requests are not recomputed from moving branches.
        </p>
      ) : (
        <>
          <div className="auth-change-breakdown__totals" aria-label="Change totals">
            <span><strong>{formatCount(report.totals.files)}</strong> files</span>
            <span><strong className="auth-change-breakdown__added">+{formatCount(report.totals.additions)}</strong> added</span>
            <span><strong className="auth-change-breakdown__deleted">−{formatCount(report.totals.deletions)}</strong> deleted</span>
            {report.totals.binary_files > 0 && (
              <span><strong>{formatCount(report.totals.binary_files)}</strong> binary</span>
            )}
          </div>
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
          <div
            className="auth-change-breakdown__view"
            role="tabpanel"
            id={viewPanelId}
            aria-labelledby={`${viewPanelId}-tab-${state.view}`}
          >
            {state.view === 'flags' && (
              <p className="auth-change-breakdown__hint">
                Generated and vendor are independent flags, so each file appears once in each pair.
              </p>
            )}
            <BreakdownContent report={report} state={state} setState={setState} />
          </div>
          <p className="auth-change-breakdown__footnote">
            Language and file-role labels are rule-based classifications of the frozen reviewed files, not semantic guarantees.
          </p>
        </>
      )}
    </CollapsiblePanel>
  );
}
