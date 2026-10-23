import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html as diff2htmlHtml, parse as diff2htmlParse } from 'diff2html';
import { diffFileKey, parseDiffFileIdentity, type DiffFileIdentity } from './diff-file-identity';
import { CollapsiblePanel } from './shared/CollapsiblePanel';

export type DiffViewMode = 'split' | 'unified';
export type DiffTargetReady =
  | { kind: 'file'; element: HTMLElement }
  | { kind: 'unavailable'; element: HTMLElement };

type Diff2HtmlOutputFormat = 'side-by-side' | 'line-by-line';

export type UnifiedDiffSection = DiffFileIdentity & {
  filename: string;
  hunks: string;
  raw: string;
};

export type DiffViewClassNames = {
  root?: string;
  toolbar?: string;
  modeGroup?: string;
  modeButton?: string;
  modeButtonActive?: string;
  empty?: string;
  file?: string;
  fileHeader?: string;
  filePath?: string;
  fileBody?: string;
  fileHtml?: string;
  fileFallback?: string;
};

export type DiffViewProps = {
  diffText: string;
  ariaLabel?: string;
  emptyMessage?: ComponentChildren;
  className?: string;
  classNames?: DiffViewClassNames;
  initialMode?: DiffViewMode;
  mode?: DiffViewMode;
  onModeChange?: (mode: DiffViewMode) => void;
  target?: DiffFileIdentity & { navigationToken: string };
  contentReady?: boolean;
  onTargetReady?: (token: string, result: DiffTargetReady) => void;
};

