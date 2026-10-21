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
  ActivityKind,
  ChatContentPart,
  ConversationBlock,
  ConversationParser,
  IncrementalParseInput,
  ParserSourceSnapshot,
  ParseResult,
  TranscriptOpening,
} from "./types.js";
import type { ConversationParent } from "../conversation-lineage.js";
import { readOpeningLine } from "../lineage-marker.js";
import { attachTranscriptChatItem } from "./types.js";
import { normalizeCodexTokenCount } from "./context-usage.js";
import { findJsonlRecord, parseJsonlStringRecords, readJsonlFileRecords } from "./jsonl.js";

// --- Raw record shapes ---

interface CodexSessionMeta {
  id: string;
  cwd?: string;
  cli_version?: string;
  model_provider?: string;
  source?: CodexSessionSource;
  thread_source?: string;
  parent_thread_id?: string | null;
  agent_nickname?: string | null;
  timestamp?: string;
  base_instructions?: string;
  git?: {
    commit_hash?: string;
    branch?: string;
    repository_url?: string;
  };
}

/** `session_meta.source`: a launcher name, or the spawn record of a subagent thread. */
export type CodexSessionSource = string | {
  subagent?: {
    thread_spawn?: {
      parent_thread_id?: string | null;
      agent_nickname?: string | null;
    };
    other?: string;
  };
};

/** What a rollout header says about the thread's place under another thread. */
export interface CodexThreadLineage {
  parent: ConversationParent | null;
  isSubagent: boolean;
  agentId: string | null;
}

/**
 * Read subagent lineage from a rollout header's fields. Codex writes the parent
 * thread into `source.subagent.thread_spawn` for `spawn_agent` children, and
 * into the top-level `parent_thread_id` for its own internal subagents.
 */
export function codexThreadLineage(meta: {
  source?: CodexSessionSource | null;
  thread_source?: string | null;
  parent_thread_id?: string | null;
  agent_nickname?: string | null;
}): CodexThreadLineage {
  const subagent = typeof meta.source === "object" && meta.source ? meta.source.subagent : undefined;
  const spawn = subagent?.thread_spawn;
  const parentThreadId = subagent ? spawn?.parent_thread_id ?? meta.parent_thread_id : null;
  return {
    parent: typeof parentThreadId === "string" && parentThreadId.trim()
      ? { source: "codex", sessionId: parentThreadId }
      : null,
    isSubagent: Boolean(subagent) || meta.thread_source === "subagent",
    agentId: spawn?.agent_nickname ?? meta.agent_nickname ?? subagent?.other ?? null,
  };
}

interface CodexContentBlock {
  type: string;
  text?: string;
  input_text?: string;
}

interface CodexResponsePayload {
  type: string;
  id?: string;
  role?: string | null;
  content?: CodexContentBlock[] | null;
  // function_call fields
  name?: string;
  call_id?: string | null;
  arguments?: string;
  // custom_tool_call input is an opaque provider payload. It is display-only
  // and must not be parsed or normalized.
  input?: string;
  // function_call_output fields
  output?: string | CodexContentBlock[];
  // reasoning fields
  summary?: string | CodexContentBlock[];
  encrypted_content?: string;
  internal_chat_message_metadata_passthrough?: {
    turn_id?: string;
  };
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
  client_id?: string;
  message?: string;
  text_elements?: Array<{ text?: string }>;
  info?: unknown;
  rate_limits?: unknown;
  reason?: string;
  turn_id?: string;
  duration_ms?: number;
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

function codexTextParts(blocks: CodexContentBlock[] | null | undefined): ChatContentPart[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block, nativeIndex) => {
    const text = block.text ?? block.input_text;
    return typeof text === "string" && text.length > 0
      ? [{ type: "text" as const, text, native_index: nativeIndex }]
      : [];
  });
}

