// Bug: e20c88e — Preset diff view component
import { useState } from 'preact/hooks';
import { marked } from 'marked';
import type { PresetDiff } from '../../types/presets';

export type PresetDiffViewProps = {
  diffs: PresetDiff[];
  onAccept: (diffId: string) => void;
  onReject: (diffId: string) => void;
};

function renderMarkdown(src: string): string {
  if (!src) return '';
  const result = marked.parse(src, { async: false });
  return typeof result === 'string' ? result : '';
}

function sanitizeInlineHtml(html: string): string {
  let out = html.replace(
    /<(script|iframe|object|embed|form|style|svg|math)[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  out = out.replace(/<(script|iframe|object|embed|form|style|svg|math)[^>]*\/>/gi, '');
  out = out.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  out = out.replace(/\s+(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, '');
  return out;
}

const CHANGE_TYPE_CLASS: Record<string, string> = {
  added: 'preset-diff__item--added',
  modified: 'preset-diff__item--modified',
  deleted: 'preset-diff__item--deleted',
};

const CHANGE_TYPE_LABEL: Record<string, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
};

export function PresetDiffView({
  diffs,
  onAccept,
  onReject,
}: PresetDiffViewProps): JSX.Element {
  const [viewMode, setViewMode] = useState<'unified' | 'side-by-side'>('unified');

  if (diffs.length === 0) {
    return (
      <div className="preset-diff__empty">
        <p className="text-muted">No changes detected.</p>
      </div>
    );
  }

  return (
    <div className="preset-diff">
      <div className="preset-diff__header">
        <h3 className="preset-diff__title">Preset Changes</h3>
        <div className="preset-diff__view-toggle">
          <button
            type="button"
            className={`preset-diff__toggle-btn${viewMode === 'unified' ? ' preset-diff__toggle-btn--active' : ''}`}
            onClick={() => setViewMode('unified')}
          >
            Unified
          </button>
          <button
            type="button"
            className={`preset-diff__toggle-btn${viewMode === 'side-by-side' ? ' preset-diff__toggle-btn--active' : ''}`}
            onClick={() => setViewMode('side-by-side')}
          >
            Side by side
          </button>
        </div>
      </div>

      <div className="preset-diff__list">
        {diffs.map((diff) => (
          <div
            key={diff.id}
            className={`preset-diff__item ${CHANGE_TYPE_CLASS[diff.change_type] || ''}`}
          >
            <div className="preset-diff__item-header">
              <span className={`preset-diff__change-badge preset-diff__change-badge--${diff.change_type}`}>
                {CHANGE_TYPE_LABEL[diff.change_type] || diff.change_type}
              </span>
              <span className="preset-diff__item-title">
                {diff.new_title || diff.old_title || '(untitled)'}
              </span>
              {diff.status === 'pending' && (
                <div className="preset-diff__item-actions">
                  <button
                    type="button"
                    className="preset-diff__accept-btn"
                    onClick={() => onAccept(diff.id)}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="preset-diff__reject-btn"
                    onClick={() => onReject(diff.id)}
                  >
                    Reject
                  </button>
                </div>
              )}
              {diff.status !== 'pending' && (
                <span className={`preset-diff__status preset-diff__status--${diff.status}`}>
                  {diff.status}
                </span>
              )}
            </div>

            {viewMode === 'unified' ? (
              <div className="preset-diff__content-unified">
                {diff.change_type === 'deleted' && diff.old_body && (
                  <div
                    className="preset-diff__old"
                    dangerouslySetInnerHTML={{
                      __html: sanitizeInlineHtml(renderMarkdown(diff.old_body)),
                    }}
                  />
                )}
                {diff.change_type === 'modified' && (
                  <>
                    {diff.old_body && (
                      <div
                        className="preset-diff__old"
                        dangerouslySetInnerHTML={{
                          __html: sanitizeInlineHtml(renderMarkdown(diff.old_body)),
                        }}
                      />
                    )}
                    {diff.new_body && (
                      <div
                        className="preset-diff__new"
                        dangerouslySetInnerHTML={{
                          __html: sanitizeInlineHtml(renderMarkdown(diff.new_body)),
                        }}
                      />
                    )}
                  </>
                )}
                {diff.change_type === 'added' && diff.new_body && (
                  <div
                    className="preset-diff__new"
                    dangerouslySetInnerHTML={{
                      __html: sanitizeInlineHtml(renderMarkdown(diff.new_body)),
                    }}
                  />
                )}
              </div>
            ) : (
              <div className="preset-diff__content-side-by-side">
                <div className="preset-diff__side preset-diff__side--old">
                  {diff.old_body ? (
                    <div
                      dangerouslySetInnerHTML={{
                        __html: sanitizeInlineHtml(renderMarkdown(diff.old_body)),
                      }}
                    />
                  ) : (
                    <span className="text-muted">(empty)</span>
                  )}
                </div>
                <div className="preset-diff__side preset-diff__side--new">
                  {diff.new_body ? (
                    <div
                      dangerouslySetInnerHTML={{
                        __html: sanitizeInlineHtml(renderMarkdown(diff.new_body)),
                      }}
                    />
                  ) : (
                    <span className="text-muted">(empty)</span>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
