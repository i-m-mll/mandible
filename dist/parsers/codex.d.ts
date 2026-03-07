import type { ConversationParser, ParseResult } from "./types.js";
export declare class CodexParser implements ConversationParser {
    source: "codex";
    canParse(filePath: string): boolean;
    parse(filePath: string): Promise<ParseResult | null>;
}
