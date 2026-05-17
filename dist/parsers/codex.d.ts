import type { ConversationParser, ParseResult } from "./types.js";
export declare function getCodexSessionIndexPath(filePath: string): string | null;
export declare function loadCodexSessionIndexTitle(filePath: string, sessionId: string): Promise<string | null>;
export declare class CodexParser implements ConversationParser {
    source: "codex";
    canParse(filePath: string): boolean;
    parse(filePath: string): Promise<ParseResult | null>;
}