function cx(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(' ');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeDiffHtml(html: string): string {
  let out = html.replace(
    /<(script|iframe|object|embed|form|style|svg|math)[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  out = out.replace(/<(script|iframe|object|embed|form|style|svg|math)[^>]*\/>/gi, '');
  out = out.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  out = out.replace(/\s+(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, '');
  return out;
}

/** Parse raw unified diff text into file sections for collapsible rendering. */
export function parseUnifiedDiffSections(raw: string): UnifiedDiffSection[] {
  const sections: UnifiedDiffSection[] = [];
  const parts = raw.split(/^(?=diff --git )/m);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const identity = parseDiffFileIdentity(trimmed) ?? { oldPath: null, newPath: null };
    const filename = identity.newPath ?? identity.oldPath ?? 'Changes';
    const lines = trimmed.split('\n').filter((line) => {
      if (line.startsWith('diff --git ')) return false;
      if (line.startsWith('index ')) return false;
      if (line.startsWith('--- ')) return false;
      if (line.startsWith('+++ ')) return false;
      if (line.startsWith('new file mode')) return false;
      if (line.startsWith('deleted file mode')) return false;
      if (line.startsWith('old mode')) return false;
      if (line.startsWith('new mode')) return false;
      if (line.startsWith('similarity index')) return false;
      if (line.startsWith('rename from')) return false;
      if (line.startsWith('rename to')) return false;
      return true;
    });
    sections.push({ ...identity, filename, hunks: lines.join('\n'), raw: trimmed });
  }
  return sections;
}

/** Plain <pre> fallback used when diff2html cannot render a diff section. */
export function renderUnifiedDiffFallbackHtml(raw: string): string {
  const lines = raw.split('\n');
  const escaped = lines.map((line) => {
    const esc = escapeHtml(line);
    if (line.startsWith('@@')) {
      return `<span class="diff-hunk">${esc}</span>`;
    }
    if (line.startsWith('+')) {
      return `<span class="diff-add">${esc}</span>`;
    }
    if (line.startsWith('-')) {
      return `<span class="diff-del">${esc}</span>`;
    }
    return esc;
  });
  return `<pre class="diff-content">${escaped.join('\n')}</pre>`;
}

function getDiffOutputFormat(mode: DiffViewMode): Diff2HtmlOutputFormat {
  return mode === 'split' ? 'side-by-side' : 'line-by-line';
}

function renderDiff2Html(raw: string, mode: DiffViewMode): string | null {
  if (!raw.trim()) return null;
  try {
    const files = diff2htmlParse(raw);
    if (files.length === 0) return null;
    const html = diff2htmlHtml(files, {
      outputFormat: getDiffOutputFormat(mode),
      drawFileList: false,
      matching: 'lines',
    });
    return sanitizeDiffHtml(html);
  } catch {
    return null;
  }
}

export function DiffView({
  diffText,
  ariaLabel = 'Diff',
  emptyMessage = 'No diff available.',
  className,
  classNames,
  initialMode = 'split',
  mode,
  onModeChange,
  target,
  contentReady = true,
  onTargetReady,
}: DiffViewProps): JSX.Element {
  const sections = useMemo(() => parseUnifiedDiffSections(diffText), [diffText]);
  const [internalMode, setInternalMode] = useState<DiffViewMode>(initialMode);
  const [closedFiles, setClosedFiles] = useState<Set<string>>(() => new Set());
  const headings = useRef(new Map<string, HTMLElement>());
  const unavailableNotice = useRef<HTMLDivElement>(null);
  const handledTarget = useRef<string | null>(null);
  const targetKey = target ? diffFileKey(target) : null;
  const activeMode = mode ?? internalMode;
  const renderedSections = useMemo(
    () => sections.map((section) => renderDiff2Html(section.raw, activeMode)),
    [sections, activeMode],
  );

  useLayoutEffect(() => {
    if (!target || !contentReady || handledTarget.current === target.navigationToken) return;
    if (!sections.some(section => diffFileKey(section) === targetKey)) {
      if (!unavailableNotice.current) return;
      handledTarget.current = target.navigationToken;
      onTargetReady?.(target.navigationToken, { kind: 'unavailable', element: unavailableNotice.current });
      return;
    }
    if (closedFiles.has(targetKey!)) {
      setClosedFiles(previous => {
        const next = new Set(previous);
        next.delete(targetKey!);
        return next;
      });
      return;
    }
    const heading = headings.current.get(targetKey!);
    if (!heading) return;
    handledTarget.current = target.navigationToken;
    onTargetReady?.(target.navigationToken, { kind: 'file', element: heading.closest('button') ?? heading });
  }, [target?.navigationToken, targetKey, contentReady, sections, closedFiles]);

  const setMode = (nextMode: DiffViewMode) => {
    if (mode === undefined) {
      setInternalMode(nextMode);
    }
    onModeChange?.(nextMode);
  };

  const toggleFile = (key: string) => {
    setClosedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section
      className={cx('diff-viewer', classNames?.root, className)}
      aria-label={ariaLabel}
      data-diff-mode={activeMode}
    >
      {target && contentReady && !sections.some(section => diffFileKey(section) === targetKey) && (
        <div ref={unavailableNotice} className="diff-viewer__empty" role="status">The selected file is unavailable in this request’s captured diff.</div>
      )}
      {sections.length > 0 ? (
        <>
          <div className={cx('diff-viewer__toolbar', classNames?.toolbar)}>
            <div
              className={cx('diff-viewer__mode', classNames?.modeGroup)}
              role="group"
              aria-label="Diff layout"
            >
              <button
                type="button"
                className={cx(
                  'diff-viewer__mode-button',
                  classNames?.modeButton,
                  activeMode === 'unified' && 'diff-viewer__mode-button--active',
                  activeMode === 'unified' && classNames?.modeButtonActive,
                )}
                aria-pressed={activeMode === 'unified'}
                onClick={() => setMode('unified')}
              >
                Unified
              </button>
              <button
                type="button"
                className={cx(
                  'diff-viewer__mode-button',
                  classNames?.modeButton,
                  activeMode === 'split' && 'diff-viewer__mode-button--active',
                  activeMode === 'split' && classNames?.modeButtonActive,
                )}
                aria-pressed={activeMode === 'split'}
                onClick={() => setMode('split')}
              >
                Split
              </button>
            </div>
          </div>
          {sections.map((section, index) => {
            const key = diffFileKey(section);
            const expanded = !closedFiles.has(key);
            const diffHtml = renderedSections[index];
            return (
              <CollapsiblePanel
                key={key}
                className={cx('diff-viewer__file', classNames?.file)}
                toggleClassName={cx('diff-viewer__file-header', classNames?.fileHeader)}
                bodyClassName={cx('diff-viewer__file-body', classNames?.fileBody)}
                title={(
                  <span
                    ref={node => { if (node) headings.current.set(key, node); else headings.current.delete(key); }}
                    className={cx('diff-viewer__file-path', classNames?.filePath)}
                    title={section.filename}
                  >
                    {section.filename}
                  </span>
                )}
                expanded={expanded}
                onExpandedChange={() => toggleFile(key)}
              >
                {diffHtml ? (
                  <div
                    className={cx('diff-viewer__file-html', classNames?.fileHtml)}
                    dangerouslySetInnerHTML={{ __html: diffHtml }}
                  />
                ) : (
                  <div
                    className={cx('diff-viewer__file-fallback', classNames?.fileFallback)}
                    dangerouslySetInnerHTML={{
                      __html: renderUnifiedDiffFallbackHtml(section.hunks),
                    }}
                  />
                )}
              </CollapsiblePanel>
            );
          })}
        </>
      ) : (
        <div className={cx('diff-viewer__empty', classNames?.empty)}>
          {emptyMessage}
        </div>
      )}
    </section>
  );
}
