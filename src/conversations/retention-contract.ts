import * as z from "zod";
import type { CodexNativeArchiveOutcome } from "../conversation-control/codex-native-archive.js";

export type RetentionNativeStatus = CodexNativeArchiveOutcome["status"] | "pending";
export interface RetentionNativeProjection {
  retention_native_status: RetentionNativeStatus | null;
  retention_native_reason: string | null;
}

const idleRole = z.object({ enabled: z.boolean(), idleHours: z.number().positive().max(87600) }).strict();
export const CHILD_RETENTION_SETTINGS_SCHEMA = z.object({
  enabled: z.boolean(),
  planner: idleRole,
  archaeologist: idleRole,
  worker: z.object({ enabled: z.boolean() }).strict(),
}).strict();

export type ChildRetentionSettings = z.infer<typeof CHILD_RETENTION_SETTINGS_SCHEMA>;
export type RetainedChildRole = "planner" | "archaeologist" | "worker";
export const CHILD_RETENTION_SETTINGS_KEY = "conversations.child_retention";
export const DEFAULT_CHILD_RETENTION_SETTINGS: ChildRetentionSettings = {
  enabled: true,
  planner: { enabled: true, idleHours: 48 },
  archaeologist: { enabled: true, idleHours: 3 },
  worker: { enabled: true },
};
