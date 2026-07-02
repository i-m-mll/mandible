import { randomUUID } from "node:crypto";
import type { PermissionDecision, PermissionRequest } from "../agentic-backend.js";
import type { ConsoleStreamEvent } from "../types.js";

export type JsonRpcId = string | number | null;

export interface AcpJsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface AcpToolCallState {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  status: string | null;
}

export interface AcpMapperState {
  sessionId: string | null;
  model: string | null;
  turnCount: number;
  cumulativeUsage: Record<string, unknown> | null;
  toolCalls: Map<string, AcpToolCallState>;
}

export interface AcpPermissionEnvelope {
  responseId: JsonRpcId;
  request: PermissionRequest;
  options: AcpPermissionOption[];
}

export interface AcpPermissionOption {
  optionId: string;
  kind: string;
  name?: string;
}

export interface AcpNormalizeResult {
  events: ConsoleStreamEvent[];
  permission?: AcpPermissionEnvelope;
}

export function createAcpMapperState(options: {
  sessionId?: string | null;
  model?: string | null;
} = {}): AcpMapperState {
  return {
    sessionId: options.sessionId ?? null,
    model: options.model ?? null,
    turnCount: 0,
    cumulativeUsage: null,
    toolCalls: new Map(),
  };
}

export function parseAcpNdjsonLine(line: string): AcpJsonRpcMessage | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    return parsed as AcpJsonRpcMessage;
  } catch {
    return null;
  }
}

export function makeAcpUserEvent(prompt: string, sessionId: string): ConsoleStreamEvent {
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  };
}

export function normalizeAcpIncoming(
  message: AcpJsonRpcMessage,
  state: AcpMapperState,
  consoleSessionId: string,
  now = Date.now(),
): AcpNormalizeResult {
  const method = typeof message.method === "string" ? message.method : "";
  const params = asRecord(message.params) ?? {};

  if (isPermissionMethod(method)) {
    return {
      events: [],
      permission: normalizePermissionRequest(message.id ?? null, params, consoleSessionId, now),
    };
  }

  if (isSessionUpdateMethod(method)) {
    return { events: normalizeSessionUpdate(params, state) };
  }

  if (message.id !== undefined && message.result !== undefined) {
    return { events: normalizeRpcResult(message.result, state) };
  }

  if (message.error !== undefined) {
    return {
      events: [makeErrorResult(String(extractErrorMessage(message.error)), state.sessionId ?? consoleSessionId)],
    };
  }

  return { events: [] };
}

export function acpPermissionOutcome(decision: PermissionDecision): string {
  if (decision === "allow_always") {
    return "allow_always";
  }
  if (decision === "allow") {
    return "allow_once";
  }
  if (decision === "reject_always") {
    return "reject_always";
  }
  return "reject_once";
}

export function normalizeAcpUsage(usage: unknown): Record<string, unknown> {
  const raw = asRecord(usage) ?? {};
  const input =
    numberValue(raw.input_tokens)
    ?? numberValue(raw.inputTokens)
    ?? numberValue(raw.prompt_tokens)
    ?? numberValue(raw.promptTokens)
    ?? 0;
  const output =
    numberValue(raw.output_tokens)
    ?? numberValue(raw.outputTokens)
    ?? numberValue(raw.completion_tokens)
    ?? numberValue(raw.completionTokens)
    ?? 0;
  const cacheRead =
    numberValue(raw.cache_read_input_tokens)
    ?? numberValue(raw.cacheReadInputTokens)
    ?? numberValue(raw.cached_tokens)
    ?? numberValue(raw.cachedTokens)
    ?? 0;

  return {
    ...raw,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
  };
}

