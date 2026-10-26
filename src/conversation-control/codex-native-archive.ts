import { CodexAppServerClient } from "./codex-app-server-client.js";

export type CodexNativeArchiveOutcome =
  | { status: "archived" | "already_archived" }
  | { status: "deferred"; reason: "desktop_writer_owned" }
  | { status: "failed"; reason: string };

export type CodexNativeRestoreOutcome =
  | { status: "restored" | "already_restored" }
  | { status: "failed"; reason: string };

export type CodexNativeQueueOutcome =
  | { status: "known"; pending: boolean }
  | { status: "unknown"; reason: string };

export type CodexNativeArchiveClient = Pick<CodexAppServerClient, "request" | "close">;
type Failure = { status: "failed"; reason: string };
type NativeThread = { archived: boolean } | Failure;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readThread(client: CodexNativeArchiveClient, threadId: string): Promise<NativeThread> {
  const thread = object(object(await client.request("thread/read", { threadId }))?.thread);
  if (thread?.id !== threadId) return { status: "failed", reason: "native_thread_identity_mismatch" };
  if (typeof thread.path !== "string") return { status: "failed", reason: "native_archive_state_unavailable" };
  const parts = thread.path.split(/[\\/]/);
  if (parts.includes("archived_sessions")) return { archived: true };
  if (parts.includes("sessions")) return { archived: false };
  return { status: "failed", reason: "native_archive_state_unavailable" };
}

/** Restore this exact native thread before a caller resumes or sends input. */
export async function restoreCodexNativeThread(
  client: CodexNativeArchiveClient,
  threadId: string,
): Promise<CodexNativeRestoreOutcome> {
  try {
    const before = await readThread(client, threadId);
    if ("status" in before) return before;
    if (!before.archived) return { status: "already_restored" };
    const restored = object(object(await client.request("thread/unarchive", { threadId }))?.thread);
    if (restored?.id !== threadId) return { status: "failed", reason: "native_thread_identity_mismatch" };
    const after = await readThread(client, threadId);
    if ("status" in after) return after;
    return after.archived
      ? { status: "failed", reason: "native_restore_effect_unverified" }
      : { status: "restored" };
  } catch (error) {
    return { status: "failed", reason: reason(error) };
  }
}

/** Provider effects only; eligibility and local chat visibility belong to the caller. */
export class CodexNativeArchiveAdapter {
  constructor(private readonly connect: () => Promise<CodexNativeArchiveClient> = () => CodexAppServerClient.connect()) {}

  async archive(threadId: string): Promise<CodexNativeArchiveOutcome> {
    return this.withClient(async (client): Promise<CodexNativeArchiveOutcome> => {
      const before = await readThread(client, threadId);
      if ("status" in before) return before;
      if (before.archived) return { status: "already_archived" };
      try {
        await client.request("thread/archive", { threadId });
      } catch (error) {
        if (reason(error) === `thread ${threadId} already has an active writer`) {
          return { status: "deferred", reason: "desktop_writer_owned" };
        }
        return { status: "failed", reason: reason(error) };
      }
      const after = await readThread(client, threadId);
      if ("status" in after) return after;
      return after.archived
        ? { status: "archived" }
        : { status: "failed", reason: "native_archive_effect_unverified" };
    });
  }

  async restore(threadId: string): Promise<CodexNativeRestoreOutcome> {
    return this.withClient(client => restoreCodexNativeThread(client, threadId));
  }

  async queue(threadId: string): Promise<CodexNativeQueueOutcome> {
    const outcome = await this.withClient(async (client): Promise<CodexNativeQueueOutcome | Failure> => {
      const thread = await readThread(client, threadId);
      if ("status" in thread) return thread;
      const page = object(await client.request("thread/queue/list", { threadId, limit: 1 }));
      if (!Array.isArray(page?.data)) return { status: "unknown", reason: "native_queue_state_unavailable" } as const;
      if (page.data.length > 0) return { status: "known", pending: true } as const;
      if (page.nextCursor != null) return { status: "unknown", reason: "native_queue_page_incomplete" } as const;
      return { status: "known", pending: false } as const;
    });
    return outcome.status === "failed" ? { status: "unknown", reason: outcome.reason } : outcome;
  }

  private async withClient<T>(run: (client: CodexNativeArchiveClient) => Promise<T>): Promise<T | Failure> {
    try {
      const client = await this.connect();
      try { return await run(client); }
      finally { await client.close(); }
    } catch (error) {
      return { status: "failed", reason: reason(error) };
    }
  }
}

export const defaultCodexNativeArchiveAdapter = new CodexNativeArchiveAdapter();
