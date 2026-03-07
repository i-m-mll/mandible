import type { ConversationParser, ParseResult } from "./types.js";
export declare class ClaudeParser implements ConversationParser {
    source: "claude_code";
    canParse(filePath: string): boolean;
    parse(filePath: string): Promise<ParseResult | null>;
}
