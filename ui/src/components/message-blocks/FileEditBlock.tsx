import { useMemo, useState } from 'preact/hooks';

export type DiffLineKind = 'context' | 'add' | 'remove';

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type StructuredDiff = {
  filePath: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

export type FileEditBlockProps = {
  filePath: string;
  oldString: string;
  newString: string;
  compactLineLimit?: number;
};

type DiffOp = {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
};

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return text.split('\n');
}

function buildDiffOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const lcs = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      lcs[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? lcs[oldIndex + 1][newIndex + 1] + 1
        : Math.max(lcs[oldIndex + 1][newIndex], lcs[oldIndex][newIndex + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let oldLine = 1;
  let newLine = 1;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      ops.push({ kind: 'context', text: oldLines[oldIndex], oldLine, newLine });
      oldIndex += 1;
      newIndex += 1;
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (lcs[oldIndex + 1][newIndex] >= lcs[oldIndex][newIndex + 1]) {
      ops.push({ kind: 'remove', text: oldLines[oldIndex], oldLine });
      oldIndex += 1;
      oldLine += 1;
    } else {
      ops.push({ kind: 'add', text: newLines[newIndex], newLine });
      newIndex += 1;
      newLine += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    ops.push({ kind: 'remove', text: oldLines[oldIndex], oldLine });
    oldIndex += 1;
    oldLine += 1;
  }

  while (newIndex < newLines.length) {
    ops.push({ kind: 'add', text: newLines[newIndex], newLine });
    newIndex += 1;
    newLine += 1;
  }

  return ops;
}

function hunkFromOps(lines: DiffLine[]): DiffHunk {
  const oldNumbers = lines
    .map((line) => line.oldLine)
    .filter((line): line is number => line !== undefined);
  const newNumbers = lines
    .map((line) => line.newLine)
    .filter((line): line is number => line !== undefined);
  const oldStart = oldNumbers[0] ?? 1;
  const newStart = newNumbers[0] ?? 1;
  return {
    oldStart,
    oldLines: oldNumbers.length,
    newStart,
    newLines: newNumbers.length,
    lines,
  };
}

export function computeStructuredDiff(
  filePath: string,
  oldString: string,
  newString: string,
  contextLines = 3,
): StructuredDiff {
  const ops = buildDiffOps(splitLines(oldString), splitLines(newString));
  const additions = ops.filter((op) => op.kind === 'add').length;
  const deletions = ops.filter((op) => op.kind === 'remove').length;

  if (additions === 0 && deletions === 0) {
    return { filePath, additions, deletions, hunks: [] };
  }

  const changeIndexes = ops
    .map((op, index) => (op.kind === 'context' ? -1 : index))
    .filter((index) => index >= 0);
  const hunks: DiffHunk[] = [];
  let hunkStart = Math.max(0, changeIndexes[0] - contextLines);
  let hunkEnd = Math.min(ops.length - 1, changeIndexes[0] + contextLines);

  for (const changeIndex of changeIndexes.slice(1)) {
    const nextStart = Math.max(0, changeIndex - contextLines);
    const nextEnd = Math.min(ops.length - 1, changeIndex + contextLines);
    if (nextStart <= hunkEnd + 1) {
      hunkEnd = Math.max(hunkEnd, nextEnd);
      continue;
    }
    hunks.push(hunkFromOps(ops.slice(hunkStart, hunkEnd + 1)));
    hunkStart = nextStart;
    hunkEnd = nextEnd;
  }

  hunks.push(hunkFromOps(ops.slice(hunkStart, hunkEnd + 1)));
  return { filePath, additions, deletions, hunks };
}

export function computeDiffStats(oldString: string, newString: string): {
  additions: number;
  deletions: number;
} {
  const diff = computeStructuredDiff('', oldString, newString, 0);
  return { additions: diff.additions, deletions: diff.deletions };
}

function prefixForLine(kind: DiffLineKind): string {
  if (kind === 'add') return '+';
  if (kind === 'remove') return '-';
  return ' ';
}

function DiffRows({ diff, compactLineLimit }: {
  diff: StructuredDiff;
  compactLineLimit?: number;
}): JSX.Element {
  let rendered = 0;
  const limit = compactLineLimit ?? Number.POSITIVE_INFINITY;
  const hiddenLines = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) - limit;

  return (
    <div className="diff-view" role="table" aria-label={`Diff for ${diff.filePath}`}>
      {diff.hunks.map((hunk, hunkIndex) => {
        if (rendered >= limit) {
          return null;
        }
        const remaining = limit - rendered;
        const lines = hunk.lines.slice(0, remaining);
        rendered += lines.length;
        return (
          <div key={hunkIndex} className="diff-view__hunk" role="rowgroup">
            <div className="diff-view__hunk-header" role="row">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {lines.map((line, lineIndex) => (
              <div
                key={`${hunkIndex}-${lineIndex}`}
                className={`diff-view__line diff-view__line--${line.kind}`}
                role="row"
              >
                <span className="diff-view__gutter">{line.oldLine ?? ''}</span>
                <span className="diff-view__gutter">{line.newLine ?? ''}</span>
                <span className="diff-view__prefix">{prefixForLine(line.kind)}</span>
                <span className="diff-view__text">{line.text || ' '}</span>
              </div>
            ))}
          </div>
        );
      })}
      {hiddenLines > 0 && (
        <div className="diff-view__truncated">
          {hiddenLines} more diff lines
        </div>
      )}
    </div>
  );
}

export function FileEditBlock({
  filePath,
  oldString,
  newString,
  compactLineLimit = 18,
}: FileEditBlockProps): JSX.Element {
  const [reviewOpen, setReviewOpen] = useState(false);
  const diff = useMemo(
    () => computeStructuredDiff(filePath, oldString, newString),
    [filePath, oldString, newString],
  );

  return (
    <div className="file-edit-block">
      <DiffRows diff={diff} compactLineLimit={compactLineLimit} />
      <button
        type="button"
        className="tool-card__secondary-action"
        onClick={(event) => {
          event.stopPropagation();
          setReviewOpen(true);
        }}
      >
        Expand diff
      </button>
      {reviewOpen && (
        <div className="diff-review" role="dialog" aria-modal="true" aria-label={`Full diff for ${filePath}`}>
          <div className="diff-review__panel">
            <div className="diff-review__header">
              <div className="diff-review__title">{filePath}</div>
              <div className="tool-card__stat-chip">
                +{diff.additions} / -{diff.deletions}
              </div>
              <button
                type="button"
                className="diff-review__close"
                onClick={(event) => {
                  event.stopPropagation();
                  setReviewOpen(false);
                }}
              >
                Close
              </button>
            </div>
            <DiffRows diff={diff} />
          </div>
        </div>
      )}
    </div>
  );
}
