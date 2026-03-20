// Bug: 84cd5ae — shared cross-tab entity link component

export type EntityPillType = 'issue' | 'session' | 'auth' | 'branch' | 'conversation' | 'work-unit';

export type EntityPillProps = {
  type: EntityPillType;
  id: string;
  label?: string;
  href?: string;
  repoId?: string; // used for issue/branch auto-href
};

const TYPE_HREF_MAP: Record<EntityPillType, (id: string, repoId?: string) => string> = {
  issue: (id, repoId) =>
    repoId
      ? `#/issues?repo=${encodeURIComponent(repoId)}&issue=${encodeURIComponent(id)}`
      : `#/issues?issue=${encodeURIComponent(id)}`,
  session: (id) => `#/sessions?session=${encodeURIComponent(id)}`,
  auth: (id) => `#/auth?request=${encodeURIComponent(id)}`,
  branch: (id, repoId) =>
    repoId
      ? `#/work?repo=${encodeURIComponent(repoId)}&branch=${encodeURIComponent(id)}`
      : `#/work?branch=${encodeURIComponent(id)}`,
  conversation: (id) => `#/chat-history?session=${encodeURIComponent(id)}`,
  'work-unit': (id, repoId) =>
    repoId
      ? `#/issues?repo=${encodeURIComponent(repoId)}&issue=${encodeURIComponent(id)}`
      : `#/issues?issue=${encodeURIComponent(id)}`,
};

export function EntityPill({ type, id, label, href, repoId }: EntityPillProps): JSX.Element {
  const resolvedHref = href ?? TYPE_HREF_MAP[type](id, repoId);
  const displayLabel = label ?? id.slice(0, 8);

  return (
    <a
      className={`entity-pill entity-pill--${type}`}
      href={resolvedHref}
      onClick={(e) => e.stopPropagation()}
      title={`${type}: ${id}`}
    >
      {displayLabel}
    </a>
  );
}

/** Render a list of EntityPills in a flex container */
export function EntityPillList({ children }: { children: JSX.Element | JSX.Element[] | null }): JSX.Element {
  return <div className="entity-pill-list">{children}</div>;
}
