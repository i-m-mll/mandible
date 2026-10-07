import * as z from "zod";
import { DEFAULT_CLAUDE_CODE_MODEL } from "./provider-run-option-catalog.js";
import { conversationRunOptions, conversationRuntimeOptionsSchema, providerRuntimeSettingsError } from "./conversation-control/runtime-options.js";
import type { ConversationRuntimeOptions } from "./conversation-control/types.js";

export const MANAGED_CHAT_PROVIDERS = ["claude_code", "codex"] as const;
export type ManagedChatProvider = typeof MANAGED_CHAT_PROVIDERS[number];
export type ManagedChatDefaults = Record<ManagedChatProvider, Required<Pick<ConversationRuntimeOptions, "model" | "effort" | "permission_mode">>>;

export const DEFAULT_MANAGED_CHAT_OPTIONS: ManagedChatDefaults = {
  claude_code: { model: DEFAULT_CLAUDE_CODE_MODEL, effort: "medium", permission_mode: "bypassPermissions" },
  codex: { model: "gpt-5.6-sol", effort: "medium", permission_mode: "agent-full-access" },
};

const optionsSchema = conversationRuntimeOptionsSchema
  .pick({ model: true, effort: true, permission_mode: true }).required();
const defaultsSchema = z.object({ claude_code: optionsSchema, codex: optionsSchema }).strict();

export function parseManagedChatDefaults(value: string | null): ManagedChatDefaults {
  if (value === null) return structuredClone(DEFAULT_MANAGED_CHAT_OPTIONS);
  const parsed = defaultsSchema.parse(JSON.parse(value)) as ManagedChatDefaults;
  for (const provider of MANAGED_CHAT_PROVIDERS) {
    const error = providerRuntimeSettingsError(provider, parsed[provider]);
    if (error) throw new Error(error);
  }
  return parsed;
}

export function managedChatDefaultDescriptors(provider: ManagedChatProvider) {
  return conversationRunOptions(provider, provider === "codex"
    ? [{ value: DEFAULT_MANAGED_CHAT_OPTIONS.codex.model, label: DEFAULT_MANAGED_CHAT_OPTIONS.codex.model }]
    : undefined);
}

export function effectiveManagedRuntimeOptions(provider: string, retained: ConversationRuntimeOptions): ConversationRuntimeOptions {
  if (!MANAGED_CHAT_PROVIDERS.includes(provider as ManagedChatProvider)) return retained;
  const baseline = DEFAULT_MANAGED_CHAT_OPTIONS[provider as ManagedChatProvider];
  const model = retained.model ?? baseline.model;
  const effort = retained.effort ?? (model === baseline.model ? baseline.effort
    : provider === "claude_code" && model === "claude-opus-5" ? "high" : undefined);
  return { ...retained, model, permission_mode: retained.permission_mode ?? baseline.permission_mode, ...(effort ? { effort } : {}) };
}
