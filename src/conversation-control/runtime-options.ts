import * as z from "zod";
import { CLAUDE_CODE_BOOTSTRAP_MODELS } from "../provider-run-option-catalog.js";
import type { ConversationRunOption, ConversationRuntimeOptions } from "./types.js";

export const conversationRuntimeOptionsSchema = z.object({
  model: z.string().trim().min(1).optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  permission_mode: z.enum(["read-only", "agent", "agent-full-access", "default", "acceptEdits", "bypassPermissions"]).optional(),
  system_prompt: z.string().optional(),
  setting_sources: z.array(z.enum(["user", "project", "local"])).optional(),
  allowed_tools: z.array(z.string().trim().min(1)).optional(),
  max_turns: z.number().int().positive().optional(),
  max_cost_usd: z.number().positive().optional(),
}).strict();

export function parseConversationRuntimeOptions(value: unknown): ConversationRuntimeOptions {
  return conversationRuntimeOptionsSchema.parse(value ?? {});
}

export function providerRuntimeSettingsError(provider: string, options: ConversationRuntimeOptions): string | null {
  const optionsById = new Map(conversationRunOptions(provider).map(option => [option.id, option.choices.map(choice => choice.value)]));
  const efforts = optionsById.get("effort")!;
  if (options.effort && !efforts.includes(options.effort)) return `${provider} does not support effort '${options.effort}'`;
  const modes = optionsById.get("permission_mode")!;
  if (options.permission_mode && !modes.includes(options.permission_mode)) return `${provider} does not support permission mode '${options.permission_mode}'`;
  if (provider === "codex") {
    const unsupported = Object.keys(options).find((key) => !["model", "effort", "permission_mode"].includes(key));
    if (unsupported) return `Codex does not support managed option '${unsupported}'`;
  }
  return null;
}

export function conversationRunOptions(provider: string, models?: { value: string; label: string }[]): ConversationRunOption[] {
  const claude = provider === "claude_code";
  const choices = (values: string[]) => values.map(value => ({ value, label: value }));
  return [
    { id: "model", label: "Model", choices: models ?? (claude ? CLAUDE_CODE_BOOTSTRAP_MODELS : []) },
    { id: "effort", label: "Thinking effort", choices: choices(claude ? ["low", "medium", "high", "xhigh", "max"] : ["none", "minimal", "low", "medium", "high", "xhigh"]) },
    { id: "permission_mode", label: "Permissions", choices: choices(claude ? ["default", "acceptEdits", "bypassPermissions"] : ["read-only", "agent", "agent-full-access"]) },
  ];
}
