import { lazy, Suspense } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DiffFilePair, GitChangeFile } from '../../../src/contracts';
import { quoteReviewLines } from '../../../src/feedback/review-ranges';
import { isMarkdownFile } from '../../../src/presentation/markdown-file';
import { diffFileKey, type DiffFileIdentity } from './diff-file-identity';
import { appTip } from './shared/AppHoverTips';
import { DetailPaneNotice } from './shared/DetailPaneNotice';
import { CollapsiblePanel, type CollapsiblePanelProps } from './shared/CollapsiblePanel';
import { SidebarItemRow } from './shared/SidebarItemRow';
import { ContextualAction } from './shared/ContextualAction';
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

export function ChangeFileDisclosure({ file, titleRef, ...panel }: Pick<CollapsiblePanelProps, 'children' | 'expanded' | 'onExpandedChange' | 'actions'> & {
  file: Pick<ChangeListFile, 'old_path' | 'new_path'>;
  titleRef?: (node: HTMLSpanElement | null) => void;
}) {
  const name = file.new_path ?? file.old_path ?? 'Changes';
  return <CollapsiblePanel {...panel} className="change-list__file" toggleClassName="change-list__file-toggle"
    title={<span class="change-list__path" {...appTip(name)} ref={titleRef}>
      {file.old_path && file.new_path && file.old_path !== file.new_path ? `${file.old_path} → ${file.new_path}` : name}
    </span>} />;
}

export type ChangeTextFileView = {
  wholeFile: boolean;
  mode: DiffMode;
  wrap: boolean;
  defaultContent: ComponentChild;
};

export type ChangeListFilePicker = {
  compactOpen: boolean;
  onSelect: (index: number) => void;
};

