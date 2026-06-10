import { useEffect, useMemo, useState } from 'preact/hooks';

import { getRepoBranches, getReviewDiff, getReviewSpec, getWorkRepos, ReviewSpecPayload } from '../api';
import type { WorkBranch, WorkRepo } from './work';

export type ReviewParams = {
  repo?: string;
  base?: string;
  head?: string;
};

export type ReviewViewProps = {
  params: ReviewParams;
  loaders?: {
    diff?: typeof getReviewDiff;
    spec?: typeof getReviewSpec;
  };
};

const EMPTY_SPEC: ReviewSpecPayload = { markdown: '', commits: [], meta: {} };

function getRepoId(repo: WorkRepo): string {
  return repo.id || repo.name || '';
}

function getRepoLabel(repo: WorkRepo): string {
  const root = repo.root || repo.path || '';
  const base = root ? root.split(/[\\/]/).filter(Boolean).pop() : '';
  const title = repo.name || base || repo.id || 'Unknown repo';
  if (root && root !== title) {
    return `${title} — ${root}`;
  }
  return title;
}

function getBranchName(branch: WorkBranch): string {
  return branch.name || branch.branch || '';
}

function buildReviewHash(params: ReviewParams): string {
  const searchParams = new URLSearchParams();
  if (params.repo) {
    searchParams.set('repo', params.repo);
  }
  if (params.base) {
    searchParams.set('base', params.base);
  }
  if (params.head) {
    searchParams.set('head', params.head);
  }
  const query = searchParams.toString();
  return `#/review${query ? `?${query}` : ''}`;
}

