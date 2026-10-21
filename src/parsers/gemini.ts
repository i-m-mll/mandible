// Parser for Gemini CLI conversation files.
// Formats:
// - ~/.gemini/tmp/<project>/chats/session-<timestamp>-<uuid>.json
// - ~/.gemini/tmp/<project>/chats/session-<timestamp>-<uuid>.jsonl

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ConversationBlock,
  ConversationParser,
  IncrementalParseInput,
  ParseResult,
} from "./types.js";
import { attachTranscriptChatItem, firstUserMessageOpening } from "./types.js";

// --- Raw JSON shapes ---

interface GeminiTokens {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
}

interface GeminiThought {
  subject?: string;
  description?: string;
  timestamp?: string;
}

interface GeminiToolCall {
  id?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
}

interface GeminiMessage {
  id: string;
  timestamp?: string;
  type: string; // "user" | "gemini"
  content?: unknown;
  thoughts?: GeminiThought[];
  tokens?: GeminiTokens;
  model?: string;
  toolCalls?: GeminiToolCall[];
  plan?: unknown;
}

interface GeminiSession {
  sessionId: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages: GeminiMessage[];
}

interface GeminiJsonlUpdate {
  $set?: {
    lastUpdated?: string;
  };
}

type GeminiJsonlEntry = Partial<GeminiSession> | Partial<GeminiMessage> | GeminiJsonlUpdate;

interface GeminiProjectIdentity {
  projectPath: string | null;
  cwd: string | null;
}

interface GeminiProjectsFile {
  projects?: Record<string, string>;
}

let geminiProjectsCache: {
  path: string;
  mtimeMs: number;
  byHash: Map<string, string>;
  byAlias: Map<string, string>;
} | null = null;

function renderGeminiContent(content: unknown): string {
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
    const record = content as Record<string, unknown>;
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
    } catch {
      return "";
    }
  }
  return "";
}

function isSha256Hex(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function geminiSessionIdFromPath(filePath: string): string {
  return path.basename(filePath).replace(/\.(jsonl|json)$/i, "");
}

function parseGeminiSession(raw: string, filePath: string): GeminiSession {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { sessionId: geminiSessionIdFromPath(filePath), messages: [] };
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<GeminiSession>;
    if (Array.isArray(parsed.messages)) {
      return {
        sessionId: parsed.sessionId || geminiSessionIdFromPath(filePath),
        projectHash: parsed.projectHash,
        startTime: parsed.startTime,
        lastUpdated: parsed.lastUpdated,
        messages: parsed.messages,
      };
    }
  } catch {
    // Newer Gemini logs are JSONL, so a whole-file JSON parse is expected to fail.
  }

  const session: GeminiSession = {
    sessionId: geminiSessionIdFromPath(filePath),
    messages: [],
  };
  for (const line of raw.split(/\r?\n/)) {
    const lineTrimmed = line.trim();
    if (!lineTrimmed) continue;

    let entry: GeminiJsonlEntry;
    try {
      entry = JSON.parse(lineTrimmed) as GeminiJsonlEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;

    const update = entry as GeminiJsonlUpdate;
    if (update.$set) {
      if (typeof update.$set.lastUpdated === "string") {
        session.lastUpdated = update.$set.lastUpdated;
      }
      continue;
    }

    const record = entry as Partial<GeminiSession> & Partial<GeminiMessage>;
    if (typeof record.sessionId === "string") session.sessionId = record.sessionId;
    if (typeof record.projectHash === "string") session.projectHash = record.projectHash;
    if (typeof record.startTime === "string") session.startTime = record.startTime;
    if (typeof record.lastUpdated === "string") session.lastUpdated = record.lastUpdated;

    if (typeof record.type === "string" && typeof record.id === "string") {
      session.messages.push(record as GeminiMessage);
    }
  }

  return session;
}

function geminiTmpProjectDir(filePath: string): string | null {
  const chatsDir = path.dirname(filePath);
  if (path.basename(chatsDir) !== "chats") {
    return null;
  }
  return path.dirname(chatsDir);
}

function geminiRootForFile(filePath: string): string | null {
  const projectDir = geminiTmpProjectDir(filePath);
  if (!projectDir) return null;
  const tmpDir = path.dirname(projectDir);
  if (path.basename(tmpDir) !== "tmp") return null;
  return path.dirname(tmpDir);
}

async function readGeminiProjects(filePath: string): Promise<{
  byHash: Map<string, string>;
  byAlias: Map<string, string>;
} | null> {
  const geminiRoot = geminiRootForFile(filePath);
  if (!geminiRoot) return null;
  const projectsPath = path.join(geminiRoot, "projects.json");
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(projectsPath);
  } catch {
    return null;
  }

  if (!geminiProjectsCache || geminiProjectsCache.path !== projectsPath || geminiProjectsCache.mtimeMs !== stat.mtimeMs) {
    const byHash = new Map<string, string>();
    const byAlias = new Map<string, string>();
    try {
      const parsed = JSON.parse(await fs.promises.readFile(projectsPath, "utf8")) as GeminiProjectsFile;
      for (const [projectRoot, alias] of Object.entries(parsed.projects ?? {})) {
        const normalizedRoot = projectRoot.trim();
        if (!normalizedRoot) continue;
        const hash = crypto.createHash("sha256").update(normalizedRoot).digest("hex");
        byHash.set(hash, normalizedRoot);
        if (alias.trim()) {
          byAlias.set(alias.trim(), normalizedRoot);
        }
      }
    } catch {
      return null;
    }
    geminiProjectsCache = { path: projectsPath, mtimeMs: stat.mtimeMs, byHash, byAlias };
  }

  return {
    byHash: geminiProjectsCache.byHash,
    byAlias: geminiProjectsCache.byAlias,
  };
}

