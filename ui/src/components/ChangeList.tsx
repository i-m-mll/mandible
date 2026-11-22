import { lazy, Suspense } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DiffFilePair, GitChangeFile } from '../../../src/contracts';
import { diffFileKey, type DiffFileIdentity } from './diff-file-identity';
import { CollapsiblePanel } from './shared/CollapsiblePanel';
import { Icon } from './icons/Icon';
import { usePersistedViewState } from '../hooks/usePersistedViewState';
import type { DiffLineRange, DiffMode, PierreDiffInput } from './PierreFileDiff';
import './ChangeList.css';

const PierreDiff = lazy(() => import('./PierreFileDiff').then(({ PierreFileDiff }) => ({ default: PierreFileDiff })));
const ParsedList = lazy(() => import('./ParsedChangeList').then(({ ParsedChangeList }) => ({ default: ParsedChangeList })));
const MarkdownDiff = lazy(() => import('./MarkdownDocument').then(({ MarkdownDocument }) => ({ default: MarkdownDocument })));

export type DiffTargetReady = { kind: 'file'; element: HTMLElement } | { kind: 'unavailable' };
export type ChangeListFile = Omit<GitChangeFile, 'additions' | 'deletions'> & {
  additions?: number | null;
  deletions?: number | null;
  patch?: Extract<PierreDiffInput, { kind: 'patch' }>['file'];
};
export type ChangeListTarget = DiffFileIdentity & { navigationToken: string };

export type ChangeListProps = {
  files?: readonly ChangeListFile[];
  patch?: string;
  contents?: Extract<DiffFilePair, { kind: 'text' }>;
  scope: string;
  revision?: string;
  ariaLabel: string;
  emptyLabel?: string;
  loadFile?: (file: ChangeListFile, index: number, signal: AbortSignal) => Promise<DiffFilePair>;
  target?: ChangeListTarget;
  contentReady?: boolean;
  onTargetReady?: (token: string, result: DiffTargetReady) => void;
  onLineSelection?: (file: ChangeListFile, range: DiffLineRange | null) => void;
  renderTextFile?: (file: ChangeListFile, pair: Extract<DiffFilePair, { kind: 'text' }>) => ComponentChild;
};

type ViewState = {
  mode: DiffMode;
  wrap: boolean;
  wholeFile: boolean;
  expanded: Record<string, boolean>;
  viewed: Record<string, string>;
};