export function ReviewView({ params, loaders }: ReviewViewProps): JSX.Element {
  const [diffHtml, setDiffHtml] = useState('');
  const [spec, setSpec] = useState<ReviewSpecPayload>(EMPTY_SPEC);
  const [viewMode, setViewMode] = useState<'unified' | 'side-by-side'>('side-by-side');
  const [repos, setRepos] = useState<WorkRepo[]>([]);
  const [branches, setBranches] = useState<WorkBranch[]>([]);
  const [selectedRepo, setSelectedRepo] = useState(params.repo || '');
  const [selectedBase, setSelectedBase] = useState(params.base || '');
  const [selectedHead, setSelectedHead] = useState(params.head || '');
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [loadingBranches, setLoadingBranches] = useState(false);

  const hasRange = Boolean(params.repo && params.base && params.head);

  useEffect(() => {
    setSelectedRepo(params.repo || '');
    setSelectedBase(params.base || '');
    setSelectedHead(params.head || '');
  }, [params.repo, params.base, params.head]);

  useEffect(() => {
    let cancelled = false;
    setLoadingRepos(true);
    getWorkRepos<WorkRepo>()
      .then((data) => {
        if (!cancelled) {
          setRepos(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRepos([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingRepos(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!selectedRepo) {
      setBranches([]);
      return () => {
        cancelled = true;
      };
    }
    setLoadingBranches(true);
    getRepoBranches<WorkBranch>(selectedRepo)
      .then((data) => {
        if (!cancelled) {
          setBranches(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBranches([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingBranches(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRepo]);

  const repoOptions = useMemo(() => {
    return repos
      .map((repo) => {
        const id = getRepoId(repo);
        if (!id) {
          return null;
        }
        return { id, label: getRepoLabel(repo) };
      })
      .filter((item): item is { id: string; label: string } => Boolean(item))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [repos]);

  const branchOptions = useMemo(() => {
    const names = branches.map(getBranchName).filter((name) => Boolean(name));
    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
  }, [branches]);

  const repoPlaceholder = loadingRepos
    ? 'Loading repositories...'
    : repoOptions.length === 0
      ? 'No repositories found'
      : 'Select a repository';

  const branchPlaceholder = selectedRepo
    ? loadingBranches
      ? 'Loading branches...'
      : 'Choose a branch or commit'
    : 'Select a repository first';

  const updateHash = (nextParams: ReviewParams) => {
    if (typeof window === 'undefined') {
      return;
    }
    const nextHash = buildReviewHash(nextParams);
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  };

  const handleRepoChange = (value: string) => {
    setSelectedRepo(value);
    setSelectedBase('');
    setSelectedHead('');
    updateHash({ repo: value || undefined });
  };

  const handleBaseChange = (value: string) => {
    setSelectedBase(value);
    updateHash({
      repo: selectedRepo || undefined,
      base: value || undefined,
      head: selectedHead || undefined,
    });
  };

  const handleHeadChange = (value: string) => {
    setSelectedHead(value);
    updateHash({
      repo: selectedRepo || undefined,
      base: selectedBase || undefined,
      head: value || undefined,
    });
  };

  useEffect(() => {
    let cancelled = false;
    const loadDiff = loaders?.diff || getReviewDiff;
    const loadSpec = loaders?.spec || getReviewSpec;

    if (!hasRange) {
      setDiffHtml('');
      setSpec(EMPTY_SPEC);
      return () => {
        cancelled = true;
      };
    }

    loadDiff({ ...params, view: viewMode })
      .then((html) => {
        if (!cancelled) {
          setDiffHtml(html);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDiffHtml('');
        }
      });

    loadSpec(params)
      .then((payload) => {
        if (!cancelled) {
          setSpec(payload);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSpec(EMPTY_SPEC);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [params.repo, params.base, params.head, viewMode, hasRange, loaders?.diff, loaders?.spec]);

  const subtitle = hasRange
    ? 'Diff and commit spec for the selected range.'
    : 'Select a repository and branch range to view diffs.';

  return (
    <div className="view review-view">
      <div className="view-header">
        <div>
          <h2>Review Surface</h2>
          <p className="text-muted">{subtitle}</p>
        </div>
        <div className="toggle-group">
          <button
            type="button"
            className={`btn ${viewMode === 'side-by-side' ? 'btn--active' : ''}`}
            onClick={() => setViewMode('side-by-side')}
          >
            Side-by-side
          </button>
          <button
            type="button"
            className={`btn ${viewMode === 'unified' ? 'btn--active' : ''}`}
            onClick={() => setViewMode('unified')}
          >
            Unified
          </button>
        </div>
      </div>

      <div className="review-controls">
        <div className="review-control">
          <label htmlFor="review-repo">Repository</label>
          <select
            id="review-repo"
            value={selectedRepo}
            onChange={(event) => handleRepoChange(event.currentTarget.value)}
          >
            <option value="">{repoPlaceholder}</option>
            {repoOptions.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.label}
              </option>
            ))}
          </select>
        </div>
        <div className="review-control">
          <label htmlFor="review-base">Base</label>
          <input
            id="review-base"
            list="review-branches"
            value={selectedBase}
            placeholder={branchPlaceholder}
            disabled={!selectedRepo}
            onInput={(event) => handleBaseChange(event.currentTarget.value)}
          />
        </div>
        <div className="review-control">
          <label htmlFor="review-head">Head</label>
          <input
            id="review-head"
            list="review-branches"
            value={selectedHead}
            placeholder={branchPlaceholder}
            disabled={!selectedRepo}
            onInput={(event) => handleHeadChange(event.currentTarget.value)}
          />
        </div>
      </div>
      <datalist id="review-branches">
        {branchOptions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <div className="review-panels">
        <div className="panel">
          <h3>Commits</h3>
          <ul className="commit-list">
            {!hasRange ? (
              <li className="text-muted">Select a repository and branch range to load commits.</li>
            ) : spec.commits.length === 0 ? (
              <li className="text-muted">No commit log available. Try a different range.</li>
            ) : (
              spec.commits.map((commit) => <li key={commit}>{commit}</li>)
            )}
          </ul>
        </div>
        <div className="panel">
          <h3>Commit Spec</h3>
          <pre className="spec-panel">
            {hasRange ? spec.markdown || 'No spec loaded. Try a different range.' : subtitle}
          </pre>
        </div>
      </div>

      <div className="review-diff">
        <h3>Diff</h3>
        {diffHtml ? (
          <div className="diff-panel" dangerouslySetInnerHTML={{ __html: diffHtml }} />
        ) : (
          <div className="empty-state">
            {hasRange ? 'No diff loaded. Try a different range.' : subtitle}
          </div>
        )}
      </div>
    </div>
  );
}
