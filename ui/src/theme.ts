export const appColors = {
  accentBlue: 'var(--accent-blue)',
  accentGreen: 'var(--accent-green)',
  accentPurple: 'var(--accent-purple)',
  accentRed: 'var(--accent-red)',
  accentYellow: 'var(--accent-yellow)',
  authResultCompleted: 'var(--auth-result-completed)',
  authResultCompletedBg: 'var(--auth-result-completed-bg)',
  authResultNeutral: 'var(--auth-result-neutral)',
  authResultNeutralBg: 'var(--auth-result-neutral-bg)',
  authResultProblem: 'var(--auth-result-problem)',
  authResultProblemBg: 'var(--auth-result-problem-bg)',
  bgMuted: 'var(--bg-muted)',
  fgDefault: 'var(--fg-default)',
  fgInverse: 'var(--fg-inverse)',
  graphArrow: 'var(--graph-arrow)',
  graphBackgroundGrid: 'var(--graph-background-grid)',
  graphEdgeAuth: 'var(--graph-edge-auth)',
  graphEdgeMuted: 'var(--graph-edge-muted)',
  graphEdgeParent: 'var(--graph-edge-parent)',
  graphEdgeSession: 'var(--graph-edge-session)',
  graphEdgeUmbrella: 'var(--graph-edge-umbrella)',
  graphLabel: 'var(--graph-label)',
  graphMinimapMask: 'var(--graph-minimap-mask)',
  graphNodeDefault: 'var(--graph-node-default)',
  graphNodeDefaultMuted: 'var(--graph-node-default-muted)',
  graphNodeMuted: 'var(--graph-node-muted)',
  graphNodeMutedStrong: 'var(--graph-node-muted-strong)',
  graphNodeStroke: 'var(--graph-node-stroke)',
  graphSelectionStroke: 'var(--graph-selection-stroke)',
  inboxContinuation: 'var(--inbox-continuation)',
  inboxContinuationBg: 'var(--inbox-continuation-bg)',
  inboxHandoff: 'var(--inbox-handoff)',
  inboxHandoffBg: 'var(--inbox-handoff-bg)',
  inboxIssue: 'var(--inbox-issue)',
  inboxIssueBg: 'var(--inbox-issue-bg)',
  statusDanger: 'var(--status-danger)',
  statusDangerBg: 'var(--status-danger-bg)',
  statusInfo: 'var(--status-info)',
  statusInfoBg: 'var(--status-info-bg)',
  statusNeutral: 'var(--status-neutral)',
  statusPurple: 'var(--status-purple)',
  statusPurpleBg: 'var(--status-purple-bg)',
  statusSuccess: 'var(--status-success)',
  statusSuccessBg: 'var(--status-success-bg)',
  statusWarning: 'var(--status-warning)',
  statusWarningBg: 'var(--status-warning-bg)',
  textMuted: 'var(--text-muted)',
  textPrimary: 'var(--text-primary)',
  textPrimaryMuted: 'var(--text-primary-muted)',
  textPrimarySoft: 'var(--text-primary-soft)',
} as const;

export type AppColor = keyof typeof appColors;
export const APP_THEME_MODES = ['system', 'dark', 'light'] as const;
export type AppThemeMode = typeof APP_THEME_MODES[number];
export type ResolvedAppTheme = 'dark' | 'light';
export const TERMINAL_THEME_IDS = ['mandible', 'github', 'solarized', 'one', 'high-contrast'] as const;
export type TerminalThemeId = typeof TERMINAL_THEME_IDS[number];

export const TERMINAL_THEME_LABELS: Record<TerminalThemeId, string> = {
  mandible: 'Mandible',
  github: 'GitHub',
  solarized: 'Solarized',
  one: 'One',
  'high-contrast': 'High contrast',
};

export type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

