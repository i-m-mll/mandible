/**
 * Presets core module — business logic for preset management.
 * Bug: 61bee4e — Presets feature backend
 */
import type { Db } from "./db.js";
export type PresetSource = "manual" | "claude_md_global" | "claude_md_project" | "claude_md_local";
export interface Preset {
    id: string;
    name: string;
    description: string;
    source: PresetSource;
    source_path: string | null;
    content_hash: string;
    version: number;
    created_at: number;
    updated_at: number;
}
export interface PresetNode {
    id: string;
    preset_id: string;
    parent_id: string | null;
    position: number;
    title: string;
    body: string;
    level: number;
    created_at: number;
    updated_at: number;
}
export interface SessionPreset {
    session_id: string;
    preset_id: string;
    preset_version: number;
    position: number;
}
export type PresetDiffType = "add" | "remove" | "modify";
export type PresetDiffStatus = "proposed" | "accepted" | "rejected" | "promoted";
export interface PresetDiff {
    id: string;
    session_id: string;
    preset_id: string | null;
    node_id: string | null;
    diff_type: PresetDiffType;
    old_content: string | null;
    new_content: string | null;
    status: PresetDiffStatus;
    created_at: number;
}
export interface PresetUnionResult {
    text: string;
    tokenEstimate: number;
}
export interface RouteResult {
    recommendedPresetId: string;
    confidence: "high" | "medium" | "low";
    reason: string;
}
/**
 * Parse Markdown into a flat list of PresetNode objects with parent_id
 * relationships derived from heading depth.
 *
 * Strategy:
 * - Split on lines, accumulate body content between headings.
 * - Use a stack to track parent relationships by heading level.
 * - Pre-heading content becomes a synthetic root node (level 0, empty title).
 */
export declare function parseMarkdownToNodes(markdown: string, presetId: string): PresetNode[];
/**
 * Reconstruct full Markdown from a node tree.
 * Nodes are sorted by position, children nested under parents.
 */
export declare function serializeNodesToMarkdown(nodes: PresetNode[]): string;
/**
 * SHA-256 of the serialized Markdown, hex-encoded.
 */
export declare function computeContentHash(markdown: string): string;
export declare function estimateTokens(text: string): number;
export declare const MODEL_CONTEXT_WINDOWS: Record<string, number>;
/**
 * Given N preset IDs in order, serialize each to Markdown.
 * Content-hash dedup: if two presets contain identical leaf content, include it once.
 * Order: preset selection order, then tree position within each preset.
 */
export declare function computePresetUnion(presetIds: string[], db: Db): PresetUnionResult;
/**
 * Route a proposed diff to the most appropriate preset using Jaccard
 * similarity (bag-of-words) between fix text and each preset's node content.
 */
export declare function routePresetDiff(diffContent: string, sessionPresets: Preset[], violationContext: {
    repo?: string;
    tool?: string;
    filePath?: string;
}): RouteResult;
/**
 * Import a CLAUDE.md file as a preset, parsing it into nodes.
 * Determines source type from file path.
 */
export declare function importClaudeMd(filePath: string, db: Db): Preset;
export declare function inferSourceFromPath(filePath: string): PresetSource;
export declare function derivePresetName(filePath: string, source: PresetSource): string;
/**
 * Enhanced routing that reads node content from the DB for better Jaccard scoring.
 */
export declare function routePresetDiffWithNodes(diffContent: string, sessionPresets: Preset[], violationContext: {
    repo?: string;
    tool?: string;
    filePath?: string;
}, db: Db): RouteResult;