export type ChangeListProps = {
  files?: readonly ChangeListFile[];
  patch?: string;
  contents?: Extract<DiffFilePair, { kind: 'text' }>;
  scope: string;
  revision?: string;
  ariaLabel: string;
  emptyLabel?: string;
  hideToolbar?: boolean;
  filePicker?: ChangeListFilePicker;
  loadFile?: (file: ChangeListFile, index: number, signal: AbortSignal) => Promise<DiffFilePair>;
  target?: ChangeListTarget;
  contentReady?: boolean;
  onTargetReady?: (token: string, result: DiffTargetReady) => void;
  onLineSelection?: (file: ChangeListFile, index: number, range: DiffLineRange | null, quote?: string) => void;
  lineTarget?: DiffLineRange & { token: string };
  renderFileStatus?: (file: ChangeListFile) => ComponentChild;
  renderTextFile?: (file: ChangeListFile, pair: Extract<DiffFilePair, { kind: 'text' }>, index: number, view: ChangeTextFileView) => ComponentChild;
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

function ChangeBody({ name, markdown, inputKey, load, mode, wrap, wholeFile, onLineSelection, lineTarget, renderTextFile, knownWhitespace }: {
  name: string;
  markdown: boolean;
  inputKey: string;
  load: (signal: AbortSignal) => Promise<DiffFilePair | PierreDiffInput>;
  mode: DiffMode;
  wrap: boolean;
  wholeFile: boolean;
  onLineSelection?: (range: DiffLineRange | null, quote?: string) => void;
  lineTarget?: DiffLineRange & { token: string };
  renderTextFile?: (pair: Extract<DiffFilePair, { kind: 'text' }>, view: ChangeTextFileView) => ComponentChild;
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
  if (failed) return <DetailPaneNotice severity="error" density="compact">File changes unavailable</DetailPaneNotice>;
  if (!input) return null;
  if (input.kind === 'binary') return <span class="change-list__badge">Binary</span>;
  const whitespaceOnly = knownWhitespace === undefined && input.kind === 'contents' && input.before.contents !== input.after.contents
    && input.before.contents.replace(/\s/g, '') === input.after.contents.replace(/\s/g, '');
  const defaultContent = <>
    {whitespaceOnly && <span class="change-list__badge">Whitespace only</span>}
    <Suspense fallback={null}>
      {input.kind === 'contents' && markdown ? (
        <MarkdownDiff value={input.after.contents} comparison={input.before.contents}
          comparisonLayout={wholeFile ? 'full-document' : undefined} readOnly ariaLabel={name} />
      ) : (
        <PierreDiff input={input} mode={mode} wrap={wrap} wholeFile={wholeFile}
          ariaLabel={name} lineTarget={lineTarget} onLineSelection={onLineSelection ? range => {
            const text = input.kind === 'contents' && range
              ? (range.side === 'before' ? input.before.contents : input.after.contents) : undefined;
            onLineSelection(range, text !== undefined && range ? quoteReviewLines(text, range.startLine - 1, range.endLine) : undefined);
          } : undefined} />
      )}
    </Suspense>
  </>;
  return <>{result?.kind === 'text' ? renderTextFile?.(result, { wholeFile, mode, wrap, defaultContent }) ?? defaultContent : defaultContent}</>;
}

export function ChangeList(props: ChangeListProps) {
  if (props.patch || props.contents) return <Suspense fallback={null}><ParsedList {...props} /></Suspense>;
  return <ChangeInventoryList {...props} />;
}

export function ChangeInventoryList({
  files = emptyFiles, scope, revision, ariaLabel, emptyLabel = 'No changes', loadFile, target, contentReady = true, onTargetReady, onLineSelection, lineTarget, renderTextFile, renderFileStatus, hideToolbar, filePicker,
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
  const selectedIndex = targetIndex < 0 ? Math.max(0, files.findIndex(file => file.operator_edited)) : targetIndex;
  const toggleViewed = (key: string, fileRevision: string) => setView(current => {
    const viewed = { ...current.viewed };
    if (viewed[key] === fileRevision) delete viewed[key];
    else viewed[key] = fileRevision;
    return { ...current, viewed };
  });
  const counts = (file: ChangeListFile) => file.additions == null || file.deletions == null ? null : <>
    <span class="change-list__add">+{file.additions}</span>
    <span class="change-list__del">−{file.deletions}</span>
  </>;
  const changes = (
    <section class="change-list" aria-label={ariaLabel} data-diff-mode={view.mode}>
      {!hideToolbar && files.length > 0 && <div class="change-list__toolbar">
        <div role="group" aria-label="Diff layout">
          {(['unified', 'split'] as const).map(mode => {
            const label = mode === 'unified' ? 'Unified' : 'Split';
            return <button key={mode} type="button" aria-pressed={view.mode === mode} aria-label={label}
              {...appTip(label)} onClick={() => setView(current => ({ ...current, mode }))}>
              <Icon name={mode === 'unified' ? 'diffUnified' : 'diffSplit'} />
            </button>;
          })}
        </div>
        {!partial && <button type="button" aria-pressed={view.wholeFile} aria-label="Whole file" {...appTip('Whole file')}
          onClick={() => setView(current => ({ ...current, wholeFile: !current.wholeFile }))}><Icon name="openMarkdown" /></button>}
        <button type="button" aria-pressed={view.wrap} aria-label="Wrap" {...appTip('Wrap')}
          onClick={() => setView(current => ({ ...current, wrap: !current.wrap }))}><Icon name="wrapLines" /></button>
      </div>}
      {files.map((file, index) => {
        if (filePicker && index !== selectedIndex) return null;
        const name = file.new_path ?? file.old_path ?? 'Changes';
        const key = viewKey(file, index);
        const fileRevision = versionKey(file, revision);
        const viewed = view.viewed[key];
        const binary = file.additions === null || file.deletions === null;
        const gitlink = file.old_object?.mode === '160000' || file.new_object?.mode === '160000';
        const modeChanged = Boolean(file.old_object && file.new_object && file.old_object.mode !== file.new_object.mode);
        const modeOnly = modeChanged && file.old_object?.oid === file.new_object?.oid;
        const status = file.change_kind === 'modified' ? null : labels[file.change_kind];
        const targeted = index === targetIndex && (target?.navigationToken !== handled.current?.token || handled.current?.kind !== 'file');
        const expanded = targeted || (view.expanded[key] ?? (!large && index === 0));
        return <ChangeFileDisclosure key={key} file={file}
          expanded={expanded}
          onExpandedChange={next => setView(current => ({
            ...current, expanded: { ...current.expanded, [key]: next },
          }))}
          titleRef={node => { if (node) headings.current.set(key, node); else headings.current.delete(key); }}
          actions={<>
            {!filePicker && renderFileStatus?.(file)}
            {!hideToolbar && status && <span class="change-list__badge">{status}</span>}
            {!hideToolbar && file.whitespace_only && <span class="change-list__badge">Whitespace only</span>}
            {modeChanged && <span class="change-list__badge">Mode {file.old_object!.mode} → {file.new_object!.mode}</span>}
            {gitlink ? <span class="change-list__badge">Gitlink</span>
              : binary ? <span class="change-list__badge">Binary</span>
              : !modeOnly && !filePicker && !hideToolbar && counts(file)}
            {!hideToolbar && viewed !== undefined && viewed !== fileRevision && <span class="change-list__badge">Changed since viewed</span>}
            {!filePicker && !hideToolbar && <button type="button" class="change-list__viewed" {...appTip("Mark viewed")}
              aria-label={`Viewed ${name}`} aria-pressed={viewed === fileRevision}
              onClick={() => toggleViewed(key, fileRevision)}>
              <Icon name="menuSelected" size={14} />
            </button>}
          </>}
        >
          {gitlink && <p aria-label="Gitlink revisions">
            {file.old_object?.mode === '160000' && <code>{file.old_object.oid}</code>}
            {file.old_object?.mode === '160000' && file.new_object?.mode === '160000' && ' → '}
            {file.new_object?.mode === '160000' && <code>{file.new_object.oid}</code>}
          </p>}
          {!gitlink && !modeOnly && !binary && <ChangeBody key={fileRevision} inputKey={fileRevision} name={name} mode={view.mode}
            markdown={file.review_format ? file.review_format === 'markdown' : isMarkdownFile(name)}
            wrap={view.wrap} wholeFile={view.wholeFile}
            knownWhitespace={file.whitespace_only}
            renderTextFile={renderTextFile ? (pair, presentation) => renderTextFile(file, pair, index, presentation) : undefined}
            load={signal => file.patch
              ? Promise.resolve({ kind: 'patch', file: file.patch })
              : loadFile!(file, index, signal)}
            lineTarget={index === targetIndex ? lineTarget : undefined}
            onLineSelection={onLineSelection ? (range, quote) => onLineSelection(file, index, range, quote) : undefined} />}
        </ChangeFileDisclosure>;
      })}
      {!files.length && contentReady && <div class="change-list__empty">{emptyLabel}</div>}
    </section>
  );
  if (!filePicker || !files.length) return changes;
  return <div class={`change-list-layout${filePicker.compactOpen ? ' change-list-layout--open' : ''}`}>
    <nav class="change-list-layout__files" aria-label="Changed files">
      {files.map((file, index) => {
        const key = viewKey(file, index);
        const fileRevision = versionKey(file, revision);
        const name = file.new_path ?? file.old_path ?? 'Changes';
        const viewed = view.viewed[key] === fileRevision;
        return <SidebarItemRow key={key} label={name} selectionLabel={name} selected={index === selectedIndex}
          className="sidebar-item-row--fixed-badges"
          ariaCurrent={index === selectedIndex ? 'true' : undefined} onSelect={() => filePicker.onSelect(index)}
          badges={<>{renderFileStatus?.(file)}{counts(file)}</>}
          actions={<ContextualAction aria-label={`Viewed ${name}`} {...appTip('Mark viewed')}
            aria-pressed={viewed} onClick={() => toggleViewed(key, fileRevision)}>
            <Icon name="menuSelected" />
          </ContextualAction>} />;
      })}
    </nav>
    {changes}
  </div>;
}
