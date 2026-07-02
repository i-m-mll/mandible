// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — Barrel export for unified message block components

export { TextBlock } from './TextBlock';
export type { TextBlockProps } from './TextBlock';

export { ThinkingBlock } from './ThinkingBlock';
export type { ThinkingBlockProps } from './ThinkingBlock';

export { ToolUseBlock } from './ToolUseBlock';
export type { ToolUseBlockProps, ToolResultContent, ToolResultContentBlock } from './ToolUseBlock';

export { FileEditBlock } from './FileEditBlock';
export type { FileEditBlockProps } from './FileEditBlock';

export { latestPlanIndex, parsePlanEntries, PlanBlock } from './PlanBlock';
export type { PlanBlockProps, PlanEntry, PlanEntryStatus } from './PlanBlock';

export { TurnGroup } from './TurnGroup';
export type { TurnGroupProps } from './TurnGroup';

export { GroupFooter } from './GroupFooter';
export type { GroupFooterProps } from './GroupFooter';

export { UserBubble } from './UserBubble';
export type { UserBubbleProps } from './UserBubble';

export { BlockTypeIcon } from './BlockTypeIcon';
export type { BlockTypeIconProps, BlockTypeIconType } from './BlockTypeIcon';
