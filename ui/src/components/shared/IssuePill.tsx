import { useEffect, useState } from 'preact/hooks';
import { parseIssueRefTarget } from '../../../../src/ledger/authored-references';
import { issueRouteHref, resolveResourceRef } from '../../resource-refs';

export type IssuePillProps = {
  /** Any issue ref: `<id>` or `<project>/<id>`, as stored or authored. */
  issueRef: string;
  /** The project or repo the ref was written in; a bare ref resolves there first. */
  context?: string;
  layout?: 'pill' | 'row';
};

type ResolvedIssue = {
  shortId: string;
  projectRef: string;
  title: string;
  sameProject: boolean;
};

const resolutions = new Map<string, Promise<ResolvedIssue | null>>();

function resolveIssue(issueRef: string, context: string | undefined): Promise<ResolvedIssue | null> {
  const key = `${context ?? ''}\u0000${issueRef}`;
  let pending = resolutions.get(key);
  if (!pending) {
    pending = resolveResourceRef(`issue:${issueRef}`, { project: context })
      .then((result) => {
        const entity = result.resolved ? result.entity : null;
        if (!entity || typeof entity.id !== 'string') return null;
        const projectRef = typeof entity.project_ref === 'string' ? entity.project_ref : '';
        return {
          shortId: typeof entity.short_id === 'string' && entity.short_id ? entity.short_id : entity.id.slice(0, 7),
          projectRef,
          title: typeof entity.title === 'string' ? entity.title : '',
          sameProject: result.detail?.same_project === true,
        };
      })
      .catch(() => {
        resolutions.delete(key);
        return null;
      });
    resolutions.set(key, pending);
  }
  return pending;
}

/**
 * A linked issue: its id, qualified with its project when that is not the
 * context's, and its title. Unresolvable refs render verbatim.
 */
export function IssuePill({ issueRef, context, layout = 'pill' }: IssuePillProps): JSX.Element {
  const ref = issueRef.trim();
  const [state, setState] = useState<{ ref: string; issue: ResolvedIssue | null } | null>(null);

  useEffect(() => {
    let active = true;
    void resolveIssue(ref, context).then((issue) => {
      if (active) setState({ ref, issue });
    });
    return () => {
      active = false;
    };
  }, [ref, context]);

  const issue = state?.ref === ref ? state.issue : undefined;
  if (issue) {
    const label = issue.sameProject || !issue.projectRef ? issue.shortId : `${issue.projectRef}/${issue.shortId}`;
    return (
      <a
        className={layout === 'row' ? 'issue-reference-row' : 'issue-pill'}
        href={issueRouteHref(issue.shortId, issue.projectRef || context)}
        onClick={(event) => event.stopPropagation()}
        title={issue.title ? `${label} ${issue.title}` : label}
      >
        <span className={layout === 'row' ? 'issue-pill issue-pill__id' : 'issue-pill__id'}>{label}</span>
        {issue.title && <span className="issue-pill__title">{issue.title}</span>}
      </a>
    );
  }

  const target = parseIssueRefTarget(ref);
  const unresolved = issue === null;
  return (
    <a
      className={`${layout === 'row' ? 'issue-reference-row' : 'issue-pill'}${unresolved ? ' issue-pill--unresolved' : ''}`}
      href={issueRouteHref(target?.issue ?? ref, target?.project ?? context)}
      onClick={(event) => event.stopPropagation()}
      title={unresolved ? `No issue matches ${ref}` : ref}
    >
      <span className={layout === 'row' ? 'issue-pill issue-pill__id' : 'issue-pill__id'}>{ref}</span>
    </a>
  );
}
