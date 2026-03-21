// Bug: 11f4f47 — Reusable preset pill selector for NewSessionDialog and chat sidebar
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Preset } from '../../api';

type PresetPillSelectorProps = {
  selectedPresetIds: string[];
  onChange: (ids: string[]) => void;
  presets: Preset[];
  disabled?: boolean;
};

function NavIcon({ presetId }: { presetId: string }): JSX.Element {
  return (
    <button
      type="button"
      className="preset-pill__nav"
      title="View preset"
      onClick={(e) => {
        e.stopPropagation();
        window.location.hash = `#/presets?id=${encodeURIComponent(presetId)}`;
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path
          d="M4.5 2.5L8 6L4.5 9.5"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  );
}

export function PresetPillSelector({
  selectedPresetIds,
  onChange,
  presets,
  disabled = false,
}: PresetPillSelectorProps): JSX.Element {
  const [searchText, setSearchText] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const unselected = presets.filter(
    (p) => !selectedPresetIds.includes(p.id),
  );
  const filtered = searchText.trim()
    ? unselected.filter((p) =>
        p.name.toLowerCase().includes(searchText.toLowerCase()),
      )
    : unselected;

  useEffect(() => {
    setHighlightIndex(0);
  }, [searchText]);

  // Close dropdown on click outside
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [dropdownOpen]);

  const addPreset = (id: string) => {
    if (!selectedPresetIds.includes(id)) {
      onChange([...selectedPresetIds, id]);
    }
    setSearchText('');
    setDropdownOpen(false);
    inputRef.current?.focus();
  };

  const removePreset = (id: string) => {
    onChange(selectedPresetIds.filter((pid) => pid !== id));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setDropdownOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setDropdownOpen(true);
      setHighlightIndex((prev) => Math.min(prev + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (e.key === 'Enter' && dropdownOpen && filtered[highlightIndex]) {
      e.preventDefault();
      addPreset(filtered[highlightIndex].id);
    }
  };

  const selectedPresets = selectedPresetIds
    .map((id) => presets.find((p) => p.id === id))
    .filter((p): p is Preset => p !== undefined);

  return (
    <div className="preset-pill-selector" ref={containerRef}>
      <div className="preset-pill-selector__input-row">
        <input
          ref={inputRef}
          type="text"
          className="preset-pill-selector__input"
          placeholder={selectedPresetIds.length > 0 ? 'Add preset...' : 'Search presets...'}
          value={searchText}
          disabled={disabled}
          onInput={(e) => {
            setSearchText(e.currentTarget.value);
            setDropdownOpen(true);
          }}
          onFocus={() => setDropdownOpen(true)}
          onKeyDown={handleKeyDown}
        />
      </div>

      {dropdownOpen && filtered.length > 0 && (
        <div className="preset-pill-selector__dropdown">
          {filtered.map((preset, idx) => (
            <button
              key={preset.id}
              type="button"
              className={`preset-pill-selector__option${idx === highlightIndex ? ' preset-pill-selector__option--highlight' : ''}`}
              onClick={() => addPreset(preset.id)}
              onMouseEnter={() => setHighlightIndex(idx)}
            >
              <span className="preset-pill-selector__option-name">{preset.name}</span>
              {preset.description && (
                <span className="preset-pill-selector__option-desc">{preset.description}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {selectedPresets.length > 0 ? (
        <div className="preset-pill-selector__pills">
          {selectedPresets.map((preset) => (
            <span key={preset.id} className="preset-pill">
              <span className="preset-pill__name">{preset.name}</span>
              <NavIcon presetId={preset.id} />
              <button
                type="button"
                className="preset-pill__dismiss"
                disabled={disabled}
                onClick={() => removePreset(preset.id)}
                title="Remove preset"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="preset-pill-selector__empty">
          No presets selected. Import from CLAUDE.md or create a preset.
        </div>
      )}
    </div>
  );
}
