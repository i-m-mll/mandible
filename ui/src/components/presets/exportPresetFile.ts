// Bug: 11f4f47 — Export preset as downloadable Markdown file
import { exportPreset } from '../../api';

export async function exportPresetFile(presetId: string, presetName: string): Promise<void> {
  const markdown = await exportPreset(presetId);
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${presetName.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
