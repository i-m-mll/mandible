import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { marked } from 'marked';
import {
  getArtifact,
  getArtifactContent,
  getArtifacts,
  resolveArtifact,
  type ArtifactContentResult,
  type ArtifactRecord,
  type ArtifactResolveResult,
} from '../api';
import { artifactDetailHref } from '../artifact-links';
import { sanitizeMarkdown } from '../sanitize';
import { useSidebarResize } from '../hooks/useSidebarResize';

type ArtifactsViewProps = {
  initialArtifactId?: string;
  initialRef?: string;
  initialRepo?: string;
};

type ArtifactFilters = {
  q: string;
  repo: string;
  provider: string;
  role: string;
  custody: string;
  availability: string;
  scheme: string;
  location: string;
};

const EMPTY_FILTERS: ArtifactFilters = {
  q: '',
  repo: '',
  provider: '',
  role: '',
  custody: '',
  availability: '',
  scheme: '',
  location: '',
};

export function ArtifactsView({ initialArtifactId, initialRef, initialRepo }: ArtifactsViewProps): JSX.Element {
  const { width: sidebarWidth, handleMouseDown } = useSidebarResize({
    defaultWidth: 320,
    minWidth: 240,
    storageKey: 'sidebar-width:artifacts',
  });
  const [filters, setFilters] = useState<ArtifactFilters>(() => ({
    ...EMPTY_FILTERS,
    repo: initialRepo ?? '',
  }));
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialArtifactId ?? null);
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactRecord | null>(null);
  const [artifactContent, setArtifactContent] = useState<ArtifactContentResult | null>(null);
  const [resolution, setResolution] = useState<ArtifactResolveResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    setFilters((current) => ({ ...current, repo: initialRepo ?? current.repo }));
  }, [initialRepo]);

  const loadArtifacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getArtifacts({
        q: filters.q || undefined,
        repo: filters.repo || undefined,
        provider: filters.provider || undefined,
        role: filters.role || undefined,
        custody: filters.custody || undefined,
        availability: filters.availability || undefined,
        scheme: filters.scheme || undefined,
        location: filters.location || undefined,
        limit: 200,
      });
      setArtifacts(next);
      if (!selectedId && !initialRef && next[0]) {
        setSelectedId(next[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filters, selectedId, initialRef]);

  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts]);

  useEffect(() => {
    if (!initialArtifactId) return;
    setSelectedId(initialArtifactId);
    setResolution(null);
  }, [initialArtifactId]);

  useEffect(() => {
    if (!initialRef) return;
    setDetailLoading(true);
    setError(null);
    resolveArtifact(initialRef)
      .then((next) => {
        setResolution(next);
        setSelectedArtifact(next.artifact);
        setSelectedId(next.artifact?.id ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setDetailLoading(false));
  }, [initialRef]);

  useEffect(() => {
    if (!selectedId || initialRef) return;
    setDetailLoading(true);
    setError(null);
    getArtifact(selectedId)
      .then((artifact) => {
        setSelectedArtifact(artifact);
        setResolution(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setDetailLoading(false));
  }, [selectedId, initialRef]);

  useEffect(() => {
    if (!selectedArtifact) {
      setArtifactContent(null);
      setContentError(null);
      setContentLoading(false);
      return;
    }
    let cancelled = false;
    setContentLoading(true);
    setContentError(null);
    setArtifactContent(null);
    getArtifactContent(selectedArtifact.id)
      .then((content) => {
        if (!cancelled) setArtifactContent(content);
      })
      .catch((err) => {
        if (!cancelled) setContentError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedArtifact?.id]);

  const facetOptions = useMemo(() => buildFacetOptions(artifacts), [artifacts]);

  const selectArtifact = (artifact: ArtifactRecord) => {
    setSelectedId(artifact.id);
    setResolution(null);
    const nextHash = artifactDetailHref(artifact.id);
    if (typeof window !== 'undefined' && window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  };

  const updateFilter = (key: keyof ArtifactFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
  };

  return (
    <div className="artifacts-view">
      <aside
        className="artifacts-sidebar"
        style={sidebarWidth !== null ? { width: `${sidebarWidth}px`, flexShrink: 0 } : undefined}
      >
        <div className="artifacts-filter">
          <input
            className="artifacts-filter__input"
            value={filters.q}
            placeholder="Search artifacts"
            onInput={(e) => updateFilter('q', e.currentTarget.value)}
          />
          {filters.q && (
            <button type="button" className="artifacts-filter__clear" onClick={() => updateFilter('q', '')}>
              ×
            </button>
          )}
          <button
            type="button"
            className="artifacts-filter__advanced-trigger"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-label="Artifact filters"
          >
            ⋯
          </button>
        </div>
        {advancedOpen && (
          <div className="artifacts-advanced">
            <FacetSelect label="Location" value={filters.scheme} options={facetOptions.schemes} onChange={(value) => updateFilter('scheme', value)} />
            <FacetSelect label="Custody" value={filters.custody} options={facetOptions.custodies} onChange={(value) => updateFilter('custody', value)} />
            <FacetSelect label="Availability" value={filters.availability} options={facetOptions.availabilities} onChange={(value) => updateFilter('availability', value)} />
            <FacetSelect label="Repo" value={filters.repo} options={facetOptions.repos} onChange={(value) => updateFilter('repo', value)} />
            <FacetSelect label="Provider" value={filters.provider} options={facetOptions.providers} onChange={(value) => updateFilter('provider', value)} />
            <FacetSelect label="Role" value={filters.role} options={facetOptions.roles} onChange={(value) => updateFilter('role', value)} />
            <input
              className="artifacts-advanced__input"
              value={filters.location}
              placeholder="Path or locator"
              onInput={(e) => updateFilter('location', e.currentTarget.value)}
            />
            <button type="button" className="btn btn--ghost btn--sm" onClick={clearFilters}>Clear</button>
          </div>
        )}
        <div className="artifacts-sidebar__list">
          {loading && <div className="artifacts-sidebar__empty">Loading artifacts...</div>}
          {!loading && artifacts.length === 0 && <div className="artifacts-sidebar__empty">No artifacts</div>}
          {artifacts.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              className={`artifacts-sidebar__item${artifact.id === selectedId ? ' artifacts-sidebar__item--active' : ''}`}
              onClick={() => selectArtifact(artifact)}
            >
              <span className="artifacts-sidebar__name">{artifactTitle(artifact)}</span>
              <span className="artifacts-sidebar__meta">
                {artifact.home_repo_id || artifact.provider_id || artifact.custody_mode}
              </span>
              <span className="artifacts-sidebar__badges">
                <em>{artifact.role || artifact.media_type || 'artifact'}</em>
                <em>{artifact.availability}</em>
              </span>
            </button>
          ))}
        </div>
      </aside>
      <div className="sidebar-drag-handle" onMouseDown={handleMouseDown} />
      <main className="artifacts-detail">
        {error && <div className="artifacts-error">{error}</div>}
        {detailLoading && <div className="artifacts-empty">Loading artifact...</div>}
        {!detailLoading && !selectedArtifact && !resolution && (
          <div className="artifacts-empty">Select an artifact or open an artifact URI.</div>
        )}
        {!detailLoading && resolution && !resolution.artifact && (
          <UnresolvedArtifact resolution={resolution} />
        )}
        {!detailLoading && selectedArtifact && (
          <ArtifactDetail
            artifact={selectedArtifact}
            resolution={resolution}
            content={artifactContent}
            contentLoading={contentLoading}
            contentError={contentError}
          />
        )}
      </main>
    </div>
  );
}

function FacetSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className="artifacts-advanced__field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        <option value="">Any</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function ArtifactDetail({
  artifact,
  resolution,
  content,
  contentLoading,
  contentError,
}: {
  artifact: ArtifactRecord;
  resolution: ArtifactResolveResult | null;
  content: ArtifactContentResult | null;
  contentLoading: boolean;
  contentError: string | null;
}): JSX.Element {
  const preview = content ? artifactPreview(content) : null;
  const locatorRows = [
    ['URI', artifact.uri],
    ['Content hash', artifact.content_hash],
    ['Home repo', artifact.home_repo_id],
    ['Provider', artifact.provider_id],
    ['Manifest', artifact.manifest_id],
    ['Resolved from', resolution?.ref ?? ''],
  ].filter(([, value]) => Boolean(value)) as Array<[string, string]>;

  return (
    <article className="artifact-detail">
      <header className="artifact-detail__header">
        <div>
          <div className="artifact-detail__type">{artifact.custody_mode} artifact</div>
          <h2>{artifactTitle(artifact)}</h2>
        </div>
        <div className="artifact-detail__status">
          <span>{artifact.availability}</span>
          {artifact.pinned && <span>pinned</span>}
        </div>
      </header>
      <section className="artifact-detail__section">
        <h3>Identity</h3>
        <KeyValue rows={locatorRows} />
      </section>
      <section className="artifact-detail__section">
        <h3>Custody</h3>
        <KeyValue rows={[
          ['Mode', artifact.custody_mode],
          ['Role', artifact.role ?? ''],
          ['Media type', artifact.media_type ?? ''],
          ['Size', formatBytes(artifact.size_bytes)],
          ['Created', formatTime(artifact.created_at)],
        ]} />
      </section>
      {artifact.aliases && artifact.aliases.length > 0 && (
        <section className="artifact-detail__section">
          <h3>Locators</h3>
          <div className="artifact-detail__list">
            {artifact.aliases.map((alias) => (
              <div key={alias.id} className="artifact-detail__list-item">
                <code>{alias.normalized_ref}</code>
                <span>{alias.scheme}</span>
                <span>{alias.resolution_status}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {artifact.links && artifact.links.length > 0 && (
        <section className="artifact-detail__section">
          <h3>Links</h3>
          <div className="artifact-detail__list">
            {artifact.links.map((link) => (
              <a key={link.id} className="artifact-detail__list-item" href={entityHref(link.entity_type, link.entity_id, link.repo_id)}>
                <code>{link.entity_type}:{link.entity_id}</code>
                <span>{link.link_type}</span>
                <span>{link.role || link.source}</span>
              </a>
            ))}
          </div>
        </section>
      )}
      <section className="artifact-detail__section">
        <h3>Preview</h3>
        {contentLoading && <div className="artifacts-empty">Loading preview...</div>}
        {!contentLoading && contentError && <div className="artifacts-error">{contentError}</div>}
        {!contentLoading && !contentError && preview?.kind === 'json' && <pre className="artifact-preview"><code>{preview.value}</code></pre>}
        {!contentLoading && !contentError && preview?.kind === 'text' && <pre className="artifact-preview"><code>{preview.value}</code></pre>}
        {!contentLoading && !contentError && preview?.kind === 'markdown' && <div className="artifact-preview spec-panel" dangerouslySetInnerHTML={{ __html: preview.value }} />}
        {!contentLoading && !contentError && preview?.kind === 'binary' && (
          <div className="artifacts-empty">
            Binary artifact available ({formatBytes(content?.download.size_bytes ?? 0) || content?.download.media_type}).
          </div>
        )}
        {!contentLoading && !contentError && preview?.kind === 'empty' && <div className="artifacts-empty">{preview.value}</div>}
        {!contentLoading && !contentError && content?.preview?.truncated && (
          <div className="artifact-detail__hint">Preview truncated at the server limit.</div>
        )}
      </section>
    </article>
  );
}

function UnresolvedArtifact({ resolution }: { resolution: ArtifactResolveResult }): JSX.Element {
  return (
    <article className="artifact-detail">
      <header className="artifact-detail__header">
        <div>
          <div className="artifact-detail__type">unresolved reference</div>
          <h2>{resolution.normalized_ref}</h2>
        </div>
        <div className="artifact-detail__status">
          <span>{resolution.status}</span>
        </div>
      </header>
      <section className="artifact-detail__section">
        <h3>Resolver</h3>
        <KeyValue rows={[
          ['Scheme', resolution.scheme],
          ['Raw ref', resolution.ref],
          ['Normalized ref', resolution.normalized_ref],
          ['Status', resolution.status],
          ['Source', resolution.alias.source],
        ]} />
      </section>
    </article>
  );
}

function KeyValue({ rows }: { rows: Array<[string, string]> }): JSX.Element {
  return (
    <div className="artifact-detail__kv">
      {rows.filter(([, value]) => value).map(([key, value]) => (
        <div key={key}>
          <span>{key}</span>
          <code>{value}</code>
        </div>
      ))}
    </div>
  );
}

function buildFacetOptions(artifacts: ArtifactRecord[]): {
  schemes: string[];
  custodies: string[];
  availabilities: string[];
  repos: string[];
  providers: string[];
  roles: string[];
} {
  const schemes = new Set<string>();
  const custodies = new Set<string>();
  const availabilities = new Set<string>();
  const repos = new Set<string>();
  const providers = new Set<string>();
  const roles = new Set<string>();
  for (const artifact of artifacts) {
    custodies.add(artifact.custody_mode);
    availabilities.add(artifact.availability);
    if (artifact.home_repo_id) repos.add(artifact.home_repo_id);
    if (artifact.provider_id) providers.add(artifact.provider_id);
    if (artifact.role) roles.add(artifact.role);
    for (const alias of artifact.aliases ?? []) {
      schemes.add(alias.scheme);
    }
    const uriScheme = artifact.uri.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
    if (uriScheme) schemes.add(uriScheme.toLowerCase());
  }
  return {
    schemes: [...schemes].sort(),
    custodies: [...custodies].sort(),
    availabilities: [...availabilities].sort(),
    repos: [...repos].sort(),
    providers: [...providers].sort(),
    roles: [...roles].sort(),
  };
}

function artifactTitle(artifact: ArtifactRecord): string {
  const metadataTitle = typeof artifact.metadata.title === 'string' ? artifact.metadata.title : '';
  const filename = typeof artifact.metadata.filename === 'string' ? artifact.metadata.filename : '';
  const logicalName = typeof artifact.metadata.logical_name === 'string' ? artifact.metadata.logical_name : '';
  return metadataTitle || logicalName || filename || artifact.role || artifact.content_hash.slice(0, 12);
}

function artifactPreview(content: ArtifactContentResult): { kind: 'json' | 'markdown' | 'text' | 'binary' | 'empty'; value: string } {
  if (content.kind === 'json' && content.preview) {
    return { kind: 'json', value: content.preview.text };
  }
  if (content.kind === 'markdown' && content.preview) {
    const parsed = marked.parse(content.preview.text, { async: false });
    return { kind: 'markdown', value: sanitizeMarkdown(typeof parsed === 'string' ? parsed : '') };
  }
  if (content.kind === 'text' && content.preview) {
    return { kind: 'text', value: content.preview.text };
  }
  if (content.kind === 'binary' && content.download.available) {
    return { kind: 'binary', value: content.download.media_type };
  }
  if (content.reason) {
    return { kind: 'empty', value: content.reason };
  }
  return { kind: 'empty', value: 'No inline preview is available for this artifact.' };
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value: number): string {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

function entityHref(type: string, id: string, repoId: string | null): string {
  if (type === 'issue') {
    const params = new URLSearchParams({ issue: id });
    if (repoId) params.set('repo', repoId);
    return `#/issues?${params.toString()}`;
  }
  if (type === 'auth_request') return `#/auth?request=${encodeURIComponent(id)}`;
  if (type === 'session') return `#/sessions?session=${encodeURIComponent(id)}`;
  if (type === 'provider_manifest') return `#/graph?mode=provider-lineage&focus=${encodeURIComponent(id)}`;
  return `#/graph?focus=${encodeURIComponent(id)}`;
}
