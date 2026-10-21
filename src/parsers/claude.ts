// Parser for Claude Code JSONL conversation files.
// Format: ~/.claude/projects/<encoded-path>/<uuid>.jsonl

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ActivityKind,
  BlockMetadata,
  ChatContentPart,
  ConversationBlock,
  ConversationParser,
  IncrementalParseInput,
  ParserSourceSnapshot,
  ParseResult,
} from "./types.js";
import type { ConversationParent } from "../conversation-lineage.js";
import { attachTranscriptChatItem } from "./types.js";
import { normalizeClaudeTranscriptUsage } from "./context-usage.js";
import { parseJsonlStringRecords, readJsonlFileRecords } from "./jsonl.js";

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
  id?: string;
  role?: string;
  content?: string | ClaudeContentBlock[];
  model?: string;
  usage?: ClaudeUsage;
}

interface ClaudeRecord {
  uuid: string;
  parentUuid?: string;
  type: string;
  aiTitle?: string;
  customTitle?: string;
  message?: ClaudeMessage;
  timestamp?: string;
  sessionId?: string;
  session_id?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isSnapshotUpdate?: boolean;
  userType?: string;
  subtype?: string;
  content?: string;
  level?: string;
  toolUseID?: string | null;
  parentToolUseID?: string | null;
  precedingToolUseIDs?: string[];
  preceding_tool_use_ids?: string[];
  summary?: string;
  tool_use_id?: string;
  parent_tool_use_id?: string | null;
  tool_name?: string;
  elapsed_time_seconds?: number;
  prevent_continuation?: boolean;
  data?: {
    type?: string;
    message?: unknown;
    tool_name?: string;
    toolName?: string;
    elapsed_time_seconds?: number;
    elapsedTimeSeconds?: number;
    hookName?: string;
    hookEvent?: string;
  };
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

export interface ClaudeSubagentPathInfo {
  parentSessionId: string;
  agentId: string;
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

export function parseClaudeSubagentPath(filePath: string): ClaudeSubagentPathInfo | null {
  const normalized = filePath.replace(/\\/g, "/");
  const workflowMatch = normalized.match(/\/([^/]+)\/subagents\/workflows\/wf_[^/]+\/agent-([^/]+)\.jsonl$/);
  if (workflowMatch) {
    return {
      parentSessionId: workflowMatch[1],
      agentId: workflowMatch[2],
    };
  }
  const match = normalized.match(/\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/);
  if (!match) return null;
  return {
    parentSessionId: match[1],
    agentId: match[2],
  };
}

/**
 * A subagent transcript's parent session and agent id. Current Claude nests it
 * under <parent>/subagents/; older Claude wrote a sibling agent-<id>.jsonl whose
 * sidechain records carry the parent's session id.
 */
export function claudeTranscriptLineage(
  filePath: string,
  sessionId: string,
  isSidechain: boolean,
): { parent: ConversationParent | null; agentId: string | null } {
  const nested = parseClaudeSubagentPath(filePath);
  if (nested) {
    return { parent: { source: "claude_code", sessionId: nested.parentSessionId }, agentId: nested.agentId };
  }
  const fileStem = path.basename(filePath, ".jsonl");
  const legacyAgentId = isSidechain && sessionId && sessionId !== fileStem
    ? fileStem.match(/^agent-(.+)$/)?.[1] ?? null
    : null;
  return legacyAgentId
    ? { parent: { source: "claude_code", sessionId }, agentId: legacyAgentId }
    : { parent: null, agentId: null };
}

// --- Parser ---

export class ClaudeParser implements ConversationParser {
  source = "claude_code" as const;

  canParse(filePath: string): boolean {
    // Match ~/.claude/projects/<encoded-path>/<uuid>.jsonl
    return filePath.endsWith(".jsonl") && filePath.includes("/.claude/projects/");
  }

  async parse(filePath: string): Promise<ParseResult | null> {
    const { records, sourceHash, sourceSnapshot } = await readJsonlFileRecords<ClaudeRecord>(filePath);
    let sourceMtime = 0;
    try {
      const stat = await fs.promises.stat(filePath);
      sourceMtime = stat.mtimeMs;
    } catch {
      // ignore
    }
    return this.parseRecords(filePath, records, {
      baseBlockCount: 0,
      baseRecordCount: 0,
      sourceHash,
      sourceMtime,
      sourceSnapshot,
    });
  }