function normalizePermissionRequest(
  responseId: JsonRpcId,
  params: Record<string, unknown>,
  consoleSessionId: string,
  now: number,
): AcpPermissionEnvelope {
  const tool = asRecord(params.toolCall) ?? asRecord(params.tool) ?? params;
  const toolName =
    stringValue(tool.name)
    ?? stringValue(tool.title)
    ?? stringValue(tool.kind)
    ?? stringValue(tool.toolName)
    ?? stringValue(params.toolName)
    ?? stringValue(params.name)
    ?? "tool";
  const toolInput =
    tool.input
    ?? tool.rawInput
    ?? tool.arguments
    ?? params.input
    ?? params.arguments
    ?? {};
  const id =
    stringValue(params.permissionId)
    ?? stringValue(params.requestId)
    ?? stringValue(tool.toolCallId)
    ?? stringValue(responseId)
    ?? randomUUID();
  const options = normalizePermissionOptions(params.options);

  return {
    responseId,
    options,
    request: {
      id,
      session_id: consoleSessionId,
      tool_name: toolName,
      tool_input: toolInput,
      created_at: now,
      expires_at: now + 120_000,
      title: stringValue(params.title) ?? `Allow ${toolName}?`,
      display_name: stringValue(params.displayName) ?? stringValue(params.display_name) ?? undefined,
      description: stringValue(params.description) ?? undefined,
      blocked_path: stringValue(params.blockedPath) ?? stringValue(params.blocked_path) ?? undefined,
      decision_reason: stringValue(params.decisionReason) ?? stringValue(params.decision_reason) ?? undefined,
      agent_id: stringValue(params.agentId) ?? stringValue(params.agent_id) ?? undefined,
    },
  };
}

function normalizeSessionUpdate(
  params: Record<string, unknown>,
  state: AcpMapperState,
): ConsoleStreamEvent[] {
  const sessionId =
    stringValue(params.sessionId)
    ?? stringValue(params.session_id)
    ?? stringValue(params.session)
    ?? state.sessionId
    ?? "";
  if (sessionId) {
    state.sessionId = sessionId;
  }

  const rawUpdates = params.update ?? params.updates ?? params.event ?? params;
  const updates = Array.isArray(rawUpdates) ? rawUpdates : [rawUpdates];
  const events: ConsoleStreamEvent[] = [];

  for (const raw of updates) {
    const update = asRecord(raw);
    if (!update) {
      continue;
    }
    events.push(...normalizeSingleUpdate(update, state, sessionId));
  }

  return events;
}

function normalizeSingleUpdate(
  update: Record<string, unknown>,
  state: AcpMapperState,
  fallbackSessionId: string,
): ConsoleStreamEvent[] {
  const kind = (
    stringValue(update.type)
    ?? stringValue(update.kind)
    ?? stringValue(update.updateType)
    ?? stringValue(update.sessionUpdate)
    ?? ""
  ).toLowerCase();
  const sessionId =
    stringValue(update.sessionId)
    ?? stringValue(update.session_id)
    ?? state.sessionId
    ?? fallbackSessionId;

  const model = stringValue(update.model);
  if (model) {
    state.model = model;
  }

  if (kind === "session_started" || kind === "session_created" || kind === "init") {
    return [{
      type: "system",
      subtype: "init",
      session_id: sessionId,
      ...(state.model ? { model: state.model } : {}),
      event: update,
    }];
  }

  if (kind === "usage_update" || update.usage !== undefined) {
    state.cumulativeUsage = normalizeAcpUsage(update.usage ?? update);
    return [];
  }

  if (kind === "config_option_update" || Array.isArray(update.configOptions)) {
    return [{
      type: "system",
      subtype: "acp_config_options",
      session_id: sessionId,
      config_options: Array.isArray(update.configOptions) ? update.configOptions : [],
      event: update,
    }];
  }

  const terminalOutput = extractTerminalOutput(update);
  if (terminalOutput) {
    return [{
      type: "tool_result",
      session_id: sessionId,
      tool_use_id: terminalOutput.terminalId,
      is_error: false,
      content: terminalOutput.output,
      event: update,
    }];
  }

  if (kind.includes("plan") || update.plan !== undefined || Array.isArray(update.entries)) {
    return [makeAssistantContentEvent(
      sessionId,
      [{ type: "plan", text: stringifyPlan(update.plan ?? update.entries ?? update.content ?? update.text ?? "") }],
      state.model,
      update,
    )];
  }

  if (kind === "tool_call" || kind === "tool_call_update" || update.toolCallId || update.tool_call_id) {
    return normalizeToolCall(update, state, sessionId);
  }

  if (kind === "complete" || kind === "completed" || kind === "session_complete") {
    state.turnCount += 1;
    return [{
      type: "result",
      subtype: "success",
      session_id: sessionId,
      duration_ms: numberValue(update.duration_ms) ?? numberValue(update.durationMs) ?? 0,
      num_turns: state.turnCount,
      total_cost_usd: numberValue(update.total_cost_usd) ?? 0,
      is_error: false,
      ...(state.cumulativeUsage ? { usage: state.cumulativeUsage } : {}),
      event: update,
    }];
  }

  if (kind === "cancelled" || kind === "canceled") {
    state.turnCount += 1;
    return [{
      type: "result",
      subtype: "cancelled",
      session_id: sessionId,
      duration_ms: numberValue(update.duration_ms) ?? numberValue(update.durationMs) ?? 0,
      num_turns: state.turnCount,
      total_cost_usd: numberValue(update.total_cost_usd) ?? 0,
      is_error: true,
      errors: ["cancelled"],
      stopReason: "cancelled",
      event: update,
    }];
  }

  if (kind === "error" || kind === "failed") {
    return [makeErrorResult(
      stringValue(update.message) ?? stringValue(update.error) ?? "ACP request failed",
      sessionId,
      update,
    )];
  }

  const role = stringValue(update.role);
  const text = extractText(update);
  if (role === "user") {
    return [{
      type: "user",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text }] },
      event: update,
    }];
  }
  if (role === "assistant" || kind === "message" || kind === "agent_message" || kind === "text") {
    return [makeAssistantContentEvent(
      sessionId,
      [{ type: "text", text }],
      state.model,
      update,
    )];
  }

  return [{
    type: "system",
    subtype: kind || "acp_update",
    session_id: sessionId,
    event: update,
  }];
}

