// Parser for Gemini CLI conversation files.
// Formats:
// - ~/.gemini/tmp/<project>/chats/session-<timestamp>-<uuid>.json
// - ~/.gemini/tmp/<project>/chats/session-<timestamp>-<uuid>.jsonl
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
let geminiProjectsCache = null;
function renderGeminiContent(content) {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((item) => renderGeminiContent(item))
            .filter(Boolean)
            .join("\n");
    }
    if (content && typeof content === "object") {
        const record = content;
        if (typeof record.text === "string") {
            return record.text;
        }
        if (typeof record.content === "string") {
            return record.content;
        }
        if (Array.isArray(record.parts)) {
            return renderGeminiContent(record.parts);
        }
        try {
            return JSON.stringify(record);
        }
        catch {
            return "";
        }
    }
    return "";
}
function isSha256Hex(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function geminiSessionIdFromPath(filePath) {
    return path.basename(filePath).replace(/\.(jsonl|json)$/i, "");
}
function parseGeminiSession(raw, filePath) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return { sessionId: geminiSessionIdFromPath(filePath), messages: [] };
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed.messages)) {
            return {
                sessionId: parsed.sessionId || geminiSessionIdFromPath(filePath),
                projectHash: parsed.projectHash,
                startTime: parsed.startTime,
                lastUpdated: parsed.lastUpdated,
                messages: parsed.messages,
            };
        }
    }
    catch {
        // Newer Gemini logs are JSONL, so a whole-file JSON parse is expected to fail.
    }
    const session = {
        sessionId: geminiSessionIdFromPath(filePath),
        messages: [],
    };
    for (const line of raw.split(/\r?\n/)) {
        const lineTrimmed = line.trim();
        if (!lineTrimmed)
            continue;
        let entry;
        try {
            entry = JSON.parse(lineTrimmed);
        }
        catch {
            continue;
        }
        if (!entry || typeof entry !== "object")
            continue;
        const update = entry;
        if (update.$set) {
            if (typeof update.$set.lastUpdated === "string") {
                session.lastUpdated = update.$set.lastUpdated;
            }
            continue;
        }
        const record = entry;
        if (typeof record.sessionId === "string")
            session.sessionId = record.sessionId;
        if (typeof record.projectHash === "string")
            session.projectHash = record.projectHash;
        if (typeof record.startTime === "string")
            session.startTime = record.startTime;
        if (typeof record.lastUpdated === "string")
            session.lastUpdated = record.lastUpdated;
        if (typeof record.type === "string" && typeof record.id === "string") {
            session.messages.push(record);
        }
    }
    return session;
}
function geminiTmpProjectDir(filePath) {
    const chatsDir = path.dirname(filePath);
    if (path.basename(chatsDir) !== "chats") {
        return null;
    }
    return path.dirname(chatsDir);
}
function geminiRootForFile(filePath) {
    const projectDir = geminiTmpProjectDir(filePath);
    if (!projectDir)
        return null;
    const tmpDir = path.dirname(projectDir);
    if (path.basename(tmpDir) !== "tmp")
        return null;
    return path.dirname(tmpDir);
}
async function readGeminiProjects(filePath) {
    const geminiRoot = geminiRootForFile(filePath);
    if (!geminiRoot)
        return null;
    const projectsPath = path.join(geminiRoot, "projects.json");
    let stat;
    try {
        stat = await fs.promises.stat(projectsPath);
    }
    catch {
        return null;
    }
    if (!geminiProjectsCache || geminiProjectsCache.path !== projectsPath || geminiProjectsCache.mtimeMs !== stat.mtimeMs) {
        const byHash = new Map();
        const byAlias = new Map();
        try {
            const parsed = JSON.parse(await fs.promises.readFile(projectsPath, "utf8"));
            for (const [projectRoot, alias] of Object.entries(parsed.projects ?? {})) {
                const normalizedRoot = projectRoot.trim();
                if (!normalizedRoot)
                    continue;
                const hash = crypto.createHash("sha256").update(normalizedRoot).digest("hex");
                byHash.set(hash, normalizedRoot);
                if (alias.trim()) {
                    byAlias.set(alias.trim(), normalizedRoot);
                }
            }
        }
        catch {
            return null;
        }
        geminiProjectsCache = { path: projectsPath, mtimeMs: stat.mtimeMs, byHash, byAlias };
    }
    return {
        byHash: geminiProjectsCache.byHash,
        byAlias: geminiProjectsCache.byAlias,
    };
}
export async function inferGeminiProjectIdentity(filePath, projectHash) {
    const projectDir = geminiTmpProjectDir(filePath);
    const alias = projectDir ? path.basename(projectDir) : "";
    if (projectDir) {
        try {
            const projectRoot = (await fs.promises.readFile(path.join(projectDir, ".project_root"), "utf8")).trim();
            if (projectRoot) {
                return { projectPath: projectRoot, cwd: projectRoot };
            }
        }
        catch {
            // Older Gemini temp directories may not have a project-root sidecar.
        }
    }
    const projects = await readGeminiProjects(filePath);
    const normalizedHash = typeof projectHash === "string" ? projectHash.trim().toLowerCase() : "";
    const rootFromHash = normalizedHash ? projects?.byHash.get(normalizedHash) : null;
    if (rootFromHash) {
        return { projectPath: rootFromHash, cwd: rootFromHash };
    }
    const rootFromAlias = alias ? projects?.byAlias.get(alias) : null;
    if (rootFromAlias) {
        return { projectPath: rootFromAlias, cwd: rootFromAlias };
    }
    if (alias && !isSha256Hex(alias)) {
        return { projectPath: alias, cwd: null };
    }
    return { projectPath: null, cwd: null };
}
// --- Parser ---
export class GeminiParser {
    source = "gemini";
    canParse(filePath) {
        // Match ~/.gemini/tmp/<project>/chats/session-*.json or .jsonl
        return (/\.(jsonl|json)$/i.test(filePath) &&
            filePath.includes("/.gemini/tmp/") &&
            filePath.includes("/chats/session-"));
    }
    async parse(filePath) {
        const raw = await fs.promises.readFile(filePath, "utf8");
        const session = parseGeminiSession(raw, filePath);
        const sessionId = session.sessionId || geminiSessionIdFromPath(filePath);
        const projectHash = session.projectHash || null;
        const projectIdentity = await inferGeminiProjectIdentity(filePath, projectHash);
        const startedAt = session.startTime || new Date().toISOString();
        const endedAt = session.lastUpdated || null;
        // Extract model from first gemini message
        let model = null;
        for (const msg of session.messages) {
            if (msg.type === "gemini" && msg.model) {
                model = msg.model;
                break;
            }
        }
        // Title from first user message
        let title = "";
        for (const msg of session.messages) {
            const rendered = renderGeminiContent(msg.content).trim();
            if (msg.type === "user" && rendered) {
                title = rendered.slice(0, 100).trim();
                break;
            }
        }
        if (!title)
            title = "Gemini Session";
        // Parse blocks
        const blocks = [];
        let position = 0;
        for (const msg of session.messages) {
            const ts = msg.timestamp || startedAt;
            if (msg.type === "user") {
                const rendered = renderGeminiContent(msg.content);
                blocks.push({
                    type: "user_message",
                    role: "user",
                    content: rendered,
                    position: position++,
                    timestamp: ts,
                    parent_id: null,
                    metadata: {},
                });
            }
            else if (msg.type === "gemini") {
                // Emit thinking blocks first (they precede the response)
                if (msg.thoughts && msg.thoughts.length > 0) {
                    for (const thought of msg.thoughts) {
                        const content = thought.description || thought.subject || "";
                        if (!content)
                            continue;
                        const label = thought.subject ? `[${thought.subject}] ` : "";
                        blocks.push({
                            type: "thinking",
                            role: "assistant",
                            content: `${label}${thought.description || ""}`.trim(),
                            position: position++,
                            timestamp: thought.timestamp || ts,
                            parent_id: null,
                            metadata: {
                                model: msg.model || undefined,
                                visibility: "default_hidden",
                                source_event_type: "gemini_thought",
                            },
                        });
                    }
                }
                // Emit tool calls before the main message
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    for (const tc of msg.toolCalls) {
                        const toolPos = position;
                        // tool_use block
                        const toolContent = tc.name
                            ? `${tc.name}(${JSON.stringify(tc.args)})`
                            : JSON.stringify(tc.args);
                        blocks.push({
                            type: "tool_use",
                            role: "assistant",
                            content: toolContent,
                            position: position++,
                            timestamp: ts,
                            parent_id: null,
                            metadata: {
                                tool_name: tc.name || undefined,
                                tool_id: tc.id || undefined,
                                tool_input: tc.args,
                                visibility: "default_hidden",
                                model: msg.model || undefined,
                            },
                        });
                        // tool_result block (if result exists)
                        if (tc.result !== undefined && tc.result !== null) {
                            const resultStr = typeof tc.result === "string"
                                ? tc.result
                                : JSON.stringify(tc.result);
                            blocks.push({
                                type: "tool_result",
                                role: "tool",
                                content: resultStr,
                                position: position++,
                                timestamp: ts,
                                parent_id: String(toolPos),
                                metadata: {
                                    tool_id: tc.id || undefined,
                                    tool_output: resultStr.length > 1000 ? undefined : resultStr,
                                    visibility: "default_hidden",
                                },
                            });
                        }
                    }
                }
                // Main assistant message
                const rendered = renderGeminiContent(msg.content);
                if (rendered) {
                    const tokenUsage = msg.tokens
                        ? {
                            input: msg.tokens.input ?? 0,
                            output: msg.tokens.output ?? 0,
                            cache_read: msg.tokens.cached,
                        }
                        : undefined;
                    blocks.push({
                        type: "assistant_message",
                        role: "assistant",
                        content: rendered,
                        position: position++,
                        timestamp: ts,
                        parent_id: null,
                        metadata: {
                            model: msg.model || undefined,
                            token_usage: tokenUsage,
                        },
                    });
                }
            }
        }
        // Skip empty sessions — no meaningful content to display
        if (blocks.length === 0) {
            return null;
        }
        const sourceHash = crypto.createHash("sha256").update(raw).digest("hex");
        let sourceMtime = 0;
        try {
            const stat = await fs.promises.stat(filePath);
            sourceMtime = stat.mtimeMs;
        }
        catch {
            // ignore
        }
        return {
            conversation: {
                source: "gemini",
                source_path: filePath,
                source_hash: sourceHash,
                source_mtime: sourceMtime,
                title,
                summary: null,
                started_at: startedAt,
                ended_at: endedAt,
                block_count: blocks.length,
                session_id: sessionId,
                project_path: projectIdentity.projectPath,
                cwd: projectIdentity.cwd,
                branch: null,
                model,
                cli_version: null,
            },
            blocks,
        };
    }
}
