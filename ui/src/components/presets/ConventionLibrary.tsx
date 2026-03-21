// Bug: e20c88e — Convention library flat view
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import { sanitizeHtml } from '../../sanitize';
import type { LibraryConvention } from '../../types/presets';
import { fetchConventionLibrary } from '../../api';

export type ConventionLibraryProps = {
  selectedPresetId: string | null;
  onAddToPreset: (convention: LibraryConvention) => void;
};

function renderMarkdown(src: string): string {
  if (!src) return '';
  const result = marked.parse(src, { async: false });
  return typeof result === 'string' ? result : '';
}


export function ConventionLibrary({
  selectedPresetId,
  onAddToPreset,
}: ConventionLibraryProps): JSX.Element {
  const [conventions, setConventions] = useState<LibraryConvention[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showBreadcrumbs, setShowBreadcrumbs] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mandible_convention_breadcrumbs') === 'true';
    } catch {
      return false;
    }
  });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadConventions = useCallback((query: string) => {
    setLoading(true);
    fetchConventionLibrary(query || undefined, 100)
      .then((items) => {
        setConventions(items);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    loadConventions('');
  }, [loadConventions]);

  const handleSearchInput = useCallback((value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      loadConventions(value);
    }, 200);
  }, [loadConventions]);

  // Dedup: group by body content
  const deduped = conventions.reduce<Map<string, LibraryConvention & { usedIn: string[] }>>((acc, conv) => {
    const key = conv.body.trim();
    const existing = acc.get(key);
    if (existing) {
      if (!existing.usedIn.includes(conv.preset_name)) {
        existing.usedIn.push(conv.preset_name);
      }
    } else {
      acc.set(key, { ...conv, usedIn: conv.source_presets?.length ? conv.source_presets : [conv.preset_name] });
    }
    return acc;
  }, new Map());

  const dedupedList = Array.from(deduped.values());

  return (
    <div className="convention-library">
      <div className="convention-library__header">
        <h2 className="convention-library__title">Convention Library</h2>
        <p className="text-muted" style={{ margin: '4px 0 0', fontSize: '13px' }}>
          Browse all leaf conventions across presets
        </p>
      </div>

      <div className="convention-library__search">
        <input
          type="text"
          className="convention-library__search-input"
          placeholder="Search conventions..."
          value={search}
          onInput={(e) => handleSearchInput((e.target as HTMLInputElement).value)}
        />
        <label className="convention-library__breadcrumb-toggle" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--fg-muted)', cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={showBreadcrumbs}
            onChange={(e) => {
              const val = (e.target as HTMLInputElement).checked;
              setShowBreadcrumbs(val);
              try { localStorage.setItem('mandible_convention_breadcrumbs', String(val)); } catch {}
            }}
            style={{ margin: 0 }}
          />
          Show paths
        </label>
      </div>

      {loading ? (
        <div className="convention-library__loading">
          <span className="text-muted">Loading...</span>
        </div>
      ) : dedupedList.length === 0 ? (
        <div className="convention-library__empty">
          <p className="text-muted">
            {search
              ? 'No conventions match your search.'
              : 'No conventions found. Create a preset or import from CLAUDE.md.'}
          </p>
        </div>
      ) : (
        <div className="convention-library__list">
          {dedupedList.map((conv) => {
            const isExpanded = expandedId === conv.id;
            const bodyPreview = conv.body.slice(0, 80).replace(/\n/g, ' ');

            return (
              <div
                key={conv.id}
                className={`convention-library__card${isExpanded ? ' convention-library__card--expanded' : ''}`}
              >
                <div
                  className="convention-library__card-header"
                  onClick={() => setExpandedId(isExpanded ? null : conv.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpandedId(isExpanded ? null : conv.id);
                    }
                  }}
                >
                  <div className="convention-library__card-info">
                    {showBreadcrumbs && conv.breadcrumb && conv.breadcrumb.length > 0 && (
                      <span className="convention-library__card-breadcrumb text-muted">
                        {conv.breadcrumb.join(' \u203a ')}
                      </span>
                    )}
                    <span className="convention-library__card-title">{conv.title}</span>
                    {!isExpanded && (
                      <span className="convention-library__card-preview text-muted">
                        {bodyPreview}{conv.body.length > 80 ? '...' : ''}
                      </span>
                    )}
                  </div>
                  <div className="convention-library__card-meta">
                    {conv.usedIn && conv.usedIn.length > 0 && (
                      <span className="convention-library__card-source text-muted">
                        {conv.usedIn.length === 1
                          ? conv.usedIn[0]
                          : `Used in: ${conv.usedIn.join(', ')}`}
                      </span>
                    )}
                    {selectedPresetId && (
                      <button
                        type="button"
                        className="convention-library__add-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddToPreset(conv);
                        }}
                        title="Add to current preset"
                      >
                        + Add
                      </button>
                    )}
                  </div>
                </div>
                {isExpanded && (
                  <div
                    className="convention-library__card-body"
                    dangerouslySetInnerHTML={{
                      __html: sanitizeHtml(renderMarkdown(conv.body)),
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
