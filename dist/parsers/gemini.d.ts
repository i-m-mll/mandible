import type { ConversationParser, ParseResult } from "./types.js";
interface GeminiProjectIdentity {
    projectPath: string | null;
    cwd: string | null;
}
export declare function inferGeminiProjectIdentity(filePath: string, projectHash: string | null | undefined): Promise<GeminiProjectIdentity>;
export declare class GeminiParser implements ConversationParser {
    source: "gemini";
    canParse(filePath: string): boolean;
    parse(filePath: string): Promise<ParseResult | null>;
}
export {};
