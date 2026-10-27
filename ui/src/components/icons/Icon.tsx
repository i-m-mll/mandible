import type { JSX } from 'preact';
import { appIcons } from './config';
import type { IconName, IconSourceProps } from './types';

export type { IconName, IconSet, IconSourceProps } from './types';
export type IconProps = Omit<IconSourceProps, 'aria-hidden' | 'aria-label' | 'role' | 'focusable'> & {
  name: IconName;
  label?: string;
};

export function Icon({ name, label, className, ...props }: IconProps): JSX.Element {
  const Source = appIcons[name];
  return <Source {...props} className={['app-icon', className].filter(Boolean).join(' ')} aria-hidden={label ? undefined : true} aria-label={label} role={label ? 'img' : undefined} focusable="false" />;
}
