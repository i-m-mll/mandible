import { useEffect, useState } from 'preact/hooks';
import { CHROME_SHADOW_LIMITS, exportChromeShadows, type ChromeShadowParameters } from '../../chrome-shadow';
import type { ChromeShadowPreviewController } from '../../hooks/useChromeShadowPreview';

function ParameterInput({ name, field, controller, percent = false, helper }: {
  name: string;
  field: keyof ChromeShadowParameters;
  controller: ChromeShadowPreviewController;
  percent?: boolean;
  helper?: string;
}): JSX.Element {
  const scale = percent ? 100 : 1;
  const value = Number((controller.themes[controller.theme][field] * scale).toFixed(6));
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value, controller.theme]);
  const limits = CHROME_SHADOW_LIMITS[field];
  const update = (input: string) => {
    setDraft(input);
    if (!input.trim() || !Number.isFinite(Number(input))) return;
    controller.update({ ...controller.themes[controller.theme], [field]: Number(input) / scale });
  };
  return <div className="settings-view__select-row chrome-shadow-settings__parameter" data-settings-searchable>
    <div className="settings-view__select-info">
      <label className="settings-view__select-label" htmlFor={`chrome-shadow-${field}`}>{name}</label>
      {helper ? <p className="settings-view__select-desc" id={`chrome-shadow-${field}-hint`}>{helper}</p> : null}
    </div>
    <div className="chrome-shadow-settings__inputs">
      <input id={`chrome-shadow-${field}`} type="range" min={limits.min * scale} max={limits.max * scale} step={limits.step * scale}
        value={value} aria-describedby={helper ? `chrome-shadow-${field}-hint` : undefined}
        onInput={(event) => update(event.currentTarget.value)} />
      <input className="settings-view__number-input" type="number" aria-label={`${name} value`} min={limits.min * scale} max={limits.max * scale} step={limits.step * scale}
        value={draft} onInput={(event) => update(event.currentTarget.value)} onBlur={() => setDraft(String(value))} />
      <span aria-hidden="true">{percent ? '%' : field === 'widthPx' ? 'px' : ''}</span>
    </div>
  </div>;
}

export function ChromeShadowSettings({ controller }: { controller: ChromeShadowPreviewController }): JSX.Element {
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const parameters = exportChromeShadows(controller.themes);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(parameters);
      setCopyFeedback('Parameters copied.');
    } catch {
      setCopyFeedback('Could not copy. Select the parameters below to copy them.');
    }
  };
  return <div className="settings-view__section-body chrome-shadow-settings">
    <div className="settings-view__select-row" data-settings-searchable>
      <label htmlFor="chrome-shadow-theme" className="settings-view__select-label">Preview theme</label>
      <select className="settings-view__select settings-view__select--compact" id="chrome-shadow-theme" value={controller.theme} onChange={(event) => controller.selectTheme(event.currentTarget.value as 'light' | 'dark')}>
        <option value="light">Light</option><option value="dark">Dark</option>
      </select>
    </div>
    <ParameterInput name="Width" field="widthPx" controller={controller} />
    <ParameterInput name="Profile" field="profile" controller={controller} helper="0: first pixel only · 1: linear." />
    <ParameterInput name="Maximum darkness" field="maxDarkness" controller={controller} percent />
    {controller.theme === 'dark' && controller.themes.dark.maxDarkness === 0 ? <p className="settings-view__select-desc" data-settings-searchable>Dark shadow is off</p> : null}
    <div className="chrome-shadow-settings__export" data-settings-searchable>
      <div className="chrome-shadow-settings__actions">
        <button className="btn btn--sm" type="button" onClick={() => { controller.reset(); setCopyFeedback(null); }}>Reset</button>
        <button className="btn btn--sm" type="button" onClick={() => void copy()}>Copy parameters</button>
        {copyFeedback ? <span role="status">{copyFeedback}</span> : null}
      </div>
      <textarea aria-label="Chrome shadow parameters" readOnly rows={3} value={parameters} onFocus={(event) => event.currentTarget.select()} />
    </div>
    {controller.persistenceError ? <p role="alert">{controller.persistenceError}</p> : null}
  </div>;
}
