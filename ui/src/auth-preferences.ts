export const AUTH_AUTO_SHOW_CONSOLE_SETTING = 'auth.auto_show_console_on_approval';
export const AUTH_AUTO_RETURN_TO_OVERVIEW_SETTING = 'auth.auto_return_to_overview_on_success';
export const AUTH_RETAIN_FINALIZED_SELECTION_SETTING = 'auth.retain_finalized_selection';

export function enabledSetting(settings: Record<string, string>, key: string, defaultEnabled = true): boolean {
  return settings[key] == null ? defaultEnabled : settings[key] === 'true';
}
