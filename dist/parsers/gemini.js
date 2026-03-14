// Parser for Gemini CLI JSON conversation files.
// Format: ~/.gemini/tmp/<project_hash>/chats/session-<timestamp>-<uuid>.json
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
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
// --- Parser ---
export class GeminiParser {
    source = "gemini";
    canParse(filePath) {
        // Match ~/.gemini/tmp/<hash>/chats/session-*.json
        return (filePath.endsWith(".json") &&
            filePath.includes("/.gemini/tmp/") &&
            filePath.includes("/chats/session-"));
    }
    async parse(filePath) {
        const raw = await fs.promises.readFile(filePath, "utf8");
        const session = JSON.parse(raw);
        const sessionId = session.sessionId || path.basename(filePath, ".json");
        const projectHash = session.projectHash || null;
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
                project_path: projectHash,
                cwd: null,
                branch: null,
                model,
                cli_version: null,
            },
            blocks,
        };
    }
}
