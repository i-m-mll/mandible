import * as z from "zod";
import type { ConversationRuntimeOptions } from "./types.js";

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
  const efforts = provider === "claude_code" ? ["low", "medium", "high", "xhigh", "max"] : ["none", "minimal", "low", "medium", "high", "xhigh"];
  if (options.effort && !efforts.includes(options.effort)) return `${provider} does not support effort '${options.effort}'`;
  const modes = provider === "claude_code" ? ["default", "acceptEdits", "bypassPermissions"] : ["read-only", "agent", "agent-full-access"];
  if (options.permission_mode && !modes.includes(options.permission_mode)) return `${provider} does not support permission mode '${options.permission_mode}'`;
  if (provider === "codex") {
    const unsupported = Object.keys(options).find((key) => !["model", "effort", "permission_mode"].includes(key));
    if (unsupported) return `Codex does not support managed option '${unsupported}'`;
  }
  return null;
}
