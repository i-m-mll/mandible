import { Paintbrush } from 'lucide-preact';
import type { IconSourceProps } from './types';

function PaintbrushIcon({ size = 16, ...props }: IconSourceProps) {
  return <Paintbrush size={size} {...props} />;
}

export const lucideSet = {
  paintbrush: PaintbrushIcon,
};
