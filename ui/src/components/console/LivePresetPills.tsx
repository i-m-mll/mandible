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
};

export function LivePresetPills({
  sessionId,
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

      // Recompute union and patch session options
      const union = await getPresetUnion({ session_id: sessionId });
      await updateConsoleSessionOptions(sessionId, {
        systemPrompt: union.systemPrompt,
      });
    } catch {
      // Revert on error
      setSelectedIds(prevIds);
    }
  };

  if (loading) {
    return (
      <div className="session-controls__field" style={{ marginTop: '12px' }}>
        <span className="session-controls__label">Presets</span>
        <div className="session-controls__placeholder">Loading presets...</div>
      </div>
    );
  }

  return (
    <div className="session-controls__field" style={{ marginTop: '12px' }}>
      <span className="session-controls__label">Presets</span>
      <PresetPillSelector
        selectedPresetIds={selectedIds}
        onChange={(ids) => { void handleChange(ids); }}
        presets={allPresets}
      />
    </div>
  );
}