function normalizeToolCall(
  update: Record<string, unknown>,
  state: AcpMapperState,
  sessionId: string,
): ConsoleStreamEvent[] {
  const toolCallId =
    stringValue(update.toolCallId)
    ?? stringValue(update.tool_call_id)
    ?? stringValue(update.id)
    ?? randomUUID();
  const existing = state.toolCalls.get(toolCallId);
  const next: AcpToolCallState = {
    id: toolCallId,
    name:
      stringValue(update.name)
      ?? stringValue(update.title)
      ?? stringValue(update.toolName)
      ?? stringValue(update.tool_name)
      ?? stringValue(update.kind)
      ?? existing?.name
      ?? "tool",
    input:
      update.input
      ?? update.rawInput
      ?? update.arguments
      ?? update.args
      ?? existing?.input
      ?? {},
    output:
      update.output
      ?? update.rawOutput
      ?? update.result
      ?? update.content
      ?? existing?.output
      ?? null,
    status:
      stringValue(update.status)
      ?? stringValue(update.state)
      ?? existing?.status
      ?? null,
  };
  state.toolCalls.set(toolCallId, next);

  if (!isTerminalToolStatus(next.status)) {
    return [];
  }

  state.toolCalls.delete(toolCallId);
  const failed = next.status === "failed" || next.status === "error";
  return [
    {
      type: "tool_use",
      session_id: sessionId,
      parent_tool_use_id: null,
      tool_use_id: next.id,
      name: next.name,
      input: next.input,
      event: update,
    },
    {
      type: "tool_result",
      session_id: sessionId,
      tool_use_id: next.id,
      is_error: failed,
      content: stringifyContent(next.output),
      event: update,
    },
  ];
}

function normalizeRpcResult(result: unknown, state: AcpMapperState): ConsoleStreamEvent[] {
  const record = asRecord(result);
  if (!record) {
    return [];
  }
  const sessionId =
    stringValue(record.sessionId)
    ?? stringValue(record.session_id)
    ?? stringValue(record.id)
    ?? state.sessionId
    ?? "";
  if (sessionId) {
    state.sessionId = sessionId;
  }
  const model = stringValue(record.model);
  if (model) {
    state.model = model;
  }
  if (sessionId || model) {
    return [{
      type: "system",
      subtype: "init",
      session_id: sessionId,
      ...(state.model ? { model: state.model } : {}),
      ...(Array.isArray(record.configOptions) ? { config_options: record.configOptions } : {}),
      ...(record.sessionCapabilities ? { session_capabilities: record.sessionCapabilities } : {}),
      event: record,
    }];
  }
  if (Array.isArray(record.configOptions)) {
    return [{
      type: "system",
      subtype: "acp_config_options",
      session_id: state.sessionId ?? "",
      config_options: record.configOptions,
      event: record,
    }];
  }
  return [];
}