function codexSummaryParts(summary: CodexResponsePayload["summary"]): ChatContentPart[] {
  if (typeof summary === "string") {
    return summary.trim() ? [{ type: "text", text: summary }] : [];
  }
  return codexTextParts(summary);
}

function codexToolOutputText(output: CodexResponsePayload["output"]): string {
  if (typeof output === "string") return output;
  return codexTextParts(output).map((part) => part.text).join("\n");
}

function providerTurnId(payload: CodexResponsePayload): string | undefined {
  const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
  return typeof turnId === "string" && turnId ? turnId : undefined;
}

function isInjectedUserContext(payload: CodexResponsePayload): boolean {
  if (!Array.isArray(payload.content) || payload.content.length < 2) return false;
  const prefixes = [
    "<recommended_plugins>",
    "# AGENTS.md instructions",
    "<environment_context>",
    "<skills_instructions>",
    "<permissions instructions>",
  ];
  return payload.content.every((block) => {
    const text = block.text ?? block.input_text ?? "";
    return prefixes.some((prefix) => text.startsWith(prefix));
  });
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

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Codex records a delegated task's real launch prompt in the successful
 * create_thread transport receipt rather than as a normal user response item.
 * Recognize only that exact envelope; all other identity-less transport output
 * remains provider bookkeeping and stays out of the transcript.
 */
/** A message another Codex thread delivered through the app's thread tools. */
export interface CodexDelegation {
  sourceThreadId: string | null;
  prompt: string;
}

/** Unwrap a `<codex_delegation>` envelope; null for any other text. */
export function parseCodexDelegation(text: string): CodexDelegation | null {
  const envelope = text.trim();
  if (!envelope.startsWith("<codex_delegation>") || !envelope.endsWith("</codex_delegation>")) {
    return null;
  }
  const input = envelope.match(/<input>([\s\S]*?)<\/input>/);
  const prompt = input ? decodeXmlText(input[1]).trim() : "";
  if (!prompt) return null;
  const source = envelope.match(/<source_thread_id>\s*([^<\s]+)\s*<\/source_thread_id>/);
  return { sourceThreadId: source ? source[1] : null, prompt };
}

/** The delegation that created this thread, carried by a `create_thread` output record. */
function createThreadDelegation(payload: CodexResponsePayload): CodexDelegation | null {
  if (payload.name !== "create_thread" || typeof payload.output !== "string") return null;
  return parseCodexDelegation(payload.output);
}

/**
 * Read a first user message for its lineage marker. A message delivered in a
 * delegation envelope is read from its prompt, and the envelope's source
 * thread is the thread that delivered it.
 */
function codexOpening(text: string, atStart: boolean): TranscriptOpening {
  const delegation = parseCodexDelegation(text);
  return {
    line: readOpeningLine(delegation?.prompt ?? text),
    creator: delegation?.sourceThreadId ? { source: "codex", sessionId: delegation.sourceThreadId } : null,
    atStart,
  };
}

type CodexFunctionCallOutputClassification =
  | "provider_transport"
  | "transcript_tool_result";

/**
 * Codex Desktop records control-plane operation output as a
 * function_call_output without transcript call identity. Only outputs carrying
 * a real call_id belong to the transcript tool-call graph; whether that call
 * can be paired is a separate diagnostic concern.
 */
function classifyFunctionCallOutput(
  payload: CodexResponsePayload,
): CodexFunctionCallOutputClassification {
  return typeof payload.call_id === "string" && payload.call_id.length > 0
    ? "transcript_tool_result"
    : "provider_transport";
}

export const CODEX_SESSIONS_DIR_NAME = "sessions";
export const CODEX_ARCHIVED_SESSIONS_DIR_NAME = "archived_sessions";

const CODEX_ROLLOUT_ROOT_NAMES: readonly string[] = [
  CODEX_SESSIONS_DIR_NAME,
  CODEX_ARCHIVED_SESSIONS_DIR_NAME,
];

export interface CodexRolloutLocation {
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
export function locateCodexRollout(filePath: string): CodexRolloutLocation | null {
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

/** True when two paths name the same rollout before/after Codex archive relocation. */
export function codexRolloutPathsEquivalent(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (normalizedLeft === normalizedRight) return true;
  const leftLocation = locateCodexRollout(normalizedLeft);
  const rightLocation = locateCodexRollout(normalizedRight);
  if (!leftLocation || !rightLocation || leftLocation.codexRoot !== rightLocation.codexRoot) return false;
  return codexRelocationCandidates(normalizedLeft).map((candidate) => path.resolve(candidate)).includes(normalizedRight)
    || codexRelocationCandidates(normalizedRight).map((candidate) => path.resolve(candidate)).includes(normalizedLeft);
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

/** Read the provider-authored session id without accepting the filename fallback. */
export async function loadCodexNativeSessionId(filePath: string): Promise<string | null> {
  const record = await findJsonlRecord<CodexRecord>(
    filePath,
    (candidate) => candidate.type === "session_meta",
  );
  const id = record ? (record.payload as CodexSessionMeta).id : null;
  return typeof id === "string" && id.trim() ? id : null;
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
    const { records, sourceHash, sourceSnapshot } = await readJsonlFileRecords<CodexRecord>(filePath);
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
    return this.parseRecords(input.filePath, parseJsonlStringRecords<CodexRecord>(input.raw), {
      baseBlockCount: input.baseBlockCount,
      baseRecordCount: input.baseRecordCount ?? 0,
      nativeSessionId: input.nativeSessionId,
      sourceHash: input.sourceHash,
      sourceMtime: input.sourceMtime,
    });
  }

  private async parseRecords(
    filePath: string,
    records: CodexRecord[],
    options: {
      baseBlockCount: number;
      baseRecordCount: number;
      nativeSessionId?: string;
      sourceHash: string;
      sourceMtime: number;
      sourceSnapshot?: ParserSourceSnapshot;
    },
  ): Promise<ParseResult | null> {
    // Extract session metadata
    let sessionId = options.nativeSessionId ?? "";
    let cwd: string | null = null;
    let branch: string | null = null;
    let cliVersion: string | null = null;
    let model: string | null = null;
    let modelProvider: string | null = null;
    let startedAt = "";
    let endedAt: string | null = null;
    let seenSessionMeta = false;
    let lineage: CodexThreadLineage = { parent: null, isSubagent: false, agentId: null };
    let createdByAgent = false;
    let opening: TranscriptOpening | null = null;

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
        // Forked Codex rollouts may include parent history containing another
        // session_meta record. The first record owns this file; later records
        // describe embedded ancestry and must not replace its identity.
        if (!seenSessionMeta) {
          const meta = rec.payload as CodexSessionMeta;
          if (meta.id) sessionId = meta.id;
          if (meta.cwd) cwd = meta.cwd;
          if (meta.cli_version) cliVersion = meta.cli_version;
          if (meta.model_provider) modelProvider = meta.model_provider;
          if (meta.git?.branch) branch = meta.git.branch;
          if (meta.timestamp && !startedAt) startedAt = meta.timestamp;
          lineage = codexThreadLineage(meta);
          createdByAgent = meta.thread_source === "agent_created_thread";
          seenSessionMeta = true;
        }
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
    const chatPartsByBlock = new Map<number, ChatContentPart[]>();
    let pendingUserBlockIndex: number | null = null;

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
          const messageParts = codexTextParts(payload.content);

          const role = payload.role;
          const turnId = providerTurnId(payload);
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
          } else if (role === "user" && isInjectedUserContext(payload)) {
            blocks.push({
              type: "system",
              role: "system",
              content: text,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {
                source_event_type: "user_meta",
                visibility: "default_hidden",
                provider_turn_id: turnId,
              },
            });
          } else if (role === "user") {
            opening ??= codexOpening(text, options.baseBlockCount === 0);
            blocks.push({
              type: "user_message",
              role: "user",
              content: text,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {
                source_event_type: "user",
                provider_turn_id: turnId,
              },
            });
            pendingUserBlockIndex = blocks.length - 1;
            chatPartsByBlock.set(blocks.length - 1, messageParts);
          } else if (role === "assistant") {
            blocks.push({
              type: "assistant_message",
              role: "assistant",
              content: text,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: { model: model || undefined, source_event_type: "assistant" },
            });
            chatPartsByBlock.set(blocks.length - 1, messageParts);
          }
        } else if (payload.type === "reasoning") {
          const summaryParts = codexSummaryParts(payload.summary);
          if (summaryParts.length > 0) {
            blocks.push({
              type: "thinking",
              role: "assistant",
              content: summaryParts.map((part) => part.text).join("\n"),
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {
                model: model || undefined,
                visibility: "default_hidden",
                source_event_type: "reasoning_summary",
              },
            });
            chatPartsByBlock.set(blocks.length - 1, summaryParts);
          }
          const reasoningParts = codexTextParts(payload.content);
          if (reasoningParts.length > 0) {
            blocks.push({
              type: "thinking",
              role: "assistant",
              content: reasoningParts.map((part) => part.text).join("\n"),
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: {
                model: model || undefined,
                visibility: "default_hidden",
                source_event_type: "reasoning_content",
              },
            });
            chatPartsByBlock.set(blocks.length - 1, reasoningParts);
          }
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
                source_event_type: "function_call",
              },
            });
        } else if (payload.type === "function_call_output") {
          if (classifyFunctionCallOutput(payload) === "provider_transport") {
            const delegation = createThreadDelegation(payload);
            if (!delegation) continue;
            const prompt = delegation.prompt;
            opening ??= codexOpening(payload.output as string, options.baseBlockCount === 0);
            blocks.push({
              type: "user_message",
              role: "user",
              content: prompt,
              position: position++,
              timestamp: ts,
              parent_id: null,
              metadata: { source_event_type: "codex_delegation" },
            });
            pendingUserBlockIndex = blocks.length - 1;
            chatPartsByBlock.set(blocks.length - 1, [{ type: "text", text: prompt }]);
          } else {
            const output = codexToolOutputText(payload.output);
            const parentPos = payload.call_id ? callMap.get(payload.call_id) : undefined;
            blocks.push({
              type: "tool_result",
              role: "tool",
              content: output,
              position: position++,
              timestamp: ts,
              parent_id: parentPos !== undefined ? String(parentPos) : null,
              metadata: {
                tool_id: payload.call_id || undefined,
                tool_name: payload.call_id ? callNameMap.get(payload.call_id) : undefined,
                tool_kind: "function_call_output",
                tool_output: output.length > 1000 ? undefined : output,
                visibility: "default_hidden",
                source_event_type: "function_call_output",
              },
            });
          }
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
                tool_input: payload.input ?? payload.arguments,
                visibility: "default_hidden",
                source_event_type: "custom_tool_call",
              },
            });
        } else if (payload.type === "custom_tool_call_output") {
          const output = codexToolOutputText(payload.output);
          const parentPos = payload.call_id ? callMap.get(payload.call_id) : undefined;
          blocks.push({
            type: "tool_result",
            role: "tool",
            content: output,
            position: position++,
            timestamp: ts,
            parent_id: parentPos !== undefined ? String(parentPos) : null,
            metadata: {
              tool_id: payload.call_id || undefined,
              tool_name: payload.call_id ? callNameMap.get(payload.call_id) : undefined,
              tool_kind: "custom_tool_call_output",
              tool_output: output.length > 1000 ? undefined : output,
              visibility: "default_hidden",
              source_event_type: "custom_tool_call_output",
            },
          });
        }
      } else if (rec.type === "event_msg") {
        const evt = rec.payload as CodexEventMsg;
        if (evt.type === "user_message") {
          if (pendingUserBlockIndex !== null && typeof evt.client_id === "string" && evt.client_id) {
            blocks[pendingUserBlockIndex].dag_uuid = evt.client_id;
            blocks[pendingUserBlockIndex].metadata.client_intent_id = evt.client_id;
          }
          pendingUserBlockIndex = null;
        } else if (evt.type === "token_count") {
          const usageTelemetry = normalizeCodexTokenCount(evt);
          if (usageTelemetry) {
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
                usage_telemetry: usageTelemetry,
              },
            });
          }
        } else if (evt.type === "task_started" || evt.type === "task_complete"
          || evt.type === "turn_aborted" || evt.type === "context_compacted") {
          blocks.push({
            type: "event",
            role: "system",
            content: typeof evt.message === "string" ? evt.message : typeof evt.reason === "string" ? evt.reason : "",
            position: position++,
            timestamp: ts,
            parent_id: null,
            metadata: {
              source_event_type: evt.type,
              provider_turn_id: evt.turn_id,
            },
          });
        } else if (!["agent_message", "agent_reasoning", "item_started", "item_completed", "thread_settings_applied"].includes(evt.type)) {
          blocks.push({
            type: "event",
            role: "system",
            content: typeof evt.message === "string" ? evt.message : typeof evt.reason === "string" ? evt.reason : "",
            position: position++,
            timestamp: ts,
            parent_id: null,
            metadata: { source_event_type: evt.type },
          });
        }
        // Mirror/delta and settings records remain provider bookkeeping.
      }
      for (let index = firstRecordBlock; index < blocks.length; index += 1) {
        blocks[index].metadata.source_record_ordinal = options.baseRecordCount + recordIndex;
        blocks[index].metadata.source_sub_block_ordinal = index - firstRecordBlock;
        if (rec.type === "response_item") {
          const providerMessageId = (rec.payload as CodexResponsePayload).id;
          if (typeof providerMessageId === "string" && providerMessageId) {
            blocks[index].metadata.provider_message_id = providerMessageId;
            blocks[index].dag_uuid = providerMessageId;
          }
        }
        const block = blocks[index];
        const sourceEventType = block.metadata.source_event_type
          ?? (block.type === "user_message" ? "user" : block.type);
        const activityKind: ActivityKind | undefined = sourceEventType === "reasoning_summary"
          ? "reasoning-summary"
          : sourceEventType === "reasoning_content" ? "thinking"
          : sourceEventType === "turn_aborted" ? "diagnostic"
          : ["task_started", "task_complete", "context_compacted"].includes(sourceEventType) ? "status"
          : block.type === "event" && sourceEventType !== "token_count" ? "diagnostic"
          : undefined;
        if (!["developer", "user_meta", "token_count"].includes(sourceEventType)) {
          attachTranscriptChatItem(block, {
            provider: "codex",
            sessionId,
            sourceEventType,
            sourceRecordOrdinal: options.baseRecordCount + recordIndex,
            sourceSubBlockOrdinal: index - firstRecordBlock,
            ...(chatPartsByBlock.has(index) ? { parts: chatPartsByBlock.get(index)! } : {}),
            ...(activityKind ? { activityKind } : {}),
            ...(sourceEventType === "turn_aborted" ? { severity: "warning" as const, status: "aborted", executionOutcome: "cancelled" as const }
              : sourceEventType === "task_started" ? { status: "started" }
              : sourceEventType === "task_complete" ? { status: "complete" }
              : sourceEventType === "context_compacted" ? { status: "compacted" }
              : block.type === "event" ? { status: sourceEventType, severity: "warning" as const }
              : {}),
          });
        }
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
        is_sidechain: lineage.isSubagent,
        agent_id: lineage.agentId,
      },
      parent: lineage.parent,
      opening,
      createdByAgent,
      blocks,
      ...(options.sourceSnapshot ? { sourceSnapshot: options.sourceSnapshot } : {}),
    };
  }
}
