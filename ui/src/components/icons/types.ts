import type { ComponentType, JSX } from 'preact';
import type { mandibleSet } from './mandible-set';
import type { lucideSet } from './lucide-set';

/** Sources use a 16px SVG default; glyph artwork keeps inherited text metrics.
 * Adapters own drawing attributes and forward presentation/accessibility props.
 */
export type IconSourceProps = {
  size?: number;
  className?: string;
  style?: JSX.CSSProperties;
  'aria-hidden'?: boolean;
  'aria-label'?: string;
  role?: 'img';
  focusable?: 'false';
  [attribute: `data-${string}`]: string | undefined;
};

export type IconName = keyof typeof mandibleSet | keyof typeof lucideSet;
export type IconSet = Record<IconName, ComponentType<IconSourceProps>>;
