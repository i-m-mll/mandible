import { createContext } from 'preact';
import { parseChatStreamMaxWidthPx } from '../../src/contracts';
import type { UserAppearanceSetting, UserAppearanceSettingKey } from './api';

export type AppearanceFace = 'system-ui' | 'space-grotesk';
export type AppearanceSettings = {
  chatStreamMaxWidthPx: number;
  uiFontFace: AppearanceFace;
  uiFontSize: number;
  detailFontFace: AppearanceFace;
  detailFontSize: number;
};

export const AppearanceSettingsContext = createContext<{ ready: boolean; error: string | null; retry: () => void }>({ ready: true, error: null, retry: () => {} });

export const APPEARANCE_SETTING_KEYS = [
  'chat_stream_max_width_px',
  'ui_font_face',
  'ui_font_size',
  'detail_font_face',
  'detail_font_size',
] as const satisfies readonly UserAppearanceSettingKey[];

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = Object.freeze({
  chatStreamMaxWidthPx: 0,
  uiFontFace: 'system-ui',
  uiFontSize: 14,
  detailFontFace: 'system-ui',
  detailFontSize: 12,
});

export function normalizeAppearanceSetting(
  key: UserAppearanceSettingKey,
  value: string | null | undefined,
): string {
  if (key === 'chat_stream_max_width_px') {
    return String(value == null ? 0 : parseChatStreamMaxWidthPx(value) ?? 0);
  }
  if (key === 'ui_font_face' || key === 'detail_font_face') {
    return value === 'space-grotesk' ? value : 'system-ui';
  }
  const fallback = key === 'ui_font_size'
    ? DEFAULT_APPEARANCE_SETTINGS.uiFontSize
    : DEFAULT_APPEARANCE_SETTINGS.detailFontSize;
  const size = Number(value);
  return Number.isInteger(size) && size >= 10 && size <= 20 ? String(size) : String(fallback);
}

export function withAppearanceSetting(
  current: AppearanceSettings,
  key: UserAppearanceSettingKey,
  value: string | null | undefined,
): AppearanceSettings {
  if (key === 'chat_stream_max_width_px' && value != null && parseChatStreamMaxWidthPx(value) === null) return current;
  const normalized = normalizeAppearanceSetting(key, value);
  switch (key) {
    case 'chat_stream_max_width_px': return { ...current, chatStreamMaxWidthPx: Number(normalized) };
    case 'ui_font_face': return { ...current, uiFontFace: normalized as AppearanceFace };
    case 'ui_font_size': return { ...current, uiFontSize: Number(normalized) };
    case 'detail_font_face': return { ...current, detailFontFace: normalized as AppearanceFace };
    case 'detail_font_size': return { ...current, detailFontSize: Number(normalized) };
  }
}

export function appearanceSettingValue(
  settings: AppearanceSettings,
  key: UserAppearanceSettingKey,
): string {
  switch (key) {
    case 'chat_stream_max_width_px': return String(settings.chatStreamMaxWidthPx);
    case 'ui_font_face': return settings.uiFontFace;
    case 'ui_font_size': return String(settings.uiFontSize);
    case 'detail_font_face': return settings.detailFontFace;
    case 'detail_font_size': return String(settings.detailFontSize);
  }
}

export function appearanceCssVariables(settings: AppearanceSettings): Record<string, string> {
  const family = (face: AppearanceFace) => face === 'space-grotesk'
    ? "'Space Grotesk', system-ui, sans-serif"
    : "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  return {
    '--chat-stream-max-width': settings.chatStreamMaxWidthPx > 0 ? `${settings.chatStreamMaxWidthPx}px` : 'none',
    '--font-ui': family(settings.uiFontFace),
    '--font-ui-size': `${settings.uiFontSize}px`,
    '--font-detail': family(settings.detailFontFace),
    '--font-detail-size': `${settings.detailFontSize}px`,
  };
}

export function reconcileAppearanceSettings(
  current: AppearanceSettings,
  revisions: Readonly<Record<UserAppearanceSettingKey, number>>,
  snapshots: readonly UserAppearanceSetting[],
): { settings: AppearanceSettings; revisions: Record<UserAppearanceSettingKey, number> } {
  const nextRevisions = { ...revisions };
  const settings = snapshots.reduce((next, snapshot) => {
    if (snapshot.revision < nextRevisions[snapshot.key]) return next;
    nextRevisions[snapshot.key] = snapshot.revision;
    return withAppearanceSetting(next, snapshot.key, snapshot.value);
  }, current);
  return { settings, revisions: nextRevisions };
}
