// Bug: 11f4f47 — Import preset dialog: file picker or paste-Markdown textarea
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useRef, useState } from 'preact/hooks';
import { importPreset } from '../../api';
import type { Preset } from '../../api';

type ImportPresetDialogProps = {
  open: boolean;
  onClose: () => void;
  onImported: (preset: Preset) => void;
  existingNames: string[];
};

export function ImportPresetDialog({
  open,
  onClose,
  onImported,
  existingNames,
}: ImportPresetDialogProps): JSX.Element | null {
  const [markdown, setMarkdown] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Bug: 11f4f47 — Close dialog on Escape keypress
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleFileChange = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    setMarkdown(text);
  };

  const handleSubmit = async () => {
    if (!markdown.trim()) return;
    setImporting(true);
    setError(null);
    try {
      const preset = await importPreset(markdown);
      onImported(preset);
      setMarkdown('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handleOverlayClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  // Check for potential name collision in the pasted content
  const nameMatch = markdown.match(/^#\s+(.+)/m);
  const detectedName = nameMatch?.[1]?.trim();
  const hasCollision = detectedName && existingNames.includes(detectedName);

  return (
    <div className="new-session-dialog-overlay" onClick={handleOverlayClick}>
      <div className="new-session-dialog" style={{ width: 'min(640px, calc(100vw - 32px))' }}>
        <h3>Import Preset</h3>
        <p className="new-session-dialog__intro">
          Paste Markdown content or pick a file to import as a preset.
        </p>

        <div className="new-session-dialog__field">
          <label className="new-session-dialog__label">File</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.txt"
            onChange={handleFileChange}
            style={{
              fontSize: '13px',
              color: 'var(--text-muted)',
            }}
          />
        </div>

        <div className="new-session-dialog__field">
          <label className="new-session-dialog__label">Markdown content</label>
          <textarea
            className="new-session-dialog__input"
            value={markdown}
            onInput={(e) => setMarkdown(e.currentTarget.value)}
            placeholder="Paste preset Markdown here..."
            rows={12}
            style={{
              resize: 'vertical',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              lineHeight: '1.5',
            }}
          />
        </div>

        {hasCollision && (
          <div style={{
            background: 'var(--status-warning-bg-soft)',
            border: '1px solid var(--status-warning-border-soft)',
            borderRadius: '8px',
            padding: '8px 12px',
            fontSize: '12px',
            color: 'var(--accent-yellow)',
          }}>
            A preset named "{detectedName}" already exists. Importing will create a new version.
          </div>
        )}

        {error && (
          <div style={{
            background: 'var(--status-danger-bg-soft)',
            border: '1px solid var(--status-danger-border-soft)',
            borderRadius: '8px',
            padding: '8px 12px',
            fontSize: '12px',
            color: 'var(--accent-red)',
          }}>
            {error}
          </div>
        )}

        <div className="new-session-dialog__actions">
          <button
            type="button"
            onClick={onClose}
            className="new-session-dialog__button new-session-dialog__button--ghost"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { void handleSubmit(); }}
            disabled={!markdown.trim() || importing}
            className="new-session-dialog__button new-session-dialog__button--primary"
          >
            {importing ? 'Importing...' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
