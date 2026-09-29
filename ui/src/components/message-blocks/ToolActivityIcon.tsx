import { HistoryIcon, LightbulbIcon, MonitorIcon } from '../icons/TabIcons';

export function ToolActivityIcon({ icon, className }: {
  icon: string;
  className?: string;
}): JSX.Element {
  if (icon !== 'terminal') {
    if (icon === 'tool') return <MonitorIcon className={className} />;
    if (icon === 'wait') return <HistoryIcon className={className} />;
    if (icon === 'thought') return <LightbulbIcon className={className} />;
    if (icon === 'javascript') return <span className={className} aria-hidden="true">JS</span>;
    return <span className={className} aria-hidden="true">{icon}</span>;
  }
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.5" width="12.5" height="11" rx="2" />
      <path d="m4.25 6 2 2-2 2M8.25 10h3" />
    </svg>
  );
}
