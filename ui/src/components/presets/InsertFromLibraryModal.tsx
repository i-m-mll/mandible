// Bug: e20c88e — Insert from Library command palette modal
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { LibraryConvention } from '../../types/presets';
import { fetchConventionLibrary } from '../../api';

export type InsertFromLibraryModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onInsert: (convention: LibraryConvention) => void;
};

export function InsertFromLibraryModal({
  isOpen,
  onClose,
  onInsert,
}: InsertFromLibraryModalProps): JSX.Element | null {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<LibraryConvention[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useFocusTrap(overlayRef, isOpen);

  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setSelectedIdx(0);
      setLoading(true);
      fetchConventionLibrary(undefined, 50)
        .then((items) => {
          setResults(items);
          setLoading(false);
        })
        .catch(() => setLoading(false));
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  const handleSearchInput = useCallback((value: string) => {
    setSearch(value);
    setSelectedIdx(0);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      fetchConventionLibrary(value || undefined, 50)
        .then((items) => {
          setResults(items);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }, 200);
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((prev) => Math.min(prev + 1, results.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault();
      onInsert(results[selectedIdx]);
      onClose();
    }
  }, [results, selectedIdx, onClose, onInsert]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.children[selectedIdx] as HTMLElement | undefined;
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIdx]);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="insert-modal__overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="insert-modal" role="dialog" aria-label="Insert from library">
        <input
          ref={inputRef}
          type="text"
          className="insert-modal__search"
          placeholder="Search conventions to insert..."
          value={search}
          onInput={(e) => handleSearchInput((e.target as HTMLInputElement).value)}
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={results.length > 0}
          aria-activedescendant={results.length > 0 ? `insert-result-${selectedIdx}` : undefined}
          aria-controls="insert-modal-listbox"
        />
        <div ref={listRef} className="insert-modal__results" id="insert-modal-listbox" role="listbox">
          {loading ? (
            <div className="insert-modal__loading text-muted">Searching...</div>
          ) : results.length === 0 ? (
            <div className="insert-modal__empty text-muted">No conventions found</div>
          ) : (
            results.map((conv, idx) => (
              <div
                key={conv.id}
                id={`insert-result-${idx}`}
                role="option"
                aria-selected={idx === selectedIdx}
                className={`insert-modal__result${idx === selectedIdx ? ' insert-modal__result--selected' : ''}`}
                onClick={() => {
                  onInsert(conv);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIdx(idx)}
              >
                <span className="insert-modal__result-title">{conv.title}</span>
                <span className="insert-modal__result-meta text-muted">
                  {conv.preset_name}
                </span>
                <span className="insert-modal__result-preview text-muted">
                  {conv.body.split('\n')[0]?.slice(0, 60) || ''}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
