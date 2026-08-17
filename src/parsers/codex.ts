// Parser for Codex (OpenAI) JSONL conversation files.
// Format: ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<ULID>.jsonl
// Archived: ~/.codex/archived_sessions/rollout-<timestamp>-<ULID>.jsonl
// (`codex archive`/`codex unarchive` move the same file between those roots)
//
// Record types:
//   session_meta  — session metadata (id, cwd, git, model_provider, cli_version)
//   response_item — messages/reasoning/function calls
//   event_msg     — events (user_message, agent_message, token_count, etc.)
//   turn_context  — per-turn model/effort/cwd info

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ConversationBlock,
  ConversationParser,
  IncrementalParseInput,
  ParseResult,
} from "./types.js";
import { extractCodexTokenCountContextUsage } from "./context-usage.js";
import { parseJsonlStringRecords, readJsonlFileRecords } from "./jsonl.js";

// --- Raw record shapes ---

interface CodexSessionMeta {
  id: string;
  cwd?: string;
  cli_version?: string;
  model_provider?: string;
  source?: string;
  timestamp?: string;
  base_instructions?: string;
  git?: {
    commit_hash?: string;
    branch?: string;
    repository_url?: string;
  };
}

interface CodexContentBlock {
  type: string;
  text?: string;
  input_text?: string;
}

interface CodexResponsePayload {
  type: string;
  role?: string | null;
  content?: CodexContentBlock[];
  // function_call fields
  name?: string;
  call_id?: string;
  arguments?: string;
  // function_call_output fields
  output?: string;
  // reasoning fields
  summary?: string;
  encrypted_content?: string;
}

interface CodexTurnContext {
  model?: string;
  effort?: string;
  cwd?: string;
  approval_policy?: string;
  collaboration_mode?: string;
  sandbox_policy?: string;
  summary?: string;
  truncation_policy?: string;
  user_instructions?: string;
}

interface CodexEventMsg {
  type: string;
  message?: string;
  text_elements?: Array<{ text?: string }>;
  info?: unknown;
  rate_limits?: unknown;
  reason?: string;
}

interface CodexRecord {
  type: string;
  timestamp?: string;
  payload: CodexSessionMeta | CodexResponsePayload | CodexTurnContext | CodexEventMsg;
  // Legacy format (older sessions): top-level fields instead of payload wrapper
  id?: string;
  git?: { commit_hash?: string; branch?: string; repository_url?: string };
  instructions?: string;
}

interface CodexSessionIndexEntry {
  id?: string;
  thread_name?: string;
}

// --- Helpers ---

let sessionIndexCache: {
  path: string;
  mtimeMs: number;
  titles: Map<string, string>;
} | null = null;

