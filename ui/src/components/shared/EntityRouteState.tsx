import type { ComponentChildren } from 'preact';
import type { EntityKind } from '../../../../src/app-routes';
import type { EntityRouteResolution } from '../../hooks/useEntityRoute';
import { renderInlineMarkdown } from '../../lib/markdown';
import { routeWithParams } from '../../routing';
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
      <div className="entity-route-state__content rendered-markdown">{children}</div>
    </DetailPaneShell>
  );
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
          <p>{label} ID <code>{resolution.ref}</code> was not found.</p>
        </RouteStatePane>
      );
    case 'ambiguous': {
      const more = resolution.total - resolution.matches.length;
      return (
        <RouteStatePane>
          <p>{label} ID <code>{resolution.ref}</code> is ambiguous. Please choose one of the following:</p>
          <ul className="entity-route-state__matches">
            {resolution.matches.map((match) => (
              <li key={`${match.kind}:${match.ref}`}>
                <a href={routeWithParams({ kind: 'entity', entity: match.kind, ref: match.ref })}><code>{match.ref}</code></a>
                {match.title ? (
                  match.kind === 'issue'
                    ? <> <span dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(match.title) }} /></>
                    : <> {match.title}</>
                ) : null}
              </li>
            ))}
          </ul>
          {more > 0 ? <p>and {more} more</p> : null}
        </RouteStatePane>
      );
    }
  }
}

/** The content of a path outside the route table. */
export function RouteNotFound({ path }: { path: string }): JSX.Element {
  return (
    <RouteStatePane>
      <p>Page <code>{path}</code> was not found.</p>
    </RouteStatePane>
  );
}
