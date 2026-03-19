// Parser for Claude Code JSONL conversation files.
// Format: ~/.claude/projects/<encoded-path>/<uuid>.jsonl

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  BlockMetadata,
  ConversationBlock,
  ConversationParser,
  ParseResult,
} from "./types.js";

// --- Raw JSONL record shapes ---

interface ClaudeContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeMessage {
  role?: string;
  content?: string | ClaudeContentBlock[];
  model?: string;
  usage?: ClaudeUsage;
}

interface ClaudeRecord {
  uuid: string;
  parentUuid?: string;
  type: string;
  message?: ClaudeMessage;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isSnapshotUpdate?: boolean;
  userType?: string;
}

interface SessionsIndexEntry {
  sessionId: string;
  fullPath: string;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

interface SessionsIndex {
  version: number;
  originalPath?: string;
  entries: SessionsIndexEntry[];
}

// --- Helpers ---

function extractTextFromContent(content: string | ClaudeContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "thinking" && block.thinking) {
      parts.push(block.thinking);
    }
  }
  return parts.join("\n");
}

function tryReadSessionsIndex(jsonlPath: string): SessionsIndexEntry | null {
  try {
    const dir = path.dirname(jsonlPath);
    const indexPath = path.join(dir, "sessions-index.json");
    if (!fs.existsSync(indexPath)) return null;
    const raw = fs.readFileSync(indexPath, "utf8");
    const index = JSON.parse(raw) as SessionsIndex;
    const basename = path.basename(jsonlPath, ".jsonl");
    return index.entries.find((e) => e.sessionId === basename) ?? null;
  } catch {
    return null;
  }
}

// --- Parser ---

export class ClaudeParser implements ConversationParser {
  source = "claude_code" as const;

  canParse(filePath: string): boolean {
    // Match ~/.claude/projects/<encoded-path>/<uuid>.jsonl
    return filePath.endsWith(".jsonl") && filePath.includes("/.claude/projects/");
  }

