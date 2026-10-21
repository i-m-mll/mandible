// One-time lineage backfill for conversations indexed before their parsers
// declared a parent (issue 23f8142). Live ingestion never reads Codex's state
// database; this backfill falls back to it only for threads whose rollout file
// Codex has since pruned.

import * as fs from "node:fs";
import * as path from "node:path";
import SqliteDatabase from "../sqlite.js";
import type { Db } from "../db.js";
import { recordConversationParent, type ConversationParent } from "../conversation-lineage.js";
import { claudeTranscriptLineage } from "../parsers/claude.js";
import {
  codexRelocationCandidates,
  codexThreadLineage,
  loadCodexThreadLineage,
  locateCodexRollout,
  type CodexThreadLineage,
} from "../parsers/codex.js";

export interface LineageBackfillResult {
  examined: number;
  declared: { claude_code: number; codex: number };
  codex_lineage_source: { rollout_header: number; state_database: number; none: number };
  linked: number;
  unresolved_parent: number;
}

interface UndeclaredRow {
  id: string;
  source: "claude_code" | "codex" | "gemini";
  source_path: string;
  session_id: string;
  is_sidechain: number;
}

interface CodexThreadRow {
  source: string;
  thread_source: string | null;
  agent_nickname: string | null;
}

/** Declare and link the parent of every indexed conversation that has none recorded. */
export async function backfillConversationLineage(db: Db): Promise<LineageBackfillResult> {
  const rows = db.prepare(`
    SELECT id, source, source_path, session_id, is_sidechain
      FROM conversations
     WHERE parent_session_id IS NULL AND source IN ('claude_code', 'codex')
  `).all() as UndeclaredRow[];
  const result: LineageBackfillResult = {
    examined: rows.length,
    declared: { claude_code: 0, codex: 0 },
    codex_lineage_source: { rollout_header: 0, state_database: 0, none: 0 },
    linked: 0,
    unresolved_parent: 0,
  };
  const declarations: Array<{ row: UndeclaredRow; parent: ConversationParent | null; isSubagent: boolean; agentId: string | null }> = [];
  const stateDbs = new CodexStateDatabases();
  try {
    for (const row of rows) {
      if (row.source === "claude_code") {
        const lineage = claudeTranscriptLineage(row.source_path, row.session_id, row.is_sidechain === 1);
        if (lineage.parent) declarations.push({ row, ...lineage, isSubagent: true });
        continue;
      }
      let lineage = await readRolloutLineage(row.source_path);
      if (lineage) {
        result.codex_lineage_source.rollout_header += 1;
      } else {
        lineage = stateDbs.threadLineage(row.source_path, row.session_id);
        result.codex_lineage_source[lineage ? "state_database" : "none"] += 1;
      }
      if (lineage && (lineage.parent || lineage.isSubagent)) declarations.push({ row, ...lineage });
    }
  } finally {
    stateDbs.close();
  }

  const markSubagent = db.prepare(`
    UPDATE conversations
       SET is_sidechain = MAX(is_sidechain, ?), agent_id = COALESCE(agent_id, ?)
     WHERE id = ?
  `);
  const parentOf = db.prepare("SELECT parent_conversation_id FROM conversations WHERE id = ?");
  db.transaction(() => {
    for (const { row, parent, isSubagent, agentId } of declarations) {
      markSubagent.run(isSubagent ? 1 : 0, agentId, row.id);
      if (!parent) continue;
      recordConversationParent(db, row.id, parent);
      result.declared[row.source as "claude_code" | "codex"] += 1;
      const linked = (parentOf.get(row.id) as { parent_conversation_id: string | null }).parent_conversation_id;
      if (linked) result.linked += 1;
      else result.unresolved_parent += 1;
    }
  })();
  return result;
}

async function readRolloutLineage(sourcePath: string): Promise<CodexThreadLineage | null> {
  for (const candidate of [sourcePath, ...codexRelocationCandidates(sourcePath)]) {
    if (!fs.existsSync(candidate)) continue;
    const lineage = await loadCodexThreadLineage(candidate).catch(() => null);
    if (lineage) return lineage;
  }
  return null;
}

/** Codex's own thread registry, opened read-only once per Codex home. */
class CodexStateDatabases {
  private readonly open = new Map<string, SqliteDatabase | null>();

  threadLineage(rolloutPath: string, threadId: string): CodexThreadLineage | null {
    const codexRoot = locateCodexRollout(rolloutPath)?.codexRoot;
    if (!codexRoot) return null;
    const stateDb = this.database(codexRoot);
    const row = stateDb?.prepare(
      "SELECT source, thread_source, agent_nickname FROM threads WHERE id = ?",
    ).get(threadId) as CodexThreadRow | undefined;
    if (!row) return null;
    return codexThreadLineage({
      source: parseThreadSource(row.source),
      thread_source: row.thread_source,
      agent_nickname: row.agent_nickname,
    });
  }

  close(): void {
    for (const stateDb of this.open.values()) stateDb?.close();
    this.open.clear();
  }

  private database(codexRoot: string): SqliteDatabase | null {
    if (!this.open.has(codexRoot)) {
      const statePath = path.join(codexRoot, "state_5.sqlite");
      this.open.set(
        codexRoot,
        fs.existsSync(statePath) ? new SqliteDatabase(statePath, { readonly: true, fileMustExist: true }) : null,
      );
    }
    return this.open.get(codexRoot) ?? null;
  }
}

function parseThreadSource(source: string): Parameters<typeof codexThreadLineage>[0]["source"] {
  if (!source.startsWith("{")) return source;
  try {
    return JSON.parse(source) as Parameters<typeof codexThreadLineage>[0]["source"];
  } catch {
    return source;
  }
}
