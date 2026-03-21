/**
 * Presets core module — business logic for preset management.
 * Bug: 61bee4e — Presets feature backend
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
// ---------------------------------------------------------------------------
// Markdown Parser
// ---------------------------------------------------------------------------
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
/**
 * Parse Markdown into a flat list of PresetNode objects with parent_id
 * relationships derived from heading depth.
 *
 * Strategy:
 * - Split on lines, accumulate body content between headings.
 * - Use a stack to track parent relationships by heading level.
 * - Pre-heading content becomes a synthetic root node (level 0, empty title).
 */
export function parseMarkdownToNodes(markdown, presetId) {
    const lines = markdown.split("\n");
    const nodes = [];
    const now = Date.now();
    // Stack entries: { level, nodeId }
    // The stack represents the current ancestor chain.
    const stack = [];
    let currentTitle = "";
    let currentLevel = 0;
    let currentBodyLines = [];
    let currentNodeId = "";
    let hasPreHeadingContent = false;
    let firstHeadingSeen = false;
    let positionCounter = 0;
    function flushNode() {
        const body = currentBodyLines.join("\n");
        // Only create a node if there's content or a title (skip empty synthetic root)
        if (!currentNodeId)
            return;
        if (!firstHeadingSeen && !body.trim())
            return;
        const parentId = findParent(stack, currentLevel);
        nodes.push({
            id: currentNodeId,
            preset_id: presetId,
            parent_id: parentId,
            position: positionCounter++,
            title: currentTitle,
            body,
            level: currentLevel,
            created_at: now,
            updated_at: now,
        });
        // Push onto stack (replace anything at same or deeper level)
        while (stack.length > 0 && stack[stack.length - 1].level >= currentLevel) {
            stack.pop();
        }
        stack.push({ level: currentLevel, nodeId: currentNodeId });
    }
    let insideCodeBlock = false;
    for (const line of lines) {
        // Track fenced code blocks — toggle on/off when encountering ``` lines.
        // Bug: 61bee4e — headings inside code blocks must not be parsed as nodes.
        if (line.trimStart().startsWith("```")) {
            insideCodeBlock = !insideCodeBlock;
            currentBodyLines.push(line);
            continue;
        }
        const match = !insideCodeBlock ? line.match(HEADING_RE) : null;
        if (match) {
            // Flush previous node
            flushNode();
            if (!firstHeadingSeen && currentBodyLines.length > 0 && currentBodyLines.some((l) => l.trim())) {
                hasPreHeadingContent = true;
            }
            firstHeadingSeen = true;
            const level = match[1].length;
            const title = match[2];
            currentTitle = title;
            currentLevel = level;
            currentNodeId = randomUUID();
            currentBodyLines = [];
        }
        else {
            if (!firstHeadingSeen && !currentNodeId) {
                // Pre-heading content — create synthetic root if needed
                if (!currentNodeId) {
                    currentNodeId = randomUUID();
                    currentTitle = "";
                    currentLevel = 0;
                }
            }
            currentBodyLines.push(line);
        }
    }
    // Flush final node
    flushNode();
    return nodes;
}
function findParent(stack, currentLevel) {
    // Walk the stack backwards to find the nearest ancestor with a lower level.
    for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].level < currentLevel) {
            return stack[i].nodeId;
        }
    }
    return null;
}
// ---------------------------------------------------------------------------
// Markdown Serializer
// ---------------------------------------------------------------------------
/**
 * Reconstruct full Markdown from a node tree.
 * Nodes are sorted by position, children nested under parents.
 */