  async parse(filePath: string): Promise<ParseResult | null> {
    const raw = await fs.promises.readFile(filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);

    const records: ClaudeRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as ClaudeRecord);
      } catch {
        // Skip malformed lines
      }
    }

    // Extract metadata from first non-snapshot record
    let sessionId = "";
    let cwd: string | null = null;
    let branch: string | null = null;
    let cliVersion: string | null = null;
    let model: string | null = null;
    let startedAt = "";
    let endedAt: string | null = null;

    for (const rec of records) {
      if (rec.type === "file-history-snapshot" || rec.isSnapshotUpdate) continue;
      if (!sessionId && rec.sessionId) sessionId = rec.sessionId;
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (!branch && rec.gitBranch) branch = rec.gitBranch;
      if (!cliVersion && rec.version) cliVersion = rec.version;
      if (!startedAt && rec.timestamp) startedAt = rec.timestamp;
      if (rec.timestamp) endedAt = rec.timestamp;
      if (!model && rec.type === "assistant" && rec.message?.model) {
        model = rec.message.model;
      }
    }

    // Fallback session ID from filename
    if (!sessionId) {
      sessionId = path.basename(filePath, ".jsonl");
    }

    // Try to get title/summary from sessions-index.json
    const indexEntry = tryReadSessionsIndex(filePath);
    let title = "";
    let summary: string | null = null;
    let projectPath: string | null = null;

    if (indexEntry) {
      title = indexEntry.summary || indexEntry.firstPrompt || "";
      summary = indexEntry.summary || null;
      projectPath = indexEntry.projectPath || null;
    }

    // Fallback title: first user message text
    if (!title) {
      for (const rec of records) {
        if (rec.type === "user" && !rec.isMeta && rec.message?.content) {
          title = extractTextFromContent(rec.message.content);
          break;
        }
      }
    }
    title = title.slice(0, 100).trim() || "Untitled";

    // Infer project path from file path if not from index
    if (!projectPath) {
      // Path structure: ~/.claude/projects/<encoded-path>/<uuid>.jsonl
      // encoded-path uses - for /
      const dir = path.dirname(filePath);
      const dirName = path.basename(dir);
      // Decode: "-Users-mll--dotfiles" → "/Users/mll/.dotfiles"
      // The encoding replaces / with - and . with - (first char only)
      projectPath = dirName;
    }

    // Parse blocks
    const blocks: Omit<ConversationBlock, "id" | "conversation_id">[] = [];
    let position = 0;
    // Map tool_use UUIDs to block positions for parent_id linking
    const toolUseMap = new Map<string, number>();

    for (const rec of records) {
      // Skip non-content records
      if (rec.type === "file-history-snapshot" || rec.isSnapshotUpdate) continue;
      if (rec.type === "progress") continue;

      const ts = rec.timestamp || startedAt || new Date().toISOString();

      if (rec.type === "user") {
        const content = rec.message?.content;
        if (!content) continue;

        if (typeof content === "string") {
          // Simple user message
          if (rec.isMeta) {
            // Meta/system messages (like initial context) — emit as system
            blocks.push({
              type: "system",
              role: "system",
              content,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: { source_event_type: "user_meta", visibility: "default_hidden" },
              dag_uuid: rec.uuid,
              dag_parent_uuid: rec.parentUuid ?? null,
            });
          } else {
            blocks.push({
              type: "user_message",
              role: "user",
              content,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {},
              dag_uuid: rec.uuid,
              dag_parent_uuid: rec.parentUuid ?? null,
            });
          }
        } else if (Array.isArray(content)) {
          // Array of content blocks (tool_results and text)
          for (const block of content) {
            if (block.type === "tool_result") {
              const toolOutput = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c) => c.text || "").join("\n")
                  : "";
              // Find matching tool_use position for parent_id
              const parentPos = block.tool_use_id ? toolUseMap.get(block.tool_use_id) : undefined;
              blocks.push({
                type: "tool_result",
                role: "tool",
                content: toolOutput,
                position: position++,
                timestamp: ts,
                parent_id: parentPos !== undefined ? String(parentPos) : null,
                metadata: {
                  tool_id: block.tool_use_id || undefined,
                  tool_output: toolOutput.length > 1000 ? undefined : toolOutput,
                  visibility: "default_hidden",
                },
                dag_uuid: rec.uuid,
                dag_parent_uuid: rec.parentUuid ?? null,
              });
            } else if (block.type === "text" && block.text) {
              blocks.push({
                type: "user_message",
                role: "user",
                content: block.text,
                position: position++,
                timestamp: ts,
                parent_id: null,
                metadata: {},
                dag_uuid: rec.uuid,
                dag_parent_uuid: rec.parentUuid ?? null,
              });
            }
          }
        }
      } else if (rec.type === "assistant") {
        const content = rec.message?.content;
        if (!content || typeof content === "string") {
          // Rare: assistant with string content
          if (content) {
            blocks.push({
              type: "assistant_message",
              role: "assistant",
              content,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: buildAssistantMetadata(rec),
              dag_uuid: rec.uuid,
              dag_parent_uuid: rec.parentUuid ?? null,
            });
          }
          continue;
        }

        // Array of content blocks
        for (const block of content) {
          if (block.type === "thinking" && block.thinking) {
            blocks.push({
              type: "thinking",
              role: "assistant",
              content: block.thinking,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {
                ...buildAssistantMetadata(rec),
                signature: block.signature || undefined,
                visibility: "default_hidden",
              },
              dag_uuid: rec.uuid,
              dag_parent_uuid: rec.parentUuid ?? null,
            });
          } else if (block.type === "text" && block.text) {
            blocks.push({
              type: "assistant_message",
              role: "assistant",
              content: block.text,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: buildAssistantMetadata(rec),
              dag_uuid: rec.uuid,
              dag_parent_uuid: rec.parentUuid ?? null,
            });
          } else if (block.type === "tool_use") {
            const toolPos = position;
            toolUseMap.set(block.id || "", toolPos);
            blocks.push({
              type: "tool_use",
              role: "assistant",
              content: block.name ? `${block.name}(${JSON.stringify(block.input)})` : "",
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {
                tool_name: block.name || undefined,
                tool_id: block.id || undefined,
                tool_input: block.input,
                visibility: "default_hidden",
                ...buildAssistantMetadata(rec),
              },
              dag_uuid: rec.uuid,
              dag_parent_uuid: rec.parentUuid ?? null,
            });
          }
        }
      } else if (rec.type === "system") {
        const content = extractTextFromContent(rec.message?.content);
        if (content) {
          blocks.push({
            type: "system",
            role: "system",
            content,
            position: position++,
            timestamp: ts,
            parent_id: null,
            metadata: { source_event_type: "system", visibility: "default_hidden" },
            dag_uuid: rec.uuid,
            dag_parent_uuid: rec.parentUuid ?? null,
          });
        }
      }
    }

    // Skip empty sessions (e.g., /usage commands, file-history-snapshots only)
    // Bug: d51fbc8 — empty JSONL sessions were polluting the conversation list
    if (blocks.length === 0) {
      return null;
    }

    // Compute source hash
    const sourceHash = crypto.createHash("sha256").update(raw).digest("hex");
    let sourceMtime = 0;
    try {
      const stat = await fs.promises.stat(filePath);
      sourceMtime = stat.mtimeMs;
    } catch {
      // ignore
    }

    return {
      conversation: {
        source: "claude_code",
        source_path: filePath,
        source_hash: sourceHash,
        source_mtime: sourceMtime,
        title,
        summary,
        started_at: startedAt || new Date().toISOString(),
        ended_at: endedAt,
        block_count: blocks.length,
        session_id: sessionId,
        project_path: projectPath,
        cwd,
        branch,
        model,
        cli_version: cliVersion,
      },
      blocks,
    };
  }
}

function buildAssistantMetadata(rec: ClaudeRecord): BlockMetadata {
  const meta: BlockMetadata = {};
  if (rec.message?.model) {
    meta.model = rec.message.model;
  }
  if (rec.message?.usage) {
    const u = rec.message.usage;
    meta.token_usage = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cache_read: u.cache_read_input_tokens,
    };
  }
  return meta;
}
