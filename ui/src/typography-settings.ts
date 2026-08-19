import type { UserTypographySetting, UserTypographySettingKey } from './api';

export type TypographyFace = 'system-ui' | 'space-grotesk';
export type TypographySettings = {
  uiFontFace: TypographyFace;
  uiFontSize: number;
  detailFontFace: TypographyFace;
  detailFontSize: number;
};

export const TYPOGRAPHY_SETTING_KEYS = [
  'ui_font_face',
  'ui_font_size',
  'detail_font_face',
  'detail_font_size',
] as const satisfies readonly UserTypographySettingKey[];

export const DEFAULT_TYPOGRAPHY_SETTINGS: TypographySettings = Object.freeze({
  uiFontFace: 'system-ui',
  uiFontSize: 14,
  detailFontFace: 'system-ui',
  detailFontSize: 12,
});

export function normalizeTypographySetting(
  key: UserTypographySettingKey,
  value: string | null | undefined,
): string {
  if (key === 'ui_font_face' || key === 'detail_font_face') {
    return value === 'space-grotesk' ? value : 'system-ui';
  }
  const fallback = key === 'ui_font_size'
    ? DEFAULT_TYPOGRAPHY_SETTINGS.uiFontSize
    : DEFAULT_TYPOGRAPHY_SETTINGS.detailFontSize;
  const size = Number(value);
  return Number.isInteger(size) && size >= 10 && size <= 20 ? String(size) : String(fallback);
}

export function withTypographySetting(
  current: TypographySettings,
  key: UserTypographySettingKey,
  value: string | null | undefined,
): TypographySettings {
  const normalized = normalizeTypographySetting(key, value);
  switch (key) {
    case 'ui_font_face': return { ...current, uiFontFace: normalized as TypographyFace };
    case 'ui_font_size': return { ...current, uiFontSize: Number(normalized) };
    case 'detail_font_face': return { ...current, detailFontFace: normalized as TypographyFace };
    case 'detail_font_size': return { ...current, detailFontSize: Number(normalized) };
  }
}

export function typographySettingValue(
  settings: TypographySettings,
  key: UserTypographySettingKey,
): string {
  switch (key) {
    case 'ui_font_face': return settings.uiFontFace;
    case 'ui_font_size': return String(settings.uiFontSize);
    case 'detail_font_face': return settings.detailFontFace;
    case 'detail_font_size': return String(settings.detailFontSize);
  }
}

export function typographyCssVariables(settings: TypographySettings): Record<string, string> {
  const family = (face: TypographyFace) => face === 'space-grotesk'
    ? "'Space Grotesk', system-ui, sans-serif"
    : "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  return {
    '--font-ui': family(settings.uiFontFace),
    '--font-ui-size': `${settings.uiFontSize}px`,
    '--font-detail': family(settings.detailFontFace),
    '--font-detail-size': `${settings.detailFontSize}px`,
  };
}

export function reconcileTypographySettings(
  current: TypographySettings,
  revisions: Readonly<Record<UserTypographySettingKey, number>>,
  snapshots: readonly UserTypographySetting[],
): { settings: TypographySettings; revisions: Record<UserTypographySettingKey, number> } {
  const nextRevisions = { ...revisions };
  const settings = snapshots.reduce((next, snapshot) => {
    if (snapshot.revision < nextRevisions[snapshot.key]) return next;
    nextRevisions[snapshot.key] = snapshot.revision;
    return withTypographySetting(next, snapshot.key, snapshot.value);
  }, current);
  return { settings, revisions: nextRevisions };
}
