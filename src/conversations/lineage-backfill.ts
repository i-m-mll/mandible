// One-time lineage backfill for conversations indexed before their parsers
// declared a parent (issue 23f8142). The startup ingestion reconcile runs it
// once per database and records its result in `meta`. Lineage is re-derived through each
// provider's own parser from the head of the transcript, so whatever a parser
// reads lineage from is backfilled the same way it is ingested. Live ingestion
// never reads Codex's state database; this backfill falls back to it only for
// threads whose rollout file Codex has since pruned.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import SqliteDatabase from "../sqlite.js";
import type { Db } from "../db.js";
import { recordConversationParent, type ConversationParent } from "../conversation-lineage.js";
import { getParserForFile } from "../parsers/index.js";
import { codexRelocationCandidates, codexThreadLineage, locateCodexRollout } from "../parsers/codex.js";
import type { ConversationSource, ParseResult } from "../parsers/types.js";

/** Lineage records sit at the head of a transcript: header, then the first user message. */
const TRANSCRIPT_HEAD_LINES = 32;

export interface LineageBackfillResult {
  examined: number;
  declared: Record<ConversationSource, number>;
  lineage_source: { transcript: number; codex_state_database: number; none: number };
  linked: number;
  unresolved_parent: number;
}

interface UndeclaredRow {
  id: string;
  source: ConversationSource;
  source_path: string;
  session_id: string;
}

interface DerivedLineage {
  parent: ConversationParent | null;
  isSubagent: boolean;
  agentId: string | null;
}

const BACKFILL_MARKER = "conversation_lineage_backfill_v1";

/**
 * Run the backfill unless this database has already recorded it. Returns the
 * result of the run, or null when it had already run.
 */
export async function backfillConversationLineageOnce(db: Db): Promise<LineageBackfillResult | null> {
  if (db.prepare("SELECT 1 FROM meta WHERE key = ?").get(BACKFILL_MARKER)) return null;
  const result = await backfillConversationLineage(db);
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
    .run(BACKFILL_MARKER, JSON.stringify({ completed_at: Date.now(), ...result }));
  return result;
}

/** Declare and link the parent of every indexed conversation that has none recorded. */
export async function backfillConversationLineage(db: Db): Promise<LineageBackfillResult> {
  const rows = db.prepare(`
    SELECT id, source, source_path, session_id
      FROM conversations
     WHERE parent_session_id IS NULL
  `).all() as UndeclaredRow[];
  const result: LineageBackfillResult = {
    examined: rows.length,
    declared: { claude_code: 0, codex: 0, gemini: 0 },
    lineage_source: { transcript: 0, codex_state_database: 0, none: 0 },
    linked: 0,
    unresolved_parent: 0,
  };
  const declarations: Array<{ row: UndeclaredRow; lineage: DerivedLineage }> = [];
  const registry = new CodexThreadRegistry();
  try {
    for (const row of rows) {
      let lineage = await transcriptLineage(row);
      if (lineage) {
        result.lineage_source.transcript += 1;
      } else {
        lineage = row.source === "codex" ? registry.threadLineage(row.source_path, row.session_id) : null;
        result.lineage_source[lineage ? "codex_state_database" : "none"] += 1;
      }
      if (lineage && (lineage.parent || lineage.isSubagent)) declarations.push({ row, lineage });
    }
  } finally {
    registry.close();
  }

  const markSubagent = db.prepare(`
    UPDATE conversations
       SET is_sidechain = MAX(is_sidechain, ?), agent_id = COALESCE(agent_id, ?)
     WHERE id = ?
  `);
  const linkedParent = db.prepare("SELECT parent_conversation_id FROM conversations WHERE id = ?");
  db.transaction(() => {
    for (const { row, lineage } of declarations) {
      markSubagent.run(lineage.isSubagent ? 1 : 0, lineage.agentId, row.id);
      if (!lineage.parent) continue;
      recordConversationParent(db, row.id, lineage.parent);
      result.declared[row.source] += 1;
      const linked = (linkedParent.get(row.id) as { parent_conversation_id: string | null }).parent_conversation_id;
      if (linked) result.linked += 1;
      else result.unresolved_parent += 1;
    }
  })();
  return result;
}

/** Parse the head of the row's transcript, wherever the provider has moved it, with its own parser. */
async function transcriptLineage(row: UndeclaredRow): Promise<DerivedLineage | null> {
  const candidates = row.source === "codex"
    ? [row.source_path, ...codexRelocationCandidates(row.source_path)]
    : [row.source_path];
  for (const candidate of candidates) {
    const parser = fs.existsSync(candidate) ? getParserForFile(candidate) : null;
    if (!parser || parser.source !== row.source) continue;
    let parsed: ParseResult | null;
    try {
      parsed = candidate.endsWith(".jsonl") && parser.parseIncremental
        ? await parser.parseIncremental({
          filePath: candidate,
          raw: await readHeadLines(candidate, TRANSCRIPT_HEAD_LINES),
          baseBlockCount: 0,
          baseRecordCount: 0,
          sourceHash: "lineage-backfill",
          sourceMtime: 0,
        })
        : await parser.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || parsed.conversation.session_id !== row.session_id) continue;
    return {
      parent: parsed.parent,
      isSubagent: parsed.conversation.is_sidechain,
      agentId: parsed.conversation.agent_id,
    };
  }
  return null;
}

async function readHeadLines(filePath: string, count: number): Promise<string> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const head: string[] = [];
  try {
    for await (const line of lines) {
      head.push(line);
      if (head.length >= count) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return head.length ? `${head.join("\n")}\n` : "";
}

/** Codex's own thread registry, opened read-only once per Codex home. */
class CodexThreadRegistry {
  private readonly open = new Map<string, SqliteDatabase | null>();

  threadLineage(rolloutPath: string, threadId: string): DerivedLineage | null {
    const codexRoot = locateCodexRollout(rolloutPath)?.codexRoot;
    const stateDb = codexRoot ? this.database(codexRoot) : null;
    const row = stateDb?.prepare(
      "SELECT source, thread_source, agent_nickname FROM threads WHERE id = ?",
    ).get(threadId) as { source: string; thread_source: string | null; agent_nickname: string | null } | undefined;
    if (!row) return null;
    return codexThreadLineage({
      source: row.source.startsWith("{") ? JSON.parse(row.source) : row.source,
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