  async parseIncremental(input: IncrementalParseInput): Promise<ParseResult | null> {
    return this.parseRecords(input.filePath, parseJsonlStringRecords<ClaudeRecord>(input.raw), {
      baseBlockCount: input.baseBlockCount,
      baseRecordCount: input.baseRecordCount ?? 0,
      nativeSessionId: input.nativeSessionId,
      sourceHash: input.sourceHash,
      sourceMtime: input.sourceMtime,
    });
  }

  private async parseRecords(
    filePath: string,
    records: ClaudeRecord[],
    options: {
      baseBlockCount: number;
      baseRecordCount: number;
      nativeSessionId?: string;
      sourceHash: string;
      sourceMtime: number;
      sourceSnapshot?: ParserSourceSnapshot;
    },
  ): Promise<ParseResult | null> {
    let hasSidechainRecord = false;
    for (const record of records) {
      if (record.isSidechain) {
        hasSidechainRecord = true;
      }
    }
    const subagentPath = parseClaudeSubagentPath(filePath);

    // Extract metadata from first non-snapshot record
    let sessionId = options.nativeSessionId ?? "";
    let cwd: string | null = null;
    let branch: string | null = null;
    let cliVersion: string | null = null;
    let model: string | null = null;
    let startedAt = "";
    let endedAt: string | null = null;
    let generatedProviderTitle = "";
    let customProviderTitle = "";

    for (const rec of records) {
      if (rec.type === "ai-title" && typeof rec.aiTitle === "string") {
        const candidate = rec.aiTitle.trim();
        if (candidate) generatedProviderTitle = candidate;
      }
      if (rec.type === "custom-title" && typeof rec.customTitle === "string") {
        const candidate = rec.customTitle.trim();
        if (candidate) customProviderTitle = candidate;
      }
      if (rec.type === "file-history-snapshot" || rec.isSnapshotUpdate) continue;
      if (!sessionId && (rec.sessionId || rec.session_id)) sessionId = rec.sessionId || rec.session_id || "";
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

    // Claude Code owns conversation titles. Explicit `/rename` custom-title
    // records outrank Claude's generated ai-title records, which in turn
    // outrank the generated sessions-index summary/firstPrompt and prompt
    // fallback. Keeping both provider record types above prompt fallback is
    // important for continued sessions whose first user record is a synthetic
    // context-transfer preamble rather than a useful title.
    const providerTitle = customProviderTitle || generatedProviderTitle;
    const providerTitleSource = customProviderTitle
      ? "custom-title" as const
      : generatedProviderTitle ? "ai-title" as const : undefined;
    if (providerTitle) {
      title = providerTitle;
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
      const dir = subagentPath ? path.dirname(path.dirname(path.dirname(filePath))) : path.dirname(filePath);
      const dirName = path.basename(dir);
      // Decode: "-home-alice--dotfiles" → "/home/alice/.dotfiles"
      // The encoding replaces / with - and . with - (first char only)
      projectPath = dirName;
    }

    // Parse blocks
    const blocks: Omit<ConversationBlock, "id" | "conversation_id">[] = [];
    let position = options.baseBlockCount;
    // Map tool_use UUIDs to block positions for parent_id linking
    const toolUseMap = new Map<string, number>();
    const toolNameMap = new Map<string, string>();
    const chatPartsByBlock = new Map<number, ChatContentPart[]>();

    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      const rec = records[recordIndex];
      const firstRecordBlock = blocks.length;
      // Skip non-content records
      if (rec.type === "file-history-snapshot" || rec.isSnapshotUpdate) continue;

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
              metadata: { source_event_type: "user" },
              dag_uuid: rec.uuid,
              dag_parent_uuid: rec.parentUuid ?? null,
            });
          }
        } else if (Array.isArray(content)) {
          // Array of content blocks (tool_results and text)
          for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
            const block = content[contentIndex];
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
                  tool_name: block.tool_use_id ? toolNameMap.get(block.tool_use_id) : undefined,
                  tool_kind: "claude_tool_result",
                  tool_output: toolOutput.length > 1000 ? undefined : toolOutput,
                  visibility: "default_hidden",
                  source_event_type: "tool_result",
                  provider_content_index: contentIndex,
                },
                dag_uuid: rec.uuid,
                dag_parent_uuid: rec.parentUuid ?? null,
              });
              chatPartsByBlock.set(blocks.length - 1, toolOutput
                ? [{ type: "text", text: toolOutput, native_index: contentIndex }]
                : []);
            } else if (block.type === "text" && block.text) {
              blocks.push({
                type: "user_message",
                role: "user",
                content: block.text,
                position: position++,
                timestamp: ts,
                parent_id: null,
                metadata: { source_event_type: "user", provider_content_index: contentIndex },
                dag_uuid: rec.uuid,
                dag_parent_uuid: rec.parentUuid ?? null,
              });
              chatPartsByBlock.set(blocks.length - 1, [{ type: "text", text: block.text, native_index: contentIndex }]);
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
              metadata: { ...buildAssistantMetadata(rec), source_event_type: "assistant" },
              dag_uuid: rec.uuid,
              dag_parent_uuid: rec.parentUuid ?? null,
            });
          }
          for (let index = firstRecordBlock; index < blocks.length; index += 1) {
            blocks[index].metadata.source_record_ordinal = options.baseRecordCount + recordIndex;
            blocks[index].metadata.source_sub_block_ordinal = index - firstRecordBlock;
          }
          continue;
        }

        // Array of content blocks
        for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
          const block = content[contentIndex];
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
                source_event_type: "thinking",
                provider_content_index: contentIndex,
              },
              dag_uuid: rec.uuid,
              dag_parent_uuid: rec.parentUuid ?? null,
            });
            chatPartsByBlock.set(blocks.length - 1, [{ type: "text", text: block.thinking, native_index: contentIndex }]);
          } else if (block.type === "text" && block.text) {
            blocks.push({
              type: "assistant_message",
              role: "assistant",
              content: block.text,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {
                ...buildAssistantMetadata(rec),
                source_event_type: "assistant",
                provider_content_index: contentIndex,
              },
              dag_uuid: rec.uuid,
              dag_parent_uuid: rec.parentUuid ?? null,
            });
            chatPartsByBlock.set(blocks.length - 1, [{ type: "text", text: block.text, native_index: contentIndex }]);
          } else if (block.type === "tool_use") {
            const toolPos = position;
            toolUseMap.set(block.id || "", toolPos);
            if (block.id && block.name) toolNameMap.set(block.id, block.name);
            blocks.push({
              type: "tool_use",
              role: "assistant",
              content: block.name ? `${block.name}(${JSON.stringify(block.input)})` : "",
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {
                tool_name: block.name || undefined,
                tool_kind: "claude_tool_use",
                tool_id: block.id || undefined,
                tool_input: block.input,
                visibility: "default_hidden",
                source_event_type: "tool_use",
                provider_content_index: contentIndex,
                ...buildAssistantMetadata(rec),
              },
              dag_uuid: rec.uuid,
              dag_parent_uuid: rec.parentUuid ?? null,
            });
          }
        }
      } else if (rec.type === "progress" || rec.type === "tool_progress") {
        const progressType = rec.type === "tool_progress" ? "tool_progress" : rec.data?.type || "progress";
        const text = typeof rec.data?.message === "string" ? rec.data.message : "";
        blocks.push({
          type: "event",
          role: "system",
          content: text,
          position: position++,
          timestamp: ts,
          parent_id: null,
          metadata: {
            source_event_type: `progress.${progressType}`,
            tool_id: rec.tool_use_id || rec.toolUseID || rec.parent_tool_use_id || rec.parentToolUseID || undefined,
            tool_name: rec.tool_name ?? rec.data?.tool_name ?? rec.data?.toolName ?? rec.data?.hookName,
          },
          dag_uuid: rec.uuid,
          dag_parent_uuid: rec.parentUuid ?? null,
        });
        if (text) chatPartsByBlock.set(blocks.length - 1, [{ type: "text", text }]);
      } else if (rec.type === "tool_use_summary") {
        const content = typeof rec.summary === "string" ? rec.summary : "";
        blocks.push({
          type: "event",
          role: "system",
          content,
          position: position++,
          timestamp: ts,
          parent_id: null,
          metadata: { source_event_type: "tool_use_summary" },
          dag_uuid: rec.uuid,
          dag_parent_uuid: rec.parentUuid ?? null,
        });
        if (content) chatPartsByBlock.set(blocks.length - 1, [{ type: "text", text: content }]);
      } else if (rec.type === "system") {
        const sourceEventType = rec.subtype || "system";
        const content = typeof rec.content === "string"
          ? rec.content
          : extractTextFromContent(rec.message?.content);
        if (content) {
          blocks.push({
            type: sourceEventType === "system" ? "system" : "event",
            role: "system",
            content,
            position: position++,
            timestamp: ts,
            parent_id: null,
            metadata: {
              source_event_type: sourceEventType,
              ...(sourceEventType === "system" ? { visibility: "default_hidden" as const } : {}),
              tool_id: rec.tool_use_id || rec.toolUseID || undefined,
            },
            dag_uuid: rec.uuid,
            dag_parent_uuid: rec.parentUuid ?? null,
          });
          chatPartsByBlock.set(blocks.length - 1, [{ type: "text", text: content }]);
        } else if (sourceEventType === "tool_use_summary" || sourceEventType === "status") {
          blocks.push({
            type: "event",
            role: "system",
            content: "",
            position: position++,
            timestamp: ts,
            parent_id: null,
            metadata: { source_event_type: sourceEventType, tool_id: rec.tool_use_id || rec.toolUseID || undefined },
            dag_uuid: rec.uuid,
            dag_parent_uuid: rec.parentUuid ?? null,
          });
        }
      }
      for (let index = firstRecordBlock; index < blocks.length; index += 1) {
        blocks[index].metadata.source_record_ordinal = options.baseRecordCount + recordIndex;
        blocks[index].metadata.source_sub_block_ordinal = index - firstRecordBlock;
        const block = blocks[index];
        const sourceEventType = block.metadata.source_event_type
          ?? (block.type === "user_message" ? "user" : block.type);
        const progress = sourceEventType.startsWith("progress.");
        const activityKind: ActivityKind | undefined = block.type === "thinking" ? "thinking"
          : sourceEventType === "tool_use_summary" ? "tool-summary"
          : sourceEventType === "informational" ? "information"
          : progress ? "tool-progress"
          : block.type === "event" ? "diagnostic"
          : undefined;
        if (!["user_meta", "system"].includes(sourceEventType)) {
          const elapsedSeconds = rec.elapsed_time_seconds
            ?? rec.data?.elapsed_time_seconds
            ?? rec.data?.elapsedTimeSeconds;
          attachTranscriptChatItem(block, {
            provider: "claude_code",
            sessionId,
            sourceEventType,
            sourceRecordOrdinal: options.baseRecordCount + recordIndex,
            sourceSubBlockOrdinal: index - firstRecordBlock,
            ...(chatPartsByBlock.has(index) ? { parts: chatPartsByBlock.get(index)! } : {}),
            ...(activityKind ? { activityKind } : {}),
            ...(rec.level === "error" ? { severity: "error" as const }
              : rec.level === "warning" ? { severity: "warning" as const }
              : {}),
            ...(progress ? { status: sourceEventType.slice("progress.".length) } : {}),
            ...(typeof elapsedSeconds === "number" ? { elapsedMs: elapsedSeconds * 1000 } : {}),
            ...((rec.precedingToolUseIDs ?? rec.preceding_tool_use_ids)?.length
              ? { relatedToolIds: rec.precedingToolUseIDs ?? rec.preceding_tool_use_ids }
              : {}),
          });
        }
      }
    }

    // Skip empty sessions (e.g., /usage commands, file-history-snapshots only)
    // Bug: d51fbc8 — empty JSONL sessions were polluting the conversation list
    if (blocks.length === 0 && !(providerTitle && options.baseBlockCount > 0)) {
      return null;
    }

    const lineage = claudeTranscriptLineage(filePath, sessionId, hasSidechainRecord);

    return {
      conversation: {
        source: "claude_code",
        source_path: filePath,
        source_hash: options.sourceHash,
        source_mtime: options.sourceMtime,
        title,
        summary,
        started_at: startedAt || new Date().toISOString(),
        ended_at: endedAt,
        block_count: options.baseBlockCount + blocks.length,
        session_id: sessionId,
        project_path: projectPath,
        cwd,
        branch,
        model,
        cli_version: cliVersion,
        is_sidechain: Boolean(subagentPath || hasSidechainRecord || indexEntry?.isSidechain),
        agent_id: lineage.agentId,
      },
      parent: lineage.parent,
      blocks,
      ...(options.sourceSnapshot ? { sourceSnapshot: options.sourceSnapshot } : {}),
      ...(providerTitle ? { providerTitle: title } : {}),
      ...(providerTitleSource ? { providerTitleSource } : {}),
    };
  }
}

function buildAssistantMetadata(rec: ClaudeRecord): BlockMetadata {
  const meta: BlockMetadata = {};
  if (rec.message?.id) {
    meta.provider_message_id = rec.message.id;
  }
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
    meta.usage_telemetry = normalizeClaudeTranscriptUsage(u, rec.message.model);
  }
  return meta;
}
