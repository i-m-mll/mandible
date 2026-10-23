import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { requirePrivateDirectory } from "./local-api-socket.js";

/**
 * Provider hooks hand execution observations to the daemon through this
 * private directory instead of a request, so a busy or absent daemon never
 * delays a prompt (issue d1acb66). This module is the hook's whole import
 * graph, so it stays free of database and schema dependencies.
 */

export type ExecutionHookProvider = "claude" | "codex";

/** The provider fields the daemon maps, as `mapSessionExecutionHook` reads them. */
export type ExecutionEnvelope = { provider: ExecutionHookProvider; session_id: string; hook_event_name: string } & Record<string, unknown>;

export interface ExecutionOutboxEntry {
  observed_at: number;
  envelope: ExecutionEnvelope;
}

const ENTRY_NAME = /^\d{15}-\d+-[0-9a-f]{8}\.json$/;
const TEMP_SUFFIX = ".tmp";
const REJECTED_DIR = "rejected";

/** The outbox sits beside the instance's private local socket. */
export function executionOutboxDir(socketPath: string): string {
  return path.join(path.dirname(socketPath), `${path.basename(socketPath, ".sock")}.execution-outbox`);
}

export function executionOutboxRejectedDir(dir: string): string {
  return path.join(dir, REJECTED_DIR);
}

/** Keep only the native fields the daemon maps; prompts and transcript paths never leave the hook. */
export function projectExecutionEnvelope(provider: ExecutionHookProvider, payload: unknown): ExecutionEnvelope | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.session_id !== "string" || p.session_id.length === 0 || typeof p.hook_event_name !== "string") return null;
  const envelope: ExecutionEnvelope = { provider, session_id: p.session_id, hook_event_name: p.hook_event_name };
  for (const key of ["turn_id", "agent_id"] as const) if (key in p) envelope[key] = p[key];
  if (p.hook_event_name === "SessionStart" && "source" in p) envelope.source = p.source;
  if (p.hook_event_name === "SessionEnd" && "reason" in p) envelope.reason = p.reason;
  if (p.hook_event_name === "StopFailure") {
    for (const key of ["error", "error_details", "last_assistant_message"] as const) envelope[key] = p[key];
  }
  return envelope;
}

/**
 * Publish one entry atomically. Names sort by observation time, which is the
 * order the daemon applies them in.
 */
export function writeExecutionOutboxEntry(dir: string, entry: ExecutionOutboxEntry): string {
  requirePrivateDirectory(dir);
  const name = `${String(entry.observed_at).padStart(15, "0")}-${process.pid}-${randomBytes(4).toString("hex")}.json`;
  const final = path.join(dir, name);
  const temp = `${final}${TEMP_SUFFIX}`;
  fs.writeFileSync(temp, JSON.stringify(entry), { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, final);
  return final;
}

export interface ExecutionOutboxListing {
  /** Published entries in application order. */
  entries: string[];
  /** Unpublished writes, which a live writer renames within microseconds. */
  temps: string[];
}

export function listExecutionOutbox(dir: string): ExecutionOutboxListing {
  const entries: string[] = [];
  const temps: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (ENTRY_NAME.test(name)) entries.push(name);
    else if (name.endsWith(TEMP_SUFFIX)) temps.push(name);
  }
  return { entries: entries.sort(), temps };
}
