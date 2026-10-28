import { useEffect, useState } from 'preact/hooks';
import { NativeSelect } from '../shared/NativeSelect';
import { CHROME_APPEARANCE_LIMITS, exportChromeAppearances, type ChromeAppearanceParameters } from '../../chrome-appearance';
import type { ChromeAppearancePreviewController } from '../../hooks/useChromeAppearancePreview';
import './PreviewAppearancePanel.css';

function ParameterInput({ name, field, controller, percent = false, helper, disabled = false }: {
  name: string;
  field: keyof ChromeAppearanceParameters;
  controller: ChromeAppearancePreviewController;
  percent?: boolean;
  helper?: string;
  disabled?: boolean;
}): JSX.Element {
  const scale = percent ? 100 : 1;
  const value = Number((controller.themes[controller.theme][field] * scale).toFixed(6));
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value, controller.theme]);
  const limits = CHROME_APPEARANCE_LIMITS[field];
  const update = (input: string) => {
    setDraft(input);
    if (!input.trim() || !Number.isFinite(Number(input))) return;
    controller.update({ ...controller.themes[controller.theme], [field]: Number(input) / scale });
  };
  const hintId = helper ? `chrome-appearance-${field}-hint` : undefined;
  return <div className="preview-appearance-controls__parameter">
    <label htmlFor={`chrome-appearance-${field}`}>{name}</label>
    <div className="preview-appearance-controls__inputs">
      <input id={`chrome-appearance-${field}`} type="range" min={limits.min * scale} max={limits.max * scale} step={limits.step * scale}
        disabled={disabled} value={value} aria-describedby={hintId} onInput={(event) => update(event.currentTarget.value)} />
      <input className="preview-appearance-controls__number" type="number" aria-label={`${name} value`} aria-describedby={hintId}
        min={limits.min * scale} max={limits.max * scale} step={limits.step * scale} disabled={disabled}
        value={draft} onInput={(event) => update(event.currentTarget.value)} onBlur={() => setDraft(String(value))} />
      <span aria-hidden="true">{percent ? '%' : field === 'widthPx' ? 'px' : field === 'textIncrementPt' ? 'pt' : ''}</span>
    </div>
    {helper ? <p className="preview-appearance-controls__hint" id={hintId}>{helper}</p> : null}
  </div>;
}

export function ChromeAppearanceControls({ controller }: { controller: ChromeAppearancePreviewController }): JSX.Element {
  return <div className="preview-appearance-controls">
    <div className="preview-appearance-controls__theme">
      <label htmlFor="chrome-appearance-theme">Preview theme</label>
      <NativeSelect id="chrome-appearance-theme" value={controller.theme} onChange={(event) => controller.selectTheme(event.currentTarget.value as 'light' | 'dark')}>
        <option value="light">Light</option><option value="dark">Dark</option>
      </NativeSelect>
    </div>
    <ParameterInput name="UI font size" field="textIncrementPt" controller={controller} helper="Points added to sidebar and top-bar text." />
    <ParameterInput name="Shadow width" field="widthPx" controller={controller} />
    <ParameterInput name="Profile" field="profile" controller={controller} helper="0: first pixel only · 1: linear." />
    <ParameterInput name="Maximum darkness" field="maxDarkness" controller={controller} percent />
    <ParameterInput name="Liquid Glass transparency" field="glassTransparency" controller={controller} percent disabled={!controller.liquidGlassAvailable}
      helper={controller.liquidGlassAvailable ? 'Reveals native glass through the chrome tint.' : 'Available in the macOS preview window.'} />
    {controller.theme === 'dark' && controller.themes.dark.maxDarkness === 0 ? <p className="preview-appearance-controls__hint">Dark shadow is off</p> : null}
    {controller.persistenceError ? <p role="alert">{controller.persistenceError}</p> : null}
  </div>;
}

export function ChromeAppearanceActions({ controller }: { controller: ChromeAppearancePreviewController }): JSX.Element {
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const parameters = exportChromeAppearances(controller.themes);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(parameters);
      setCopyFeedback('Parameters copied.');
    } catch {
      setExportOpen(true);
      setCopyFeedback('Could not copy. Select the parameters below to copy them.');
    }
  };
  return <div className="preview-appearance-controls__export">
    <div className="preview-appearance-controls__actions">
      <button className="btn btn--sm" type="button" onClick={() => { controller.reset(); setCopyFeedback(null); }}>Reset</button>
      <button className="btn btn--sm" type="button" onClick={() => void copy()}>Copy parameters</button>
    </div>
    {copyFeedback ? <span role="status">{copyFeedback}</span> : null}
    <details open={exportOpen} onToggle={(event) => setExportOpen(event.currentTarget.open)}>
      <summary>Parameters</summary>
      <textarea aria-label="Chrome parameters" readOnly rows={3} value={parameters} onFocus={(event) => event.currentTarget.select()} />
    </details>
  </div>;
}