function extractResponseItemText(payload: CodexResponsePayload): string {
  if (payload.content && Array.isArray(payload.content)) {
    const parts: string[] = [];
    for (const block of payload.content) {
      if (block.type === "output_text" && block.text) {
        parts.push(block.text);
      } else if (block.type === "input_text" && (block.text || block.input_text)) {
        parts.push(block.text || block.input_text || "");
      } else if (block.text) {
        parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function parseToolArguments(argumentsText: string | undefined): unknown {
  if (!argumentsText) {
    return undefined;
  }
  try {
    return JSON.parse(argumentsText);
  } catch {
    return argumentsText;
  }
}

export const CODEX_SESSIONS_DIR_NAME = "sessions";
export const CODEX_ARCHIVED_SESSIONS_DIR_NAME = "archived_sessions";

const CODEX_ROLLOUT_ROOT_NAMES: readonly string[] = [
  CODEX_SESSIONS_DIR_NAME,
  CODEX_ARCHIVED_SESSIONS_DIR_NAME,
];

interface CodexRolloutLocation {
  /** The `~/.codex` directory that owns the rollout file. */
  codexRoot: string;
  /** Either `sessions` or `archived_sessions`. */
  rootName: string;
  /** Rollout path relative to the `sessions`/`archived_sessions` root. */
  relative: string;
}

/**
 * Split a Codex rollout path into its owning `~/.codex` root, the rollout root
 * it currently lives under, and its relative location inside that root.
 *
 * `codex archive`/`codex unarchive` move rollout files between
 * `~/.codex/sessions/YYYY/MM/DD/` and the flat `~/.codex/archived_sessions/`,
 * so both roots describe the same conversation identity.
 */
function locateCodexRollout(filePath: string): CodexRolloutLocation | null {
  let dir = path.dirname(filePath);
  while (dir && dir !== path.dirname(dir)) {
    const name = path.basename(dir);
    if (CODEX_ROLLOUT_ROOT_NAMES.includes(name)) {
      return {
        codexRoot: path.dirname(dir),
        rootName: name,
        relative: path.relative(dir, filePath),
      };
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Codex rollout files live under `~/.codex/sessions` until `codex archive`
 * relocates them to `~/.codex/archived_sessions`. Both roots hold the same
 * files, so both are Codex sources.
 */
function isCodexRolloutSourcePath(filePath: string): boolean {
  return filePath.endsWith(".jsonl")
    && (filePath.includes("/.codex/sessions/") || filePath.includes("/.codex/archived_sessions/"));
}

export function isCodexRolloutPath(filePath: string): boolean {
  return isCodexRolloutSourcePath(filePath) && locateCodexRollout(filePath) !== null;
}

/**
 * Candidate paths the same rollout file would occupy after `codex archive` or
 * `codex unarchive` relocated it. Ordered most likely first; callers probe the
 * filesystem to find which one (if any) actually holds the moved file.
 */
export function codexRelocationCandidates(filePath: string): string[] {
  const location = locateCodexRollout(filePath);
  if (!location) return [];
  const base = path.basename(filePath);
  const candidates: string[] = [];
  const push = (candidate: string) => {
    if (candidate !== filePath && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  if (location.rootName === CODEX_SESSIONS_DIR_NAME) {
    // Archiving flattens the date directories.
    const archivedRoot = path.join(location.codexRoot, CODEX_ARCHIVED_SESSIONS_DIR_NAME);
    push(path.join(archivedRoot, base));
    push(path.join(archivedRoot, location.relative));
    return candidates;
  }

  // Unarchiving restores the date directories derived from the rollout name.
  const sessionsRoot = path.join(location.codexRoot, CODEX_SESSIONS_DIR_NAME);
  const dated = base.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (dated) {
    push(path.join(sessionsRoot, dated[1], dated[2], dated[3], base));
  }
  push(path.join(sessionsRoot, location.relative));
  push(path.join(sessionsRoot, base));
  return candidates;
}

export function getCodexSessionIndexPath(filePath: string): string | null {
  const location = locateCodexRollout(filePath);
  return location ? path.join(location.codexRoot, "session_index.jsonl") : null;
}

export async function loadCodexSessionIndexTitle(filePath: string, sessionId: string): Promise<string | null> {
  if (!sessionId) return null;
  const indexPath = getCodexSessionIndexPath(filePath);
  if (!indexPath) return null;
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(indexPath);
  } catch {
    return null;
  }

  if (!sessionIndexCache || sessionIndexCache.path !== indexPath || sessionIndexCache.mtimeMs !== stat.mtimeMs) {
    const titles = new Map<string, string>();
    try {
      const { records } = await readJsonlFileRecords<CodexSessionIndexEntry>(indexPath);
      for (const entry of records) {
        const title = typeof entry.thread_name === "string" ? entry.thread_name.trim() : "";
        if (entry.id && title) {
          titles.set(entry.id, title);
        }
      }
    } catch {
      return null;
    }
    sessionIndexCache = { path: indexPath, mtimeMs: stat.mtimeMs, titles };
  }

  return sessionIndexCache.titles.get(sessionId) ?? null;
}

// --- Parser ---

export class CodexParser implements ConversationParser {
  source = "codex" as const;

  canParse(filePath: string): boolean {
    // Archived rollouts are the same files after `codex archive` relocated
    // them; they stay parseable so archiving never drops ingested history.
    return isCodexRolloutSourcePath(filePath);
  }

  async parse(filePath: string): Promise<ParseResult | null> {
    const { records, sourceHash } = await readJsonlFileRecords<CodexRecord>(filePath);
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
    });
  }

  async parseIncremental(input: IncrementalParseInput): Promise<ParseResult | null> {
    return this.parseRecords(input.filePath, parseJsonlStringRecords<CodexRecord>(input.raw), {
      baseBlockCount: input.baseBlockCount,
      baseRecordCount: input.baseRecordCount ?? 0,
      sourceHash: input.sourceHash,
      sourceMtime: input.sourceMtime,
    });
  }

  private async parseRecords(
    filePath: string,
    records: CodexRecord[],
    options: { baseBlockCount: number; baseRecordCount: number; sourceHash: string; sourceMtime: number },
  ): Promise<ParseResult | null> {
    // Extract session metadata
    let sessionId = "";
    let cwd: string | null = null;
    let branch: string | null = null;
    let cliVersion: string | null = null;
    let model: string | null = null;
    let modelProvider: string | null = null;
    let startedAt = "";
    let endedAt: string | null = null;

    // Check for legacy format (single-line sessions with top-level fields)
    const firstRec = records[0];
    if (firstRec && !firstRec.type && firstRec.id) {
      // Legacy format: { id, git, instructions, timestamp }
      sessionId = firstRec.id;
      if (firstRec.git?.branch) branch = firstRec.git.branch;
      if (firstRec.timestamp) startedAt = firstRec.timestamp;
      endedAt = firstRec.timestamp || null;
    }

    // Process newer format records
    for (const rec of records) {
      if (!rec.type) continue;
      if (rec.timestamp) {
        if (!startedAt) startedAt = rec.timestamp;
        endedAt = rec.timestamp;
      }

      if (rec.type === "session_meta") {
        const meta = rec.payload as CodexSessionMeta;
        if (meta.id) sessionId = meta.id;
        if (meta.cwd) cwd = meta.cwd;
        if (meta.cli_version) cliVersion = meta.cli_version;
        if (meta.model_provider) modelProvider = meta.model_provider;
        if (meta.git?.branch) branch = meta.git.branch;
        if (meta.timestamp && !startedAt) startedAt = meta.timestamp;
      } else if (rec.type === "turn_context") {
        const ctx = rec.payload as CodexTurnContext;
        if (ctx.model && !model) model = ctx.model;
        if (ctx.cwd && !cwd) cwd = ctx.cwd;
      }
    }

    // Fallback session ID from filename: rollout-<timestamp>-<ULID>.jsonl
    if (!sessionId) {
      const basename = path.basename(filePath, ".jsonl");
      const match = basename.match(/rollout-.*-(.+)$/);
      sessionId = match ? match[1] : basename;
    }

    // Build title from Codex's local session index when available, falling back
    // to the first real user message rather than developer/system prompt.
    // Bug: d51fbc8 — developer role (AGENTS.md) content was being used as title.
    // In Codex, `role: "user"` response_items include system-injected context
    // (AGENTS.md, environment_context) before the actual user prompt. The real
    // user prompt appears as an event_msg with type "user_message". Prefer that
    // source, falling back to the last response_item user message only if needed.
    let title = (await loadCodexSessionIndexTitle(filePath, sessionId))?.slice(0, 100).trim() ?? "";
    let titleFromResponseItem = "";
    let seenNonUserResponse = false;
    if (!title) {
      for (const rec of records) {
        if (!rec.type) continue;
        if (rec.type === "event_msg") {
          const evt = rec.payload as CodexEventMsg;
          if (evt.type === "user_message" && evt.message) {
            title = evt.message.slice(0, 100).trim();
            break; // Best source found — stop searching
          }
        } else if (rec.type === "response_item" && !seenNonUserResponse) {
          const payload = rec.payload as CodexResponsePayload;
          if (payload.type === "message" && (payload.role === "user" || payload.role === "developer")) {
            if (payload.role === "user") {
              const text = extractResponseItemText(payload);
              if (text) {
                // Keep overwriting — the LAST initial user message is typically the
                // actual prompt; earlier ones are AGENTS.md and environment_context.
                titleFromResponseItem = text.slice(0, 100).trim();
              }
            }
          } else {
            // Stop scanning once we see the first non-user/non-developer response
            // (reasoning, function_call, assistant message, etc.)
            seenNonUserResponse = true;
          }
        }
      }
      if (!title) title = titleFromResponseItem;
    }

    // Parse blocks
    const blocks: Omit<ConversationBlock, "id" | "conversation_id">[] = [];
    let position = options.baseBlockCount;
    // Map call_id → position for linking function outputs to calls
    const callMap = new Map<string, number>();
    const callNameMap = new Map<string, string>();

    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      const rec = records[recordIndex];
      const firstRecordBlock = blocks.length;
      if (!rec.type) continue;
      const ts = rec.timestamp || startedAt || new Date().toISOString();

      if (rec.type === "response_item") {
        const payload = rec.payload as CodexResponsePayload;

        if (payload.type === "message") {
          const text = extractResponseItemText(payload);
          if (!text) continue;

          const role = payload.role;
          if (role === "developer") {
            blocks.push({
              type: "system",
              role: "system",
              content: text,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {
                source_event_type: "developer",
                visibility: "default_hidden",
              },
            });
          } else if (role === "user") {
            blocks.push({
              type: "user_message",
              role: "user",
              content: text,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: { source_event_type: "user" },
            });
          } else if (role === "assistant") {
            blocks.push({
              type: "assistant_message",
              role: "assistant",
              content: text,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: { model: model || undefined },
            });
          }
        } else if (payload.type === "reasoning") {
          const text = typeof payload.summary === "string" ? payload.summary.trim() : "";
          if (!text) continue;
          blocks.push({
            type: "thinking",
            role: "assistant",
            content: text,
            position: position++,
            timestamp: ts,
            parent_id: null,
            metadata: {
              model: model || undefined,
              visibility: "default_hidden",
              source_event_type: "reasoning",
            },
          });
        } else if (payload.type === "function_call") {
          const toolPos = position;
          if (payload.call_id) callMap.set(payload.call_id, toolPos);
          if (payload.call_id && payload.name) callNameMap.set(payload.call_id, payload.name);
          let content = payload.name || "unknown_function";
          if (payload.arguments) {
            content += `(${payload.arguments})`;
          }
          blocks.push({
            type: "tool_use",
            role: "assistant",
              content,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {
                tool_name: payload.name || undefined,
                tool_kind: "function_call",
                tool_id: payload.call_id || undefined,
                tool_input: parseToolArguments(payload.arguments),
                visibility: "default_hidden",
              },
            });
        } else if (payload.type === "function_call_output") {
          const parentPos = payload.call_id ? callMap.get(payload.call_id) : undefined;
          blocks.push({
            type: "tool_result",
            role: "tool",
            content: payload.output || "",
            position: position++,
            timestamp: ts,
            parent_id: parentPos !== undefined ? String(parentPos) : null,
            metadata: {
              tool_id: payload.call_id || undefined,
              tool_name: payload.call_id ? callNameMap.get(payload.call_id) : undefined,
              tool_kind: "function_call_output",
              tool_output: (payload.output || "").length > 1000 ? undefined : payload.output,
              visibility: "default_hidden",
            },
          });
        } else if (payload.type === "custom_tool_call") {
          const toolPos = position;
          if (payload.call_id) callMap.set(payload.call_id, toolPos);
          if (payload.call_id && payload.name) callNameMap.set(payload.call_id, payload.name);
          blocks.push({
            type: "tool_use",
            role: "assistant",
              content: payload.name || "custom_tool",
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {
                tool_name: payload.name || undefined,
                tool_kind: "custom_tool_call",
                tool_id: payload.call_id || undefined,
                tool_input: parseToolArguments(payload.arguments),
                visibility: "default_hidden",
              },
            });
        } else if (payload.type === "custom_tool_call_output") {
          const parentPos = payload.call_id ? callMap.get(payload.call_id) : undefined;
          blocks.push({
            type: "tool_result",
            role: "tool",
            content: payload.output || "",
            position: position++,
            timestamp: ts,
            parent_id: parentPos !== undefined ? String(parentPos) : null,
            metadata: {
              tool_id: payload.call_id || undefined,
              tool_name: payload.call_id ? callNameMap.get(payload.call_id) : undefined,
              tool_kind: "custom_tool_call_output",
              visibility: "default_hidden",
            },
          });
        }
      } else if (rec.type === "event_msg") {
        const evt = rec.payload as CodexEventMsg;
        if (evt.type === "token_count") {
          const contextUsage = extractCodexTokenCountContextUsage(evt);
          if (contextUsage) {
            blocks.push({
              type: "event",
              role: "system",
              content: "token_count",
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {
                source_event_type: "token_count",
                visibility: "default_hidden",
                context_usage: contextUsage,
              },
            });
          }
        }
        // agent_reasoning, context_compacted, turn_aborted — skip
        // user_message events are duplicates of response_item user messages
      }
      for (let index = firstRecordBlock; index < blocks.length; index += 1) {
        blocks[index].metadata.source_record_ordinal = options.baseRecordCount + recordIndex;
        blocks[index].metadata.source_sub_block_ordinal = index - firstRecordBlock;
      }
    }

    // Fallback title
    if (!title) title = "Codex Session";

    // Skip empty sessions — no meaningful content to display
    // Bug: d51fbc8 — empty sessions were polluting the conversation list
    if (blocks.length === 0) {
      return null;
    }

    return {
      conversation: {
        source: "codex",
        source_path: filePath,
        source_hash: options.sourceHash,
        source_mtime: options.sourceMtime,
        title,
        summary: null,
        started_at: startedAt || new Date().toISOString(),
        ended_at: endedAt,
        block_count: options.baseBlockCount + blocks.length,
        session_id: sessionId,
        project_path: null,
        cwd,
        branch,
        model: model || (modelProvider ? `${modelProvider}` : null),
        cli_version: cliVersion,
        is_sidechain: false,
        agent_id: null,
      },
      blocks,
    };
  }
}
