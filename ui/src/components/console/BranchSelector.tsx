// Bug: a0963df — Branch selector UI for DAG branching
// Renders a horizontal separator bar at fork points with branch navigation.

import { useState } from 'preact/hooks';

export type BranchInfo = {
  dagUuid: string;
  firstText: string;   // first ~40 chars of assistant response
  blockCount: number;
  isLive?: boolean;     // currently streaming
};

export type BranchSelectorProps = {
  branchPointUuid: string;      // dag_uuid of the parent message (fork point)
  totalBranches: number;         // total sibling count
  currentIndex: number;          // 0-based index of currently selected branch
  onSelect: (index: number) => void;
  branches?: BranchInfo[];       // for expanded overview
};

export function BranchSelector({
  branchPointUuid,
  totalBranches,
  currentIndex,
  onSelect,
  branches,
}: BranchSelectorProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  // No DOM output when only one branch (or zero)
  if (totalBranches <= 1) {
    return null;
  }

  const atStart = currentIndex <= 0;
  const atEnd = currentIndex >= totalBranches - 1;

  return (
    <div className="branch-selector" data-branch-point={branchPointUuid}>
      <div className="branch-selector__bar">
        <div className="branch-selector__controls">
          <button
            type="button"
            className={`branch-selector__arrow${atStart ? ' branch-selector__arrow--disabled' : ''}`}
            onClick={() => { if (!atStart) onSelect(currentIndex - 1); }}
            disabled={atStart}
            aria-label="Previous branch"
          >
            &#9666;
          </button>
          <button
            type="button"
            className="branch-selector__label"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            aria-label={`Branch ${currentIndex + 1} of ${totalBranches}. Click to ${expanded ? 'collapse' : 'expand'} overview.`}
          >
            Branch {currentIndex + 1} of {totalBranches}
          </button>
          <button
            type="button"
            className={`branch-selector__arrow${atEnd ? ' branch-selector__arrow--disabled' : ''}`}
            onClick={() => { if (!atEnd) onSelect(currentIndex + 1); }}
            disabled={atEnd}
            aria-label="Next branch"
          >
            &#9656;
          </button>
        </div>
      </div>

      {expanded && branches && branches.length > 0 && (
        <div className="branch-selector__overview">
          {branches.map((branch, idx) => (
            <button
              key={branch.dagUuid}
              type="button"
              className={`branch-card${idx === currentIndex ? ' branch-card--active' : ''}`}
              onClick={() => { onSelect(idx); setExpanded(false); }}
            >
              <div className="branch-card__header">
                <span className="branch-card__label">Branch {idx + 1}</span>
                {branch.isLive && <span className="branch-card__dot" aria-label="Live" />}
              </div>
              <div className="branch-card__text">{branch.firstText || '\u2014'}</div>
              <div className="branch-card__turns">{branch.blockCount} block{branch.blockCount !== 1 ? 's' : ''}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