const TERMINAL_THEMES: Record<ResolvedAppTheme, Record<TerminalThemeId, TerminalTheme>> = {
  dark: {
    mandible: { background: '#181818', foreground: '#E6EDF3', cursor: '#4DA3FF', selectionBackground: '#334155', black: '#0B0F14', red: '#F26B6B', green: '#32D296', yellow: '#F5C25C', blue: '#4DA3FF', magenta: '#C084FC', cyan: '#5DD6E8', white: '#CBD5E1', brightBlack: '#7D8794', brightRed: '#FF8585', brightGreen: '#58E0AE', brightYellow: '#FFD478', brightBlue: '#72B7FF', brightMagenta: '#D4A5FF', brightCyan: '#7FE5F2', brightWhite: '#FFFFFF' },
    github: { background: '#0D1117', foreground: '#C9D1D9', cursor: '#58A6FF', selectionBackground: '#264F78', black: '#484F58', red: '#FF7B72', green: '#3FB950', yellow: '#D29922', blue: '#58A6FF', magenta: '#BC8CFF', cyan: '#39C5CF', white: '#B1BAC4', brightBlack: '#6E7681', brightRed: '#FFA198', brightGreen: '#56D364', brightYellow: '#E3B341', brightBlue: '#79C0FF', brightMagenta: '#D2A8FF', brightCyan: '#56D4DD', brightWhite: '#F0F6FC' },
    solarized: { background: '#002B36', foreground: '#93A1A1', cursor: '#268BD2', selectionBackground: '#073642', black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900', blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5', brightBlack: '#586E75', brightRed: '#CB4B16', brightGreen: '#586E75', brightYellow: '#657B83', brightBlue: '#839496', brightMagenta: '#6C71C4', brightCyan: '#93A1A1', brightWhite: '#FDF6E3' },
    one: { background: '#282C34', foreground: '#ABB2BF', cursor: '#528BFF', selectionBackground: '#3E4451', black: '#282C34', red: '#E06C75', green: '#98C379', yellow: '#E5C07B', blue: '#61AFEF', magenta: '#C678DD', cyan: '#56B6C2', white: '#ABB2BF', brightBlack: '#5C6370', brightRed: '#E06C75', brightGreen: '#98C379', brightYellow: '#E5C07B', brightBlue: '#61AFEF', brightMagenta: '#C678DD', brightCyan: '#56B6C2', brightWhite: '#FFFFFF' },
    'high-contrast': { background: '#000000', foreground: '#FFFFFF', cursor: '#FFFFFF', selectionBackground: '#404040', black: '#000000', red: '#FF6B6B', green: '#72F1B8', yellow: '#FFE66D', blue: '#66B3FF', magenta: '#E09CFF', cyan: '#66FFFF', white: '#FFFFFF', brightBlack: '#A0A0A0', brightRed: '#FF9A9A', brightGreen: '#A6FFD4', brightYellow: '#FFF3A3', brightBlue: '#9AD0FF', brightMagenta: '#F0C7FF', brightCyan: '#A0FFFF', brightWhite: '#FFFFFF' },
  },
  light: {
    mandible: { background: '#FFFFFF', foreground: '#17202A', cursor: '#0B63CE', selectionBackground: '#CFE3FA', black: '#17202A', red: '#B42318', green: '#047857', yellow: '#9A5B00', blue: '#0B63CE', magenta: '#7C3AED', cyan: '#087F8C', white: '#E5E7EB', brightBlack: '#5F6B7A', brightRed: '#D92D20', brightGreen: '#039855', brightYellow: '#B54708', brightBlue: '#1570EF', brightMagenta: '#8B5CF6', brightCyan: '#0891B2', brightWhite: '#FFFFFF' },
    github: { background: '#FFFFFF', foreground: '#24292F', cursor: '#0969DA', selectionBackground: '#B6D7FE', black: '#24292F', red: '#CF222E', green: '#116329', yellow: '#9A6700', blue: '#0969DA', magenta: '#8250DF', cyan: '#1B7C83', white: '#D0D7DE', brightBlack: '#57606A', brightRed: '#A40E26', brightGreen: '#1A7F37', brightYellow: '#BF8700', brightBlue: '#218BFF', brightMagenta: '#A475F9', brightCyan: '#3192AA', brightWhite: '#FFFFFF' },
    solarized: { background: '#FDF6E3', foreground: '#657B83', cursor: '#268BD2', selectionBackground: '#EEE8D5', black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900', blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5', brightBlack: '#586E75', brightRed: '#CB4B16', brightGreen: '#586E75', brightYellow: '#657B83', brightBlue: '#839496', brightMagenta: '#6C71C4', brightCyan: '#93A1A1', brightWhite: '#FDF6E3' },
    one: { background: '#FAFAFA', foreground: '#383A42', cursor: '#526FFF', selectionBackground: '#DDE4FF', black: '#383A42', red: '#E45649', green: '#50A14F', yellow: '#C18401', blue: '#4078F2', magenta: '#A626A4', cyan: '#0184BC', white: '#E5E5E6', brightBlack: '#696C77', brightRed: '#E45649', brightGreen: '#50A14F', brightYellow: '#C18401', brightBlue: '#4078F2', brightMagenta: '#A626A4', brightCyan: '#0184BC', brightWhite: '#FFFFFF' },
    'high-contrast': { background: '#FFFFFF', foreground: '#000000', cursor: '#000000', selectionBackground: '#B8D8FF', black: '#000000', red: '#9B0000', green: '#006B2E', yellow: '#704D00', blue: '#003F9E', magenta: '#69009E', cyan: '#00636B', white: '#FFFFFF', brightBlack: '#404040', brightRed: '#C00000', brightGreen: '#00843D', brightYellow: '#8A6200', brightBlue: '#0057D9', brightMagenta: '#8500C7', brightCyan: '#007D88', brightWhite: '#FFFFFF' },
  },
};

export function normalizeAppThemeMode(value: string | undefined): AppThemeMode {
  if (value === 'dark' || value === 'light' || value === 'system') {
    return value;
  }
  return 'system';
}

export function resolveAppThemeMode(mode: AppThemeMode, prefersDark: boolean): ResolvedAppTheme {
  if (mode === 'dark' || mode === 'light') {
    return mode;
  }
  return prefersDark ? 'dark' : 'light';
}

export function normalizeTerminalThemeId(value: string | undefined): TerminalThemeId {
  return TERMINAL_THEME_IDS.includes(value as TerminalThemeId)
    ? value as TerminalThemeId
    : 'mandible';
}

export function resolveTerminalTheme(
  mode: ResolvedAppTheme,
  value: string | undefined,
): TerminalTheme {
  return TERMINAL_THEMES[mode][normalizeTerminalThemeId(value)];
}

function resolveCssToken(tokenName: string, fallback: string, scope?: Element | null): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return fallback;
  }
  const element = scope ?? document.documentElement;
  const value = window.getComputedStyle(element).getPropertyValue(tokenName).trim();
  if (value) return value;
  return window.getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim() || fallback;
}

export function getTerminalTheme(scope?: Element | null): TerminalTheme {
  const root = typeof document === 'undefined' ? null : document.documentElement;
  const resolvedMode = root?.dataset.theme === 'light' ? 'light' : 'dark';
  const selected = resolveTerminalTheme(resolvedMode, root?.dataset.terminalTheme);
  return {
    ...selected,
    background: resolveCssToken('--terminal-bg', selected.background, scope),
    foreground: resolveCssToken('--terminal-fg', selected.foreground, scope),
    cursor: resolveCssToken('--terminal-cursor', selected.cursor, scope),
    selectionBackground: resolveCssToken('--terminal-selection-bg', selected.selectionBackground, scope),
  };
}
