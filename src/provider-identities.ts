import type { ConversationSource } from "./parsers/types.js";

export const PROVIDER_TO_CONVERSATION_SOURCE: Readonly<Record<string, ConversationSource>> = Object.freeze({
  codex: "codex",
  claude: "claude_code",
  gemini: "gemini",
} satisfies Record<string, ConversationSource>);

export const CONVERSATION_SOURCE_TO_PROVIDER: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PROVIDER_TO_CONVERSATION_SOURCE).map(([provider, source]) => [source, provider]),
  ),
);