export function serializeNodesToMarkdown(nodes) {
    if (nodes.length === 0)
        return "";
    // Build a parent-children map
    const childrenMap = new Map();
    for (const node of nodes) {
        const parentKey = node.parent_id;
        if (!childrenMap.has(parentKey)) {
            childrenMap.set(parentKey, []);
        }
        childrenMap.get(parentKey).push(node);
    }
    // Sort children by position
    for (const children of childrenMap.values()) {
        children.sort((a, b) => a.position - b.position);
    }
    const parts = [];
    function renderNode(node) {
        if (node.level === 0) {
            // Synthetic root — just output the body
            if (node.body) {
                parts.push(node.body);
            }
        }
        else {
            // Heading + body
            const heading = "#".repeat(node.level) + " " + node.title;
            parts.push(heading);
            if (node.body) {
                parts.push(node.body);
            }
        }
        // Render children
        const children = childrenMap.get(node.id) ?? [];
        for (const child of children) {
            renderNode(child);
        }
    }
    // Start with root nodes (parent_id === null)
    const roots = childrenMap.get(null) ?? [];
    for (const root of roots) {
        renderNode(root);
    }
    return parts.join("\n");
}
// ---------------------------------------------------------------------------
// Content Hash
// ---------------------------------------------------------------------------
/**
 * SHA-256 of the serialized Markdown, hex-encoded.
 */
export function computeContentHash(markdown) {
    return createHash("sha256").update(markdown).digest("hex");
}
// ---------------------------------------------------------------------------
// Token Estimation
// ---------------------------------------------------------------------------
export function estimateTokens(text) {
    return Math.ceil(text.length / 3.5);
}
export const MODEL_CONTEXT_WINDOWS = {
    opus: 1_000_000,
    sonnet: 250_000,
    haiku: 200_000,
    "claude-opus-4": 1_000_000,
    "claude-sonnet-4": 250_000,
    "claude-haiku-4": 200_000,
};
// ---------------------------------------------------------------------------
// Union Engine
// ---------------------------------------------------------------------------
/**
 * Given N preset IDs in order, serialize each to Markdown.
 * Content-hash dedup: if two presets contain identical leaf content, include it once.
 * Order: preset selection order, then tree position within each preset.
 */
export function computePresetUnion(presetIds, db) {
    if (presetIds.length === 0) {
        return { text: "", tokenEstimate: 0 };
    }
    const seenHashes = new Set();
    const parts = [];
    for (const presetId of presetIds) {
        const nodes = db
            .prepare("SELECT * FROM preset_nodes WHERE preset_id = ? ORDER BY position ASC")
            .all(presetId);
        if (nodes.length === 0)
            continue;
        const markdown = serializeNodesToMarkdown(nodes);
        const hash = computeContentHash(markdown);
        if (seenHashes.has(hash))
            continue;
        seenHashes.add(hash);
        parts.push(markdown);
    }
    const text = parts.join("\n\n---\n\n");
    return {
        text,
        tokenEstimate: estimateTokens(text),
    };
}
// ---------------------------------------------------------------------------
// Routing Algorithm
// ---------------------------------------------------------------------------
/**
 * Route a proposed diff to the most appropriate preset using Jaccard
 * similarity (bag-of-words) between fix text and each preset's node content.
 */
