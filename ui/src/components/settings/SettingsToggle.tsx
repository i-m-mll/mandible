export function SettingsToggle(props: {
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      className={'settings-view__toggle' + (props.enabled ? ' settings-view__toggle--on' : '')}
      onClick={props.onToggle}
      disabled={props.disabled}
      role="switch"
      aria-checked={props.enabled}
      aria-label={props.label}
    >
      <span className="settings-view__toggle-knob" />
    </button>
  );
}
