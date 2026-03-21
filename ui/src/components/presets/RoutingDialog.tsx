// Bug: e20c88e — Promotion/routing dialog for preset diffs
import { useRef, useState } from 'preact/hooks';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { Preset, PresetDiff } from '../../types/presets';

export type RoutingDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  diffs: PresetDiff[];
  presets: Preset[];
  recommendedPresetId: string | null;
  reasoning: {
    confidence: number;
    reason: string;
  } | null;
  onSessionOnly: () => void;
  onSaveToPreset: (presetId: string) => void;
  onProposeClaudeMd: () => void;
  isClaudeMdPreset: boolean;
};

export function RoutingDialog({
  isOpen,
  onClose,
  diffs,
  presets,
  recommendedPresetId,
  reasoning,
  onSessionOnly,
  onSaveToPreset,
  onProposeClaudeMd,
  isClaudeMdPreset,
}: RoutingDialogProps): JSX.Element | null {
  const [selectedPresetId, setSelectedPresetId] = useState(recommendedPresetId || '');
  const overlayRef = useRef<HTMLDivElement>(null);

  useFocusTrap(overlayRef, isOpen);

  if (!isOpen) return null;

  const diffSummary = diffs.map((d) => {
    const title = d.new_title || d.old_title || '(untitled)';
    const prefix = d.change_type === 'added' ? '+' : d.change_type === 'deleted' ? '-' : '~';
    return `${prefix} ${title}`;
  }).join('\n');

  return (
    <div
      ref={overlayRef}
      className="routing-dialog__overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="routing-dialog">
        <h3 className="routing-dialog__title">Save Convention Changes</h3>

        {reasoning && (
          <div className="routing-dialog__reasoning">
            <div className="routing-dialog__confidence">
              <span className="text-muted">Confidence:</span>{' '}
              <span className={`routing-dialog__confidence-value routing-dialog__confidence-value--${reasoning.confidence > 0.7 ? 'high' : reasoning.confidence > 0.4 ? 'medium' : 'low'}`}>
                {Math.round(reasoning.confidence * 100)}%
              </span>
            </div>
            <p className="routing-dialog__reason text-muted">{reasoning.reason}</p>
          </div>
        )}

        <div className="routing-dialog__diff-preview">
          <pre className="routing-dialog__diff-code">{diffSummary}</pre>
        </div>

        <div className="routing-dialog__actions">
          <button
            type="button"
            className="routing-dialog__action-btn routing-dialog__action-btn--session"
            onClick={() => {
              onSessionOnly();
              onClose();
            }}
          >
            This chat only
          </button>

          {isClaudeMdPreset ? (
            <button
              type="button"
              className="routing-dialog__action-btn routing-dialog__action-btn--propose"
              onClick={() => {
                onProposeClaudeMd();
                onClose();
              }}
            >
              Propose change to CLAUDE.md
            </button>
          ) : (
            <div className="routing-dialog__save-group">
              <select
                className="routing-dialog__preset-select"
                value={selectedPresetId}
                onChange={(e) => setSelectedPresetId((e.target as HTMLSelectElement).value)}
              >
                <option value="">Select preset...</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.id === recommendedPresetId ? ' (recommended)' : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="routing-dialog__action-btn routing-dialog__action-btn--save"
                disabled={!selectedPresetId}
                onClick={() => {
                  if (selectedPresetId) {
                    onSaveToPreset(selectedPresetId);
                    onClose();
                  }
                }}
              >
                Save to preset
              </button>
            </div>
          )}

          <button
            type="button"
            className="routing-dialog__cancel-btn"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
