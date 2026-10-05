import SqliteDatabase from "../sqlite.js";
import * as path from "node:path";
import {
  codexRolloutPathsEquivalent,
  locateCodexRollout,
} from "../parsers/codex.js";

export type CodexTitleAuthorityFailure = "unavailable" | "missing" | "mismatched" | "stale";

export type CodexTitleAuthorityResult =
  | {
    status: "current";
    title: string;
    rolloutPath: string;
    updatedAtMs: number;
  }
  | {
    status: CodexTitleAuthorityFailure;
    message: string;
  };

/**
 * Read the one provider-owned Codex thread row for a pinned rollout.
 *
 * The store is opened read-only and the query is exact by native thread id.
 * A result is authoritative only when its rollout path still owns the pinned
 * source (allowing Codex's sessions/archive relocation) and its metadata clock
 * is at least as recent as the observed source clock.
 */
export function readExactCodexTitleAuthority(input: {
  sourcePath: string;
  nativeSessionId: string;
  sourceMtimeMs: number;
  /** Optional evidence of the exact provider query. */
  traceSql?: (sql: string) => void;
}): CodexTitleAuthorityResult {
  const location = locateCodexRollout(input.sourcePath);
  if (!location) {
    return { status: "mismatched", message: "pinned source is not owned by a Codex rollout root" };
  }
  if (!input.nativeSessionId.trim()) {
    return { status: "mismatched", message: "pinned Codex source has no native thread identity" };
  }

  const statePath = path.join(location.codexRoot, "state_5.sqlite");
  let stateDb: SqliteDatabase | null = null;
  try {
    stateDb = new SqliteDatabase(statePath, {
      readonly: true,
      fileMustExist: true,
    });
    const statement = stateDb.prepare(`
      SELECT id, title, rollout_path,
             COALESCE(updated_at_ms, updated_at * 1000) AS updated_at_ms
        FROM threads
       WHERE id = ?
    `);
    const row = statement.get(input.nativeSessionId) as {
      id: string;
      title: string;
      rollout_path: string;
      updated_at_ms: number;
    } | undefined;
    input.traceSql?.(statement.expandedSQL);
    if (!row) {
      return { status: "missing", message: "exact Codex thread metadata row is missing" };
    }
    if (row.id !== input.nativeSessionId || !codexRolloutPathsEquivalent(input.sourcePath, row.rollout_path)) {
      return { status: "mismatched", message: "Codex thread metadata does not own the pinned rollout path" };
    }
    const updatedAtMs = Number(row.updated_at_ms);
    // Codex stores integer milliseconds while fs.stat may expose a fractional
    // remainder. The same integer millisecond is current, not stale.
    if (!Number.isFinite(updatedAtMs) || updatedAtMs < Math.floor(input.sourceMtimeMs)) {
      return { status: "stale", message: "Codex thread metadata predates the observed rollout source" };
    }
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!title) {
      return { status: "missing", message: "exact Codex thread metadata title is missing" };
    }
    return { status: "current", title, rolloutPath: row.rollout_path, updatedAtMs };
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? `Codex thread metadata is unavailable: ${error.message}` : "Codex thread metadata is unavailable",
    };
  } finally {
    stateDb?.close();
  }
}
