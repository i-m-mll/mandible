/**
 * Shared JSON-line normalizers for Codex/Gemini stream output.
 * Bug: 8d3328c — Extracted from PTYBackend for reuse by SpawnBackend.
 *
 * Each normalizer takes a raw JSON line (string) and returns a ConsoleStreamEvent
 * or null if the line is not recognized. They are pure functions (no side effects).
 */
import type { ConsoleStreamEvent } from "../types.js";
/**
 * Mutable state passed through successive calls to normalizeCodexStreamLine
 * for a single Codex session. The caller owns this state object.
 */
export interface CodexNormalizerState {
    threadId: string | null;
    turnCount: number;
    model: string | null;
}
export declare function normalizeGeminiStreamLine(line: string): ConsoleStreamEvent | null;
export declare function normalizeCodexStreamLine(line: string, state: CodexNormalizerState): ConsoleStreamEvent | null;
