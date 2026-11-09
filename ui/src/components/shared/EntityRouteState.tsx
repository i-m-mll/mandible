import type { ComponentChildren } from 'preact';
import type { EntityKind } from '../../../../src/app-routes';
import type { AuthRequestType, ResolverMatch } from '../../../../src/contracts';
import type { EntityRouteResolution } from '../../hooks/useEntityRoute';
import { renderInlineMarkdown } from '../../lib/markdown';
import { routeWithParams } from '../../routing';
import { AUTH_TYPE_META, authStatusPillClass } from '../../views/auth-presentation';
import { StatusPill } from '../ledger/StatusPill';
import { DetailPaneNotice } from './DetailPaneNotice';
import { DetailPaneShell } from './DetailPaneShell';

const KIND_LABEL: Record<EntityKind, string> = {
  issue: 'Issue',
  auth: 'Approval',
  artifact: 'Artifact',
  briefing: 'Briefing',
};

type UnopenedEntityRoute = Extract<EntityRouteResolution, { status: 'resolving' | 'not_found' | 'ambiguous' | 'failed' }>;

/** Whether an entity path's resolution leaves its view without an entity to open. */
export function isUnopenedEntityRoute(resolution: EntityRouteResolution): resolution is UnopenedEntityRoute {
  return resolution.status !== 'none' && resolution.status !== 'resolved';
}

function RouteStatePane({ children }: { children?: ComponentChildren }): JSX.Element {
  return (
    <DetailPaneShell className="entity-route-state" bodyClassName="entity-route-state__body">
      <div className="entity-route-state__content">{children}</div>
    </DetailPaneShell>
  );
}

/** The card an unopened entity path presents, headed by its one-sentence explanation. */
function RouteStateCard({ heading, children }: { heading: ComponentChildren; children?: ComponentChildren }): JSX.Element {
  return (
    <section className="ledger-comment-card">
      <div className="ledger-comment-card__header"><span>{heading}</span></div>
      {children}
    </section>
  );
}

/** The facets the candidate's own list row shows, so same-prefix candidates can be told apart. */
function MatchFacets({ match }: { match: ResolverMatch }): JSX.Element | null {
  switch (match.kind) {
    case 'issue':
      return (
        <span className="ledger-issue-detail__labels">
          {match.project ? <span className="issues-item__repo">{match.project}</span> : null}
          <StatusPill status={match.status} resolution={match.resolution} size="sm" />
        </span>
      );
    case 'auth': {
      const type = AUTH_TYPE_META[(match.type ?? 'merge') as AuthRequestType];
      return (
        <span className="ledger-issue-detail__labels">
          {match.repo ? <span className="auth-sidebar-item__repo">{match.repo}</span> : null}
          {type ? <span className={`type-badge type-badge--sm ${type.cssClass}`}>{type.label}</span> : null}
          <span className={authStatusPillClass(match.status)}>{match.status}</span>
        </span>
      );
    }
    case 'artifact':
      return match.role ? <span className="artifacts-sidebar__meta"><em>{match.role}</em></span> : null;
    case 'briefing':
      return null;
  }
}

/** The detail pane of an entity path that opened no entity: resolving, not found, ambiguous or failed. */
export function EntityRouteState({ kind, resolution }: { kind: EntityKind; resolution: UnopenedEntityRoute }): JSX.Element {
  const label = KIND_LABEL[kind];
  switch (resolution.status) {
    case 'resolving':
      return <RouteStatePane />;
    case 'failed':
      return (
        <RouteStatePane>
          <DetailPaneNotice
            severity="error"
            source={`entity-route:${kind}`}
            title={`${label} could not be opened`}
            actions={<button type="button" onClick={resolution.retry}>Retry</button>}
          >
            {resolution.error}
          </DetailPaneNotice>
        </RouteStatePane>
      );
    case 'not_found':
      return (
        <RouteStatePane>
          <RouteStateCard heading={<>{label} ID <code className="detail-pane-header__display-ref">{resolution.ref}</code> was not found.</>} />
        </RouteStatePane>
      );
    case 'ambiguous': {
      const more = resolution.total - resolution.matches.length;
      return (
        <RouteStatePane>
          <RouteStateCard heading={<>{label} ID <code className="detail-pane-header__display-ref">{resolution.ref}</code> is ambiguous. Please choose one of the following:</>}>
            <div className="ledger-child-list" role="list">
              {resolution.matches.map((match) => (
                <a
                  key={`${match.kind}:${match.ref}`}
                  role="listitem"
                  className="ledger-dependency-row"
                  href={routeWithParams({ kind: 'entity', entity: match.kind, ref: match.ref })}
                >
                  <code>{match.ref}</code>
                  {match.kind === 'issue' && match.title
                    ? <strong dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(match.title) }} />
                    : <strong>{match.title}</strong>}
                  <MatchFacets match={match} />
                </a>
              ))}
            </div>
            {more > 0 ? <p className="text-muted">and {more} more</p> : null}
          </RouteStateCard>
        </RouteStatePane>
      );
    }
  }
}

/** The content of a path outside the route table. */
export function RouteNotFound({ path }: { path: string }): JSX.Element {
  return (
    <RouteStatePane>
      <RouteStateCard heading={<>Page <code className="detail-pane-header__display-ref">{path}</code> was not found.</>} />
    </RouteStatePane>
  );
}
