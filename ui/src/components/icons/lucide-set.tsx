import { Check, Copy, Ellipsis, FileText, GitFork, Info, Link, MousePointer2, Paintbrush, Play, Square, SquareCheck, type LucideIcon } from 'lucide-preact';
import type { IconSourceProps } from './types';

function PaintbrushIcon({ size = 16, ...props }: IconSourceProps) {
  return <Paintbrush size={size} {...props} />;
}

function lucideIcon(Source: LucideIcon) {
  return function LucideSource({ size = 16, ...props }: IconSourceProps) {
    return <Source size={size} {...props} />;
  };
}

export const lucideSet = {
  paintbrush: PaintbrushIcon,
  menu: lucideIcon(Ellipsis),
  forkConversation: lucideIcon(GitFork),
  resume: lucideIcon(Play),
  information: lucideIcon(Info),
  copyMessage: lucideIcon(Copy),
  copyLink: lucideIcon(Link),
  messageCopied: lucideIcon(Check),
  openMarkdown: lucideIcon(FileText),
  selectMessage: lucideIcon(MousePointer2),
  messageSelected: lucideIcon(Check),
  messageSelect: lucideIcon(Square),
  messageSelectionChecked: lucideIcon(SquareCheck),
};