export async function inferGeminiProjectIdentity(
  filePath: string,
  projectHash: string | null | undefined,
): Promise<GeminiProjectIdentity> {
  const projectDir = geminiTmpProjectDir(filePath);
  const alias = projectDir ? path.basename(projectDir) : "";

  if (projectDir) {
    try {
      const projectRoot = (await fs.promises.readFile(path.join(projectDir, ".project_root"), "utf8")).trim();
      if (projectRoot) {
        return { projectPath: projectRoot, cwd: projectRoot };
      }
    } catch {
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

export class GeminiParser implements ConversationParser {
  source = "gemini" as const;

  canParse(filePath: string): boolean {
    // Match ~/.gemini/tmp/<project>/chats/session-*.json or .jsonl
    return (
      /\.(jsonl|json)$/i.test(filePath) &&
      filePath.includes("/.gemini/tmp/") &&
      filePath.includes("/chats/session-")
    );
  }

  async parse(filePath: string): Promise<ParseResult | null> {
    const raw = await fs.promises.readFile(filePath, "utf8");
    let sourceMtime = 0;
    try {
      const stat = await fs.promises.stat(filePath);
      sourceMtime = stat.mtimeMs;
    } catch {
      // ignore
    }
    return this.parseRaw(filePath, raw, {
      baseBlockCount: 0,
      baseRecordCount: 0,
      sourceHash: crypto.createHash("sha256").update(raw).digest("hex"),
      sourceMtime,
    });
  }

  async parseIncremental(input: IncrementalParseInput): Promise<ParseResult | null> {
    if (!input.filePath.endsWith(".jsonl")
        && !(input.filePath.endsWith(".json") && input.baseBlockCount === 0)) {
      return null;
    }
    return this.parseRaw(input.filePath, input.raw, {
      baseBlockCount: input.baseBlockCount,
      baseRecordCount: input.baseRecordCount ?? 0,
      sourceHash: input.sourceHash,
      sourceMtime: input.sourceMtime,
    });
  }

  private async parseRaw(
    filePath: string,
    raw: string,
    options: { baseBlockCount: number; baseRecordCount: number; sourceHash: string; sourceMtime: number },
  ): Promise<ParseResult | null> {
    const session = parseGeminiSession(raw, filePath);

    const sessionId = session.sessionId || geminiSessionIdFromPath(filePath);
    const projectHash = session.projectHash || null;
    const projectIdentity = await inferGeminiProjectIdentity(filePath, projectHash);
    const startedAt = session.startTime || new Date().toISOString();
    const endedAt = session.lastUpdated || null;

    // Extract model from first gemini message
    let model: string | null = null;
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
    if (!title) title = "Gemini Session";

    // Parse blocks
    const blocks: Omit<ConversationBlock, "id" | "conversation_id">[] = [];
    let position = options.baseBlockCount;

    for (const [messageIndex, msg] of session.messages.entries()) {
      const ts = msg.timestamp || startedAt;
      let sourceSubBlockOrdinal = 0;
      const appendBlock = (
        block: Omit<ConversationBlock, "id" | "conversation_id">,
        sourceEventType: string,
        activityKind?: "thinking",
      ) => {
        block.metadata.provider_message_id = msg.id;
        block.metadata.provider_content_index = sourceSubBlockOrdinal;
        block.metadata.source_event_type = sourceEventType;
        attachTranscriptChatItem(block, {
          provider: "gemini",
          sessionId,
          sourceEventType,
          sourceRecordOrdinal: options.baseRecordCount + messageIndex,
          sourceSubBlockOrdinal,
          ...(activityKind ? { activityKind } : {}),
        });
        sourceSubBlockOrdinal += 1;
        blocks.push(block);
      };

      if (msg.type === "user") {
        const rendered = renderGeminiContent(msg.content);
        appendBlock({
          type: "user_message",
          role: "user",
          content: rendered,
          position: position++,
          timestamp: ts,
          parent_id: null,
          metadata: {},
        }, "gemini_user_message");
      } else if (msg.type === "gemini") {
        // Emit thinking blocks first (they precede the response)
        if (msg.thoughts && msg.thoughts.length > 0) {
          for (const thought of msg.thoughts) {
            const content = thought.description || thought.subject || "";
            if (!content) continue;
            const label = thought.subject ? `[${thought.subject}] ` : "";
            appendBlock({
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
            }, "gemini_thought", "thinking");
          }
        }

        const plan = renderGeminiContent(msg.plan).trim();
        if (plan) {
          appendBlock({
            type: "plan",
            role: "assistant",
            content: plan,
            position: position++,
            timestamp: ts,
            parent_id: null,
            metadata: {
              model: msg.model || undefined,
              source_event_type: "gemini_plan",
            },
          }, "gemini_plan");
        }

        // Emit tool calls before the main message
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            const toolPos = position;
            // tool_use block
            const toolContent = tc.name
              ? `${tc.name}(${JSON.stringify(tc.args)})`
              : JSON.stringify(tc.args);
            appendBlock({
              type: "tool_use",
              role: "assistant",
              content: toolContent,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {
                tool_name: tc.name || undefined,
                tool_kind: "gemini_tool_call",
                tool_id: tc.id || undefined,
                tool_input: tc.args,
                visibility: "default_hidden",
                model: msg.model || undefined,
              },
            }, "gemini_tool_call");

            // tool_result block (if result exists)
            if (tc.result !== undefined && tc.result !== null) {
              const resultStr = typeof tc.result === "string"
                ? tc.result
                : JSON.stringify(tc.result);
              appendBlock({
                type: "tool_result",
                role: "tool",
                content: resultStr,
                position: position++,
                timestamp: ts,
                parent_id: String(toolPos),
                metadata: {
                  tool_id: tc.id || undefined,
                  tool_name: tc.name || undefined,
                  tool_kind: "gemini_tool_result",
                  tool_output: resultStr.length > 1000 ? undefined : resultStr,
                  visibility: "default_hidden",
                },
              }, "gemini_tool_result");
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

          appendBlock({
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
          }, "gemini_message");
        }
      }
    }

    // Skip empty sessions — no meaningful content to display
    if (blocks.length === 0) {
      return null;
    }

    return {
      conversation: {
        source: "gemini",
        source_path: filePath,
        source_hash: options.sourceHash,
        source_mtime: options.sourceMtime,
        title,
        summary: null,
        started_at: startedAt,
        ended_at: endedAt,
        block_count: options.baseBlockCount + blocks.length,
        session_id: sessionId,
        project_path: projectIdentity.projectPath,
        cwd: projectIdentity.cwd,
        branch: null,
        model,
        cli_version: null,
        is_sidechain: false,
        agent_id: null,
      },
      parent: null,
      opening: firstUserMessageOpening(blocks, options.baseBlockCount === 0),
      createdByAgent: false,
      blocks,
    };
  }
}