const defaultView: ViewState = { mode: 'split', wrap: true, wholeFile: false, expanded: {}, viewed: {} };
const emptyFiles: readonly ChangeListFile[] = [];
const labels = { added: 'New', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied', type_changed: 'Type changed' };

function viewState(value: unknown): ViewState {
  const state = value && typeof value === 'object' ? value as Partial<ViewState> : {};
  const entries = (field: unknown, type: string) => field && typeof field === 'object'
    ? Object.fromEntries(Object.entries(field).filter(([, value]) => typeof value === type))
    : {};
  return {
    mode: state.mode === 'unified' ? 'unified' : 'split',
    wrap: state.wrap !== false,
    wholeFile: state.wholeFile === true,
    expanded: entries(state.expanded, 'boolean'),
    viewed: entries(state.viewed, 'string'),
  };
}

function viewKey(file: ChangeListFile, index: number): string {
  const path = file.new_path ?? file.old_path;
  return JSON.stringify(file.patch ? [path, index] : [path]);
}

function versionKey(file: ChangeListFile, revision?: string): string {
  return JSON.stringify(file.old_object === undefined || file.new_object === undefined
    ? [revision, file.patch?.prevObjectId, file.patch?.newObjectId, file.patch?.cacheKey]
    : [file.old_path, file.new_path, file.old_object, file.new_object]);
}

function ChangeBody({ name, inputKey, load, mode, wrap, wholeFile, onLineSelection, renderTextFile, knownWhitespace }: {
  name: string;
  inputKey: string;
  load: (signal: AbortSignal) => Promise<DiffFilePair | PierreDiffInput>;
  mode: DiffMode;
  wrap: boolean;
  wholeFile: boolean;
  onLineSelection?: (range: DiffLineRange | null) => void;
  renderTextFile?: (pair: Extract<DiffFilePair, { kind: 'text' }>) => ComponentChild;
  knownWhitespace?: boolean;
}) {
  const [result, setResult] = useState<DiffFilePair | PierreDiffInput | null>(null);
  const [failed, setFailed] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const controller = new AbortController();
    loadRef.current(controller.signal).then(value => {
      if (!controller.signal.aborted) setResult(value);
    }, () => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [inputKey]);

  const input = useMemo(() => result?.kind === 'text' ? { ...result, kind: 'contents' as const } : result, [result]);
  if (failed) return <div role="alert">File changes unavailable</div>;
  if (!input) return null;
  if (input.kind === 'binary') return <span class="change-list__badge">Binary</span>;
  const custom = result?.kind === 'text' ? renderTextFile?.(result) : null;
  if (custom != null) return <>{custom}</>;
  const whitespaceOnly = knownWhitespace === undefined && input.kind === 'contents' && input.before.contents !== input.after.contents
    && input.before.contents.replace(/\s/g, '') === input.after.contents.replace(/\s/g, '');
  return <>
    {whitespaceOnly && <span class="change-list__badge">Whitespace only</span>}
    <Suspense fallback={null}>
      {input.kind === 'contents' && /\.(?:md|markdown)$/i.test(name) ? (
        <MarkdownDiff value={input.after.contents} comparison={input.before.contents}
          comparisonLayout={wholeFile ? 'full-document' : undefined} readOnly ariaLabel={name} />
      ) : (
        <PierreDiff input={input} mode={mode} wrap={wrap} wholeFile={wholeFile}
          ariaLabel={name} onLineSelection={onLineSelection} />
      )}
    </Suspense>
  </>;
}

export function ChangeList(props: ChangeListProps) {
  if (props.patch || props.contents) return <Suspense fallback={null}><ParsedList {...props} /></Suspense>;
  return <ChangeInventoryList {...props} />;
}

export function ChangeInventoryList({
  files = emptyFiles, scope, revision, ariaLabel, emptyLabel = 'No changes', loadFile, target, contentReady = true, onTargetReady, onLineSelection, renderTextFile,
}: ChangeListProps) {
  const [view, setView] = usePersistedViewState(`mandible:changes:${scope}`, viewState, defaultView);
  const headings = useRef(new Map<string, HTMLElement>());
  const handled = useRef<{ token: string; kind: DiffTargetReady['kind'] }>();
  const targetKey = target ? diffFileKey(target) : undefined;
  const targetIndex = targetKey ? files.findIndex(file => diffFileKey({ oldPath: file.old_path, newPath: file.new_path }) === targetKey) : -1;

  useLayoutEffect(() => {
    if (!target || !contentReady) return;
    const kind = targetIndex < 0 ? 'unavailable' : 'file';
    if (handled.current?.token === target.navigationToken && handled.current.kind === kind) return;
    if (targetIndex < 0) {
      handled.current = { token: target.navigationToken, kind };
      onTargetReady?.(target.navigationToken, { kind: 'unavailable' });
      return;
    }
    const key = viewKey(files[targetIndex]!, targetIndex);
    const element = headings.current.get(key);
    if (!element) return;
    setView(current => ({ ...current, expanded: { ...current.expanded, [key]: true } }));
    handled.current = { token: target.navigationToken, kind };
    onTargetReady?.(target.navigationToken, { kind: 'file', element: element.closest('button') ?? element });
  }, [files, target, targetIndex, contentReady, onTargetReady]);

  const large = useMemo(() => files.length > 12 || files.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0) > 600, [files]);
  const partial = files.some(file => file.patch?.isPartial);
  return (
    <section class="change-list" aria-label={ariaLabel} data-diff-mode={view.mode}>
      {files.length > 0 && <div class="change-list__toolbar">
        <div role="group" aria-label="Diff layout">
          {(['unified', 'split'] as const).map(mode => <button key={mode} type="button" aria-pressed={view.mode === mode}
            onClick={() => setView(current => ({ ...current, mode }))}>{mode === 'unified' ? 'Unified' : 'Split'}</button>)}
        </div>
        {!partial && <button type="button" aria-pressed={view.wholeFile}
          onClick={() => setView(current => ({ ...current, wholeFile: !current.wholeFile }))}>Whole file</button>}
        <button type="button" aria-pressed={view.wrap}
          onClick={() => setView(current => ({ ...current, wrap: !current.wrap }))}>Wrap</button>
      </div>}
      {files.map((file, index) => {
        const name = file.new_path ?? file.old_path ?? 'Changes';
        const key = viewKey(file, index);
        const fileRevision = versionKey(file, revision);
        const viewed = view.viewed[key];
        const binary = file.additions === null || file.deletions === null;
        const status = file.change_kind === 'modified' ? null : labels[file.change_kind];
        const targeted = index === targetIndex && (target?.navigationToken !== handled.current?.token || handled.current?.kind !== 'file');
        const expanded = targeted || (view.expanded[key] ?? (!large && index === 0));
        return <CollapsiblePanel key={key} className="change-list__file"
          toggleClassName="change-list__file-toggle"
          expanded={expanded}
          onExpandedChange={next => setView(current => ({
            ...current, expanded: { ...current.expanded, [key]: next },
          }))}
          title={<span class="change-list__path" title={name}
            ref={node => { if (node) headings.current.set(key, node); else headings.current.delete(key); }}>
            {file.old_path && file.new_path && file.old_path !== file.new_path ? `${file.old_path} → ${file.new_path}` : name}
          </span>}
          actions={<>
            {status && <span class="change-list__badge">{status}</span>}
            {file.whitespace_only && <span class="change-list__badge">Whitespace only</span>}
            {binary ? <span class="change-list__badge">Binary</span> : file.additions !== undefined && file.deletions !== undefined && <>
              <span class="change-list__add">+{file.additions}</span>
              <span class="change-list__del">−{file.deletions}</span>
            </>}
            {viewed !== undefined && viewed !== fileRevision && <span class="change-list__badge">Changed since viewed</span>}
            <button type="button" class="change-list__viewed" title={`Viewed ${name}`}
              aria-label={`Viewed ${name}`} aria-pressed={viewed === fileRevision}
              onClick={() => setView(current => {
                const viewed = { ...current.viewed };
                if (viewed[key] === fileRevision) delete viewed[key];
                else viewed[key] = fileRevision;
                return { ...current, viewed };
              })}>
              <Icon name="menuSelected" size={14} />
            </button>
          </>}
        >
          {!binary && <ChangeBody key={fileRevision} inputKey={fileRevision} name={name} mode={view.mode}
            wrap={view.wrap} wholeFile={view.wholeFile}
            knownWhitespace={file.whitespace_only}
            renderTextFile={renderTextFile ? pair => renderTextFile(file, pair) : undefined}
            load={signal => file.patch
              ? Promise.resolve({ kind: 'patch', file: file.patch })
              : loadFile!(file, index, signal)}
            onLineSelection={onLineSelection ? range => onLineSelection(file, range) : undefined} />}
        </CollapsiblePanel>;
      })}
      {!files.length && contentReady && <div class="change-list__empty">{emptyLabel}</div>}
    </section>
  );
}
