import type { ConversationSource } from '../parsers/types.js';

export type ActivityTarget =
  | { kind: 'thread'; provider: ConversationSource; sessionId: string; labelHint?: string }
  | { kind: 'subagent'; provider: ConversationSource; parentSessionId: string; agentId: string; labelHint?: string };