export function routePresetDiff(diffContent, sessionPresets, violationContext) {
    if (sessionPresets.length === 0) {
        return {
            recommendedPresetId: "",
            confidence: "low",
            reason: "No presets available",
        };
    }
    // Tokenize the diff content into a bag of words
    const diffWords = tokenize(diffContent);
    if (diffWords.size === 0) {
        // Bug: 61bee4e — Empty diff content: return empty recommendation with low confidence
        // rather than silently picking an unrelated preset.
        return {
            recommendedPresetId: "",
            confidence: "low",
            reason: "Empty diff content, no recommendation",
        };
    }
    let bestId = "";
    let bestScore = -1;
    let bestReason = "";
    for (const preset of sessionPresets) {
        // Skip read-only global presets for routing — user-driven promotion is separate
        if (preset.source === "claude_md_global")
            continue;
        let score = 0;
        // Repo-specific signal: prefer claude_md_project preset matching the repo
        if (violationContext.repo &&
            preset.source === "claude_md_project" &&
            preset.source_path?.includes(violationContext.repo)) {
            score += 0.3;
        }
        // We'd need the nodes to compute Jaccard — use the content_hash as a proxy
        // for now, and compute Jaccard on the preset name + description as a lightweight heuristic.
        const presetWords = tokenize(`${preset.name} ${preset.description}`);
        const jaccard = jaccardSimilarity(diffWords, presetWords);
        score += jaccard;
        if (score > bestScore) {
            bestScore = score;
            bestId = preset.id;
            bestReason =
                score > 0.5
                    ? `High similarity with preset "${preset.name}"`
                    : score > 0.2
                        ? `Moderate similarity with preset "${preset.name}"`
                        : `Best available match: preset "${preset.name}"`;
        }
    }
    // Bug: 61bee4e — If no matching preset found, return empty with low confidence
    // rather than falling back to an unrelated preset.
    if (!bestId) {
        return {
            recommendedPresetId: "",
            confidence: "low",
            reason: "No matching preset found",
        };
    }
    const confidence = bestScore > 0.5 ? "high" : bestScore > 0.2 ? "medium" : "low";
    return {
        recommendedPresetId: bestId,
        confidence,
        reason: bestReason,
    };
}
function tokenize(text) {
    return new Set(text
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 2));
}
function jaccardSimilarity(a, b) {
    if (a.size === 0 && b.size === 0)
        return 0;
    let intersection = 0;
    for (const word of a) {
        if (b.has(word))
            intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
// ---------------------------------------------------------------------------
// CLAUDE.md Import
// ---------------------------------------------------------------------------
/**
 * Import a CLAUDE.md file as a preset, parsing it into nodes.
 * Determines source type from file path.
 */
export function importClaudeMd(filePath, db) {
    const content = fs.readFileSync(filePath, "utf8");
    const source = inferSourceFromPath(filePath);
    const now = Date.now();
    const presetId = randomUUID();
    const contentHash = computeContentHash(content);
    // Derive name from file path
    const name = derivePresetName(filePath, source);
    // Create the preset row
    db.prepare(`INSERT INTO presets (id, name, description, source, source_path, content_hash, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(presetId, name, `Imported from ${filePath}`, source, filePath, contentHash, now, now);
    // Parse and insert nodes
    const nodes = parseMarkdownToNodes(content, presetId);
    const insertNode = db.prepare(`INSERT INTO preset_nodes (id, preset_id, parent_id, position, title, body, level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertAll = db.transaction(() => {
        for (const node of nodes) {
            insertNode.run(node.id, node.preset_id, node.parent_id, node.position, node.title, node.body, node.level, node.created_at, node.updated_at);
        }
    });
    insertAll();
    return {
        id: presetId,
        name,
        description: `Imported from ${filePath}`,
        source,
        source_path: filePath,
        content_hash: contentHash,
        version: 1,
        created_at: now,
        updated_at: now,
    };
}
// Bug: 61bee4e — Exported for testing.
export function inferSourceFromPath(filePath) {
    const normalized = filePath.replace(/\\/g, "/");
    const homeDir = (typeof process !== "undefined" ? process.env.HOME : "") ?? "";
    const homePath = homeDir.replace(/\\/g, "/");
    // Check global first: must be specifically under the user's home directory.
    // ~/.claude/CLAUDE.md or ~/.dotfiles/ paths are global (user-level) configuration.
    const globalClaudeMdPath = homePath ? `${homePath}/.claude/CLAUDE.md` : null;
    if ((globalClaudeMdPath && normalized === globalClaudeMdPath) ||
        (homePath && normalized.startsWith(`${homePath}/.dotfiles/`) && normalized.includes("CLAUDE.md"))) {
        return "claude_md_global";
    }
    // Project-level: <repo>/.claude/CLAUDE.md (any path with /.claude/CLAUDE.md that isn't global)
    if (normalized.includes("/.claude/CLAUDE.md")) {
        return "claude_md_project";
    }
    // Repo root: <repo>/CLAUDE.md (direct child of a directory)
    if (normalized.endsWith("/CLAUDE.md")) {
        // Check whether this is a nested CLAUDE.md (more than one directory deep from a known root).
        // A root-level CLAUDE.md has the pattern: .../<dirname>/CLAUDE.md
        // A local (subdirectory) CLAUDE.md would have additional path segments after the repo root.
        return "claude_md_project";
    }
    // Local CLAUDE.md (nested in subdirectories, e.g., <repo>/subdir/CLAUDE.md)
    if (normalized.includes("CLAUDE.md")) {
        return "claude_md_local";
    }
    return "manual";
}
// Bug: 61bee4e — Exported for testing.
export function derivePresetName(filePath, source) {
    const normalized = filePath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    switch (source) {
        case "claude_md_global":
            return "Global CLAUDE.md";
        case "claude_md_project": {
            // Try to find repo name from path
            const claudeIdx = parts.lastIndexOf(".claude");
            if (claudeIdx > 0) {
                return `${parts[claudeIdx - 1]} CLAUDE.md`;
            }
            // Repo root CLAUDE.md
            const mdIdx = parts.lastIndexOf("CLAUDE.md");
            if (mdIdx > 0) {
                return `${parts[mdIdx - 1]} CLAUDE.md`;
            }
            return "Project CLAUDE.md";
        }
        case "claude_md_local":
            return "Local CLAUDE.md";
        default:
            return parts[parts.length - 1] ?? "Untitled Preset";
    }
}
// ---------------------------------------------------------------------------
// Full-Node Jaccard Routing (uses DB for node content)
// ---------------------------------------------------------------------------
/**
 * Enhanced routing that reads node content from the DB for better Jaccard scoring.
 */
export function routePresetDiffWithNodes(diffContent, sessionPresets, violationContext, db) {
    if (sessionPresets.length === 0) {
        return {
            recommendedPresetId: "",
            confidence: "low",
            reason: "No presets available",
        };
    }
    const diffWords = tokenize(diffContent);
    if (diffWords.size === 0) {
        // Bug: 61bee4e — Empty diff content: return empty recommendation with low confidence.
        return {
            recommendedPresetId: "",
            confidence: "low",
            reason: "Empty diff content, no recommendation",
        };
    }
    let bestId = "";
    let bestScore = -1;
    let bestReason = "";
    for (const preset of sessionPresets) {
        if (preset.source === "claude_md_global")
            continue;
        let score = 0;
        // Repo-specific signal
        if (violationContext.repo &&
            preset.source === "claude_md_project" &&
            preset.source_path?.includes(violationContext.repo)) {
            score += 0.3;
        }
        // Get all node content for this preset
        const nodes = db
            .prepare("SELECT title, body FROM preset_nodes WHERE preset_id = ?")
            .all(preset.id);
        const presetText = nodes.map((n) => `${n.title} ${n.body}`).join(" ");
        const presetWords = tokenize(presetText);
        score += jaccardSimilarity(diffWords, presetWords);
        if (score > bestScore) {
            bestScore = score;
            bestId = preset.id;
            bestReason =
                score > 0.5
                    ? `High content similarity with preset "${preset.name}"`
                    : score > 0.2
                        ? `Moderate content similarity with preset "${preset.name}"`
                        : `Best available match: preset "${preset.name}"`;
        }
    }
    // Bug: 61bee4e — If no matching preset found, return empty with low confidence.
    if (!bestId) {
        return {
            recommendedPresetId: "",
            confidence: "low",
            reason: "No matching preset found",
        };
    }
    const confidence = bestScore > 0.5 ? "high" : bestScore > 0.2 ? "medium" : "low";
    return {
        recommendedPresetId: bestId,
        confidence,
        reason: bestReason,
    };
}
