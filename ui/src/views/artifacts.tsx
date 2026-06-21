import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import {
  getArtifact,
  getArtifactContent,
  getArtifactKnowledgeBackrefs,
  getArtifacts,
  resolveArtifact,
  type ArtifactContentResult,
  type ArtifactRecord,
  type ArtifactResolveResult,
  type KnowledgeBackrefRecord,
} from '../api';
import { artifactDetailHref, compactArtifactRef, displayArtifactRef } from '../artifact-links';
import { sanitizeMarkdown } from '../sanitize';
import { useSidebarResize } from '../hooks/useSidebarResize';

type ArtifactsViewProps = {
  initialArtifactId?: string;
  initialRef?: string;
  initialRepo?: string;
  sidebarHidden?: boolean;
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

type BundleMemberPreview = {
  artifactId: string;
  role: string;
  recoverability: string;
  order: number;
};

type ArtifactPreview =
  | { kind: 'json' | 'markdown' | 'text' | 'html' | 'empty'; value: string }
  | { kind: 'binary'; value: string }
  | { kind: 'bundle'; manifestText: string; name: string; members: BundleMemberPreview[] };

export function ArtifactsView({ initialArtifactId, initialRef, initialRepo, sidebarHidden = false }: ArtifactsViewProps): JSX.Element {
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
  const [knowledgeBackrefs, setKnowledgeBackrefs] = useState<KnowledgeBackrefRecord[]>([]);
  const [resolution, setResolution] = useState<ArtifactResolveResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [facetArtifacts, setFacetArtifacts] = useState<ArtifactRecord[]>([]);
  const initialRefRef = useRef(initialRef);
  const listRequestIdRef = useRef(0);
  const facetRequestIdRef = useRef(0);

  useEffect(() => {
    setFilters((current) => {
      const repo = initialRepo ?? current.repo;
      return current.repo === repo ? current : { ...current, repo };
    });
  }, [initialRepo]);

  useEffect(() => {
    initialRefRef.current = initialRef;
  }, [initialRef]);

  const loadArtifacts = useCallback(async () => {
    const requestId = listRequestIdRef.current + 1;
    listRequestIdRef.current = requestId;
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
        summary: true,
      });
      if (listRequestIdRef.current !== requestId) return;
      setArtifacts(next);
      setSelectedId((current) => (
        current || initialRefRef.current || !next[0] ? current : next[0].id
      ));
      setSelectedArtifact((current) => (
        current || initialRefRef.current || !next[0] ? current : next[0]
      ));
    } catch (err) {
      if (listRequestIdRef.current === requestId) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (listRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [filters]);

  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts]);

  const loadFacetArtifacts = useCallback(async () => {
    const requestId = facetRequestIdRef.current + 1;
    facetRequestIdRef.current = requestId;
    try {
      const next = await getArtifacts({
        q: filters.q || undefined,
        location: filters.location || undefined,
        limit: 500,
        summary: true,
      });
      if (facetRequestIdRef.current !== requestId) return;
      setFacetArtifacts(next);
    } catch {
      // Keep the last successful option corpus so transient reload failures do not collapse selects.
    }
  }, [filters.q, filters.location]);

  useEffect(() => {
    void loadFacetArtifacts();
  }, [loadFacetArtifacts]);

  useEffect(() => {
    if (!initialArtifactId) return;
    setSelectedId(initialArtifactId);
    setSelectedArtifact((current) => (current?.id === initialArtifactId ? current : null));
    setResolution(null);
  }, [initialArtifactId]);

  useEffect(() => {
    if (!initialRef) return;
    let cancelled = false;
    setDetailLoading(true);
    setError(null);
    setResolution(null);
    setSelectedArtifact(null);
    resolveArtifact(initialRef)
      .then((next) => {
        if (cancelled) return;
        setResolution(next);
        setSelectedArtifact(next.artifact);
        setSelectedId(next.artifact?.id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialRef]);

  useEffect(() => {
    if (!selectedId || initialRef) return;
    let cancelled = false;
    setDetailLoading(true);
    setError(null);
    getArtifact(selectedId)
      .then((artifact) => {
        if (cancelled) return;
        setSelectedArtifact(artifact);
        setResolution(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, initialRef]);

  useEffect(() => {
    if (!selectedArtifact) {
      setArtifactContent(null);
      setKnowledgeBackrefs([]);
      setContentError(null);
      setKnowledgeError(null);
      setContentLoading(false);
      setKnowledgeLoading(false);
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

  useEffect(() => {
    if (!selectedArtifact) {
      setKnowledgeBackrefs([]);
      setKnowledgeError(null);
      setKnowledgeLoading(false);
      return;
    }
    let cancelled = false;
    setKnowledgeLoading(true);
    setKnowledgeError(null);
    setKnowledgeBackrefs([]);
    getArtifactKnowledgeBackrefs(selectedArtifact.id)
      .then((backrefs) => {
        if (!cancelled) setKnowledgeBackrefs(backrefs);
      })
      .catch((err) => {
        if (!cancelled) setKnowledgeError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setKnowledgeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedArtifact?.id]);

  const facetOptions = useMemo(() => buildFacetOptions(facetArtifacts), [facetArtifacts]);

  const selectArtifact = (artifact: ArtifactRecord) => {
    setSelectedId(artifact.id);
    setSelectedArtifact(artifact);
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
      {!sidebarHidden ? (
        <>
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
                className={`artifacts-filter__advanced-trigger${advancedOpen ? ' artifacts-filter__advanced-trigger--active' : ''}`}
                onClick={() => setAdvancedOpen((open) => !open)}
                aria-label="Artifact filters"
                title="Artifact filters"
                aria-expanded={advancedOpen}
              >
                <FilterIcon />
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
              {loading && artifacts.length === 0 && <div className="artifacts-sidebar__empty">Loading artifacts...</div>}
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
        </>
      ) : null}
      <main className="artifacts-detail">
        {error && <div className="artifacts-error">{error}</div>}
        {detailLoading && !selectedArtifact && !resolution && <div className="artifacts-empty">Loading artifact...</div>}
        {!detailLoading && !selectedArtifact && !resolution && (
          <div className="artifacts-empty">Select an artifact or open an artifact URI.</div>
        )}
        {!detailLoading && resolution && !resolution.artifact && (
          <UnresolvedArtifact resolution={resolution} />
        )}
        {selectedArtifact && (
          <ArtifactDetail
            artifact={selectedArtifact}
            resolution={resolution}
            content={artifactContent}
            contentLoading={contentLoading}
            contentError={contentError}
            knowledgeBackrefs={knowledgeBackrefs}
            knowledgeLoading={knowledgeLoading}
            knowledgeError={knowledgeError}
          />
        )}
      </main>
    </div>
  );
}

function FilterIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 6h16M7 12h10M10 18h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function FacetSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}): JSX.Element {
  const renderedOptions = value && !options.includes(value)
    ? [...options, value].sort()
    : options;
  return (
    <label className="artifacts-advanced__field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        <option value="">Any</option>
        {renderedOptions.map((option) => <option key={option} value={option}>{option}</option>)}
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
  knowledgeBackrefs,
  knowledgeLoading,
  knowledgeError,
}: {
  artifact: ArtifactRecord;
  resolution: ArtifactResolveResult | null;
  content: ArtifactContentResult | null;
  contentLoading: boolean;
  contentError: string | null;
  knowledgeBackrefs: KnowledgeBackrefRecord[];
  knowledgeLoading: boolean;
  knowledgeError: string | null;
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
      <PreviewSection
        preview={preview}
        content={content}
        contentLoading={contentLoading}
        contentError={contentError}
      />
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
      {(knowledgeLoading || knowledgeError || knowledgeBackrefs.length > 0) && (
        <section className="artifact-detail__section">
          <h3>Knowledge Backrefs</h3>
          {knowledgeLoading && <div className="artifacts-empty">Loading knowledge references...</div>}
          {!knowledgeLoading && knowledgeError && <div className="artifacts-error">{knowledgeError}</div>}
          {!knowledgeLoading && !knowledgeError && knowledgeBackrefs.length > 0 && (
            <div className="artifact-detail__list">
              {knowledgeBackrefs.map((backref) => (
                <div key={backref.id} className="artifact-detail__list-item artifact-detail__list-item--backref">
                  <code>{backref.external_ref || backref.external_id}</code>
                  <span>{backref.ref_type}</span>
                  <span>{backref.provider_id}</span>
                  <span>{backref.status}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </article>
  );
}

function PreviewSection({
  preview,
  content,
  contentLoading,
  contentError,
}: {
  preview: ArtifactPreview | null;
  content: ArtifactContentResult | null;
  contentLoading: boolean;
  contentError: string | null;
}): JSX.Element {
  return (
    <section className="artifact-detail__section">
      <h3>Preview</h3>
      {contentLoading && <div className="artifacts-empty">Loading preview...</div>}
      {!contentLoading && contentError && <div className="artifacts-error">{contentError}</div>}
      {!contentLoading && !contentError && content?.warnings?.map((warning) => (
        <div key={warning} className="artifact-detail__warning">{warning}</div>
      ))}
      {!contentLoading && !contentError && preview?.kind === 'bundle' && <BundlePreview preview={preview} />}
      {!contentLoading && !contentError && preview?.kind === 'json' && <pre className="artifact-preview"><code>{preview.value}</code></pre>}
      {!contentLoading && !contentError && preview?.kind === 'text' && <pre className="artifact-preview"><code>{preview.value}</code></pre>}
      {!contentLoading && !contentError && preview?.kind === 'html' && (
        <iframe
          className="artifact-preview artifact-preview--html"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={preview.value}
          title="Artifact HTML preview"
        />
      )}
      {!contentLoading && !contentError && preview?.kind === 'markdown' && (
        <div className="artifact-preview spec-panel" dangerouslySetInnerHTML={{ __html: preview.value }} />
      )}
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
  );
}

function BundlePreview({ preview }: { preview: Extract<ArtifactPreview, { kind: 'bundle' }> }): JSX.Element {
  return (
    <div className="artifact-preview-bundle">
      <div className="artifact-detail__hint">
        {preview.name ? `${preview.name}: ` : ''}{preview.members.length} member{preview.members.length === 1 ? '' : 's'}
      </div>
      {preview.members.length > 0 ? (
        <div className="artifact-detail__list artifact-detail__list--bundle">
          {preview.members.map((member) => (
            <a
              key={`${member.artifactId}:${member.order}`}
              className="artifact-detail__list-item artifact-detail__list-item--bundle"
              href={artifactDetailHref(member.artifactId)}
            >
              <code>{member.artifactId}</code>
              <span>{member.role || 'member'}</span>
              <span>{member.recoverability || 'recoverability unknown'}</span>
            </a>
          ))}
        </div>
      ) : (
        <div className="artifacts-empty">Bundle manifest has no members.</div>
      )}
      <details className="artifact-preview__details">
        <summary>Manifest JSON</summary>
        <pre className="artifact-preview"><code>{preview.manifestText}</code></pre>
      </details>
    </div>
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
          ['Source', resolution.alias?.source ?? ''],
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
    for (const scheme of artifact.alias_schemes ?? []) {
      schemes.add(scheme);
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
  const repoLocator = artifactRepoLocator(artifact);
  return artifactTitleCandidate(metadataTitle)
    || artifactTitleCandidate(logicalName)
    || filename
    || repoLocator
    || artifact.role
    || compactArtifactRef(artifact.content_hash);
}

function artifactRepoLocator(artifact: ArtifactRecord): string {
  const repoId = typeof artifact.repo_locator.repo_id === 'string' ? artifact.repo_locator.repo_id : '';
  const repoPath = typeof artifact.repo_locator.path === 'string' ? artifact.repo_locator.path : '';
  if (!repoId || !repoPath) return '';
  const ref = typeof artifact.repo_locator.ref === 'string' ? artifact.repo_locator.ref : '';
  return `repo://${repoId}${ref ? `@${ref}` : ''}/${repoPath.replace(/^\/+/, '')}`;
}

function artifactTitleCandidate(value: string): string {
  return value && displayArtifactRef(value) === value ? value : '';
}

function artifactPreview(content: ArtifactContentResult): ArtifactPreview {
  if (content.kind === 'json' && content.preview) {
    const bundle = artifactBundlePreview(content.preview.text);
    if (bundle) return bundle;
    return { kind: 'json', value: content.preview.text };
  }
  if (content.kind === 'html' && content.preview) {
    return { kind: 'html', value: content.preview.text };
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

function artifactBundlePreview(text: string): Extract<ArtifactPreview, { kind: 'bundle' }> | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(manifest) || manifest.schema_version !== 'mandible.artifact_bundle.v1') return null;
  const members = Array.isArray(manifest.members) ? manifest.members : [];
  return {
    kind: 'bundle',
    manifestText: text,
    name: stringValue(manifest.name),
    members: members.map((member, index): BundleMemberPreview | null => {
      if (!isRecord(member)) return null;
      const artifactId = stringValue(member.artifact_id);
      if (!artifactId) return null;
      return {
        artifactId,
        role: stringValue(member.role),
        recoverability: stringValue(member.recoverability),
        order: typeof member.order === 'number' ? member.order : index,
      };
    }).filter((member): member is BundleMemberPreview => Boolean(member)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
