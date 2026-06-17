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
  inboxPresetDiff: 'var(--inbox-preset-diff)',
  inboxPresetDiffBg: 'var(--inbox-preset-diff-bg)',
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

function resolveCssToken(tokenName: string, fallback: string, scope?: Element | null): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return fallback;
  }
  const element = scope ?? document.documentElement;
  const value = window.getComputedStyle(element).getPropertyValue(tokenName).trim();
  if (value) return value;
  return window.getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim() || fallback;
}

export function getTerminalTheme(scope?: Element | null): {
  background: string
  foreground: string
  cursor: string
} {
  return {
    background: resolveCssToken('--terminal-bg', '#0b0f14', scope),
    foreground: resolveCssToken('--terminal-fg', '#e6edf3', scope),
    cursor: resolveCssToken('--terminal-cursor', '#4da3ff', scope),
  };
}
