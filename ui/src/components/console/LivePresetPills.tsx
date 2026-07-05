// Bug: 11f4f47 — Live preset management for active SDK sessions in the chat sidebar
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useState } from 'preact/hooks';
import type { Preset } from '../../api';
import {
  getPresets,
  getSessionPresets,
  addSessionPreset,
  removeSessionPreset,
  getPresetUnion,
  updateConsoleSessionOptions,
} from '../../api';
import { PresetPillSelector } from '../presets/PresetPillSelector';

type LivePresetPillsProps = {
  sessionId: string;
  /** Bug: 790433d — When true, presets are displayed but not editable (PTY sessions). */
  readOnly?: boolean;
  onUnionUpdate?: (union: { totalTokens: number }) => void;
};

export function LivePresetPills({
  sessionId,
  readOnly = false,
  onUnionUpdate,
}: LivePresetPillsProps): JSX.Element {
  const [allPresets, setAllPresets] = useState<Preset[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const load = async () => {
      try {
        const [presets, sessionPresets] = await Promise.all([
          getPresets(),
          getSessionPresets(sessionId),
        ]);
        if (cancelled) return;
        setAllPresets(presets);
        // Sort by position to preserve composition order
        const sorted = [...sessionPresets].sort((a, b) => a.position - b.position);
        setSelectedIds(sorted.map((sp) => sp.preset_id));
      } catch {
        if (!cancelled) {
          setAllPresets([]);
          setSelectedIds([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [sessionId]);

  const handleChange = async (nextIds: string[]) => {
    const prevIds = selectedIds;
    setSelectedIds(nextIds);

    try {
      // Determine adds and removes
      const removed = prevIds.filter((id) => !nextIds.includes(id));
      const added = nextIds.filter((id) => !prevIds.includes(id));

      for (const id of removed) {
        await removeSessionPreset(sessionId, id);
      }
      for (const id of added) {
        await addSessionPreset(sessionId, id, nextIds.indexOf(id));
      }

      // Bug: 790433d — Recompute union and patch session options with presetIds
      // so the backend emits a preset_changed event and persists the change
      const union = await getPresetUnion({ session_id: sessionId });
      await updateConsoleSessionOptions(sessionId, {
        systemPrompt: union.systemPrompt,
        presetIds: nextIds,
      });
      // Bug: 11f4f47 — Notify parent of updated token count for ContextIndicator
      onUnionUpdate?.({ totalTokens: union.totalTokens });
    } catch {
      // Revert on error
      setSelectedIds(prevIds);
    }
  };

  if (loading) {
    return (
      <div className="session-controls__field" style={{ marginTop: '12px' }}>
        <span className="session-controls__label">Instructions</span>
        <div className="session-controls__placeholder">Loading instructions...</div>
      </div>
    );
  }

  return (
    <div className="session-controls__field" style={{ marginTop: '12px' }}>
      <span className="session-controls__label">
        Instructions
        {readOnly && (
          <span
            className="session-controls__lock-icon"
            title="Restart session to change presets"
          >
            {' \uD83D\uDD12'}
          </span>
        )}
      </span>
      {readOnly ? (
        <div className="session-controls__preset-readonly">
          {selectedIds.length === 0 ? (
            <span className="session-controls__placeholder">No instructions selected</span>
          ) : (
            selectedIds.map((id) => {
              const preset = allPresets.find((p) => p.id === id);
              return (
                <span key={id} className="session-controls__preset-pill">
                  {preset?.name ?? id.slice(0, 8)}
                </span>
              );
            })
          )}
        </div>
      ) : (
        <PresetPillSelector
          selectedPresetIds={selectedIds}
          onChange={(ids) => { void handleChange(ids); }}
          presets={allPresets}
        />
      )}
    </div>
  );
}
