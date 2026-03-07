import { ClaudeParser } from "./claude.js";
import { CodexParser } from "./codex.js";
import { GeminiParser } from "./gemini.js";
const parsers = [
    new ClaudeParser(),
    new CodexParser(),
    new GeminiParser(),
];
export function getParserForFile(filePath) {
    return parsers.find((p) => p.canParse(filePath)) ?? null;
}
export function getAllParsers() {
    return [...parsers];
}
