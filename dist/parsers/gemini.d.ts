import type { ConversationParser, ParseResult } from "./types.js";
export declare class GeminiParser implements ConversationParser {
    source: "gemini";
    canParse(filePath: string): boolean;
    parse(filePath: string): Promise<ParseResult | null>;
}
