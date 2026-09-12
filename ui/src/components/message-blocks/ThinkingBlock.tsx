import { CompactActivityRow } from '../shared/ChatDisclosure';
import { OfficialProviderMark } from '../shared/OfficialProviderMark';
import { plainActivityHeader } from './ActivityBlock';

export type ThinkingBlockProps = {
  content: string;
  defaultCollapsed?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

export function ThinkingBlock({
  content,
  defaultCollapsed = true,
  expanded,
  onExpandedChange,
}: ThinkingBlockProps): JSX.Element {
  const parts = content.split('\n').map((line) => plainActivityHeader(line).trim()).filter(Boolean);
  const summary = parts[0] ?? 'Thinking';
  const remaining = parts.slice(1);
  return (
    <CompactActivityRow
      className="thinking-block"
      icon={<OfficialProviderMark kind="anthropic" />}
      summary={summary}
      disclosure={remaining.length > 0 ? {
        content: <div className="thinking-block__body"><pre>{remaining.join('\n')}</pre></div>,
        regionLabel: `${summary} details`,
        defaultExpanded: !defaultCollapsed,
        expanded,
        onExpandedChange,
      } : undefined}
    />
  );
}
