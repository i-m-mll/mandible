import type { ComponentChildren } from 'preact';
import { appTip } from './AppHoverTips';

export type IconTab = {
  id: string;
  label: string;
  tooltip?: string;
  icon: ComponentChildren;
};

export function IconTabList({
  ariaLabel,
  tabs,
  activeTab,
  onActiveTabChange,
  idPrefix,
  className = '',
  presentation = 'content',
}: {
  ariaLabel: string;
  tabs: readonly IconTab[];
  activeTab: string;
  onActiveTabChange(tab: string): void;
  idPrefix: string;
  className?: string;
  presentation?: 'content' | 'frame';
}): JSX.Element {
  return (
    <div className={`icon-tab-list${presentation === 'frame' ? ' icon-tab-list--frame' : ''}${className ? ` ${className}` : ''}`} role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`}
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          aria-selected={activeTab === tab.id}
          aria-label={tab.label}
          {...(presentation === 'frame' ? appTip(tab.tooltip ?? tab.label) : { title: tab.tooltip ?? tab.label })}
          tabIndex={activeTab === tab.id ? 0 : -1}
          onClick={() => onActiveTabChange(tab.id)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const nextIndex = event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            const next = tabs[nextIndex];
            if (!next) return;
            onActiveTabChange(next.id);
            queueMicrotask(() => document.getElementById(`${idPrefix}-tab-${next.id}`)?.focus());
          }}
        >
          <span aria-hidden="true">{tab.icon}</span>
        </button>
      ))}
    </div>
  );
}
