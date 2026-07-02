import type { JSX } from 'preact/jsx-runtime';

export function PermissionPolicyStrip({
  allowedTools,
  onOpenSettings,
}: {
  allowedTools?: string[] | null;
  onOpenSettings: () => void;
}): JSX.Element {
  const tools = [...(allowedTools ?? [])].sort();
  const summary = tools.length === 0
    ? 'No auto-approved tools'
    : tools.length <= 3
      ? tools.join(', ')
      : `${tools.slice(0, 3).join(', ')} +${tools.length - 3}`;

  return (
    <button
      type="button"
      className="permission-policy-strip"
      onClick={onOpenSettings}
      title={tools.length > 0 ? tools.join(', ') : 'Open session controls'}
    >
      <span className="permission-policy-strip__label">Auto-approve</span>
      <span className="permission-policy-strip__value">{summary}</span>
    </button>
  );
}