function makeAssistantContentEvent(
  sessionId: string,
  content: Array<{ type: "text" | "thinking" | "tool_use" | "tool_result" | "plan"; text?: string }>,
  model: string | null,
  event: Record<string, unknown>,
): ConsoleStreamEvent {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      ...(model ? { model } : {}),
      content,
    },
    event,
  };
}

function makeErrorResult(message: string, sessionId: string, event?: Record<string, unknown>): ConsoleStreamEvent {
  return {
    type: "result",
    subtype: "error_during_execution",
    session_id: sessionId,
    duration_ms: 0,
    num_turns: 0,
    total_cost_usd: 0,
    is_error: true,
    errors: [message],
    ...(event ? { event } : {}),
  };
}

function isPermissionMethod(method: string): boolean {
  const normalized = method.toLowerCase();
  return normalized === "requestpermission"
    || normalized === "request_permission"
    || normalized === "session/requestpermission"
    || normalized === "session/request_permission"
    || normalized === "canusetool"
    || normalized === "can_use_tool";
}

function isSessionUpdateMethod(method: string): boolean {
  const normalized = method.toLowerCase();
  return normalized === "sessionupdate"
    || normalized === "session_update"
    || normalized === "session/update"
    || normalized === "client/sessionupdate"
    || normalized === "client/session_update";
}

function isTerminalToolStatus(status: string | null): boolean {
  return status === "completed"
    || status === "complete"
    || status === "failed"
    || status === "error"
    || status === "cancelled"
    || status === "canceled";
}

function normalizePermissionOptions(value: unknown): AcpPermissionOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((option) => {
    const record = asRecord(option);
    const optionId = stringValue(record?.optionId);
    const kind = stringValue(record?.kind);
    if (!optionId || !kind) {
      return [];
    }
    return [{
      optionId,
      kind,
      ...(stringValue(record?.name) ? { name: stringValue(record?.name)! } : {}),
    }];
  });
}

function stringifyPlan(value: unknown): string {
  const record = asRecord(value);
  if (Array.isArray(value)) {
    return value.map(formatPlanEntry).filter(Boolean).join("\n");
  }
  if (Array.isArray(record?.entries)) {
    return record.entries.map(formatPlanEntry).filter(Boolean).join("\n");
  }
  if (typeof record?.content === "string") {
    return record.content;
  }
  return stringifyContent(value);
}

function formatPlanEntry(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return stringifyContent(value);
  }
  const status = stringValue(record.status);
  const content = stringValue(record.content) ?? stringifyContent(record);
  return status ? `[${status}] ${content}` : content;
}

function extractTerminalOutput(update: Record<string, unknown>): { terminalId: string; output: string } | null {
  const meta = asRecord(update._meta);
  const terminalOutput =
    asRecord(meta?.terminal_output)
    ?? asRecord(meta?.terminal_output_delta)
    ?? asRecord(update.terminal_output)
    ?? asRecord(update.terminalOutput);
  if (!terminalOutput) {
    return null;
  }
  const output =
    rawStringValue(terminalOutput.output)
    ?? rawStringValue(terminalOutput.data);
  if (output === null) {
    return null;
  }
  const terminalId =
    stringValue(terminalOutput?.terminal_id)
    ?? stringValue(terminalOutput?.terminalId)
    ?? stringValue(update.terminalId)
    ?? stringValue(update.toolCallId)
    ?? "terminal";
  return { terminalId, output };
}

function rawStringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function extractText(update: Record<string, unknown>): string {
  const content = update.content;
  if (typeof update.text === "string") {
    return update.text;
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") {
        return part;
      }
      const record = asRecord(part);
      return stringValue(record?.text) ?? "";
    }).join("");
  }
  return stringifyContent(content ?? "");
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractErrorMessage(value: unknown): string {
  const record = asRecord(value);
  return stringValue(record?.message) ?? stringifyContent(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
