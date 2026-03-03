import { ClaudeParser } from "./claude.js";
import { CodexParser } from "./codex.js";
import { GeminiParser } from "./gemini.js";
import type { ConversationParser } from "./types.js";

const parsers: ConversationParser[] = [
  new ClaudeParser(),
  new CodexParser(),
  new GeminiParser(),
];

export function getParserForFile(filePath: string): ConversationParser | null {
  return parsers.find((p) => p.canParse(filePath)) ?? null;
}

export function getAllParsers(): ConversationParser[] {
  return [...parsers];
}

export type { ConversationParser } from "./types.js";
