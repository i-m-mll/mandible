import SqliteDatabase from '../sqlite.js';
import { CONVERSATION_STRUCTURE_CACHE_VERSION } from './structure-cache-path.js';

const generation = 'cache_conversation_id INTEGER NOT NULL REFERENCES cache_conversations(cache_id) ON DELETE CASCADE';
const recipe = `recipe INTEGER NOT NULL, scope_id INTEGER, item_kind TEXT, basis TEXT, native_id TEXT, content_index INTEGER, record_ordinal INTEGER, prefix TEXT, suffix TEXT`;
export const CONVERSATION_CACHE_FORMAT = {
  version: CONVERSATION_STRUCTURE_CACHE_VERSION,
  tables: [
    'cache_blocks','cache_reading_scopes','cache_tool_links','cache_native_scopes',
    'cache_position_identities','cache_display_fragments','cache_display_aliases','cache_fragment_disclosures',
    'cache_fragment_operations','cache_operation_names','cache_execution_steps',
  ] as const,
  schema: `
    CREATE TABLE cache_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE cache_conversations (
      cache_id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL,source_version_id TEXT NOT NULL,
      parser_format TEXT NOT NULL,parser_version TEXT NOT NULL,normalization_version TEXT NOT NULL,redaction_epoch INTEGER NOT NULL,
      block_count INTEGER NOT NULL,updated_at INTEGER NOT NULL,accessed_at INTEGER NOT NULL,ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)));
    CREATE INDEX idx_cache_tuple ON cache_conversations(conversation_id,source_version_id,parser_format,parser_version,normalization_version,redaction_epoch,ready,cache_id);
    CREATE TABLE cache_blocks (${generation}, position INTEGER NOT NULL,type_code INTEGER NOT NULL CHECK(type_code BETWEEN 0 AND 7),
      role_code INTEGER NOT NULL CHECK(role_code BETWEEN 0 AND 3),parent_position INTEGER,record_offset INTEGER NOT NULL,record_length INTEGER NOT NULL,
      record_ordinal INTEGER NOT NULL,sub_block_ordinal INTEGER NOT NULL,model TEXT,client_intent_id TEXT,activity_owner INTEGER,action_start INTEGER NOT NULL,
      revision BLOB CHECK(revision IS NULL OR length(revision)=32),turn_id TEXT,response_class INTEGER CHECK(response_class BETWEEN 0 AND 2),usage_key TEXT,usage_input INTEGER,usage_output INTEGER,
      PRIMARY KEY(cache_conversation_id,position)) WITHOUT ROWID;
    CREATE TABLE cache_reading_scopes (${generation},start INTEGER NOT NULL,end INTEGER NOT NULL,PRIMARY KEY(cache_conversation_id,start)) WITHOUT ROWID;
    CREATE TABLE cache_tool_links (${generation},tool_key BLOB NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(cache_conversation_id,tool_key)) WITHOUT ROWID;
    CREATE TABLE cache_native_scopes (${generation},scope_id INTEGER NOT NULL,provider TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(cache_conversation_id,scope_id),UNIQUE(cache_conversation_id,provider,session_id));
    CREATE TABLE cache_position_identities (${generation},position INTEGER NOT NULL,kind INTEGER NOT NULL CHECK(kind BETWEEN 0 AND 2),ordinal INTEGER NOT NULL,${recipe},UNIQUE(cache_conversation_id,position,kind,ordinal));
    CREATE TABLE cache_display_fragments (${generation},position INTEGER NOT NULL,part_kind INTEGER NOT NULL CHECK(part_kind BETWEEN 0 AND 3),part_ordinal INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,kind INTEGER NOT NULL CHECK(kind IN (0,1)),run_position INTEGER,run_kind INTEGER,run_ordinal INTEGER,
      activity_kind INTEGER CHECK(activity_kind BETWEEN 0 AND 4),activity_subtype INTEGER,severity INTEGER,outcome INTEGER,status TEXT,tool_name TEXT,tool_kind TEXT,turn_id TEXT,
      flags INTEGER NOT NULL,execution_kind INTEGER CHECK(execution_kind IN (0,1)),execution_count INTEGER,
      UNIQUE(cache_conversation_id,position,part_kind,part_ordinal));
    CREATE INDEX idx_display_runs ON cache_display_fragments(cache_conversation_id,run_position,run_kind,run_ordinal,position,ordinal);
    CREATE TABLE cache_display_aliases (${generation},position INTEGER NOT NULL,owner_position INTEGER NOT NULL,owner_kind INTEGER NOT NULL,owner_ordinal INTEGER NOT NULL,
      PRIMARY KEY(cache_conversation_id,position)) WITHOUT ROWID;
    CREATE TABLE cache_fragment_disclosures (${generation},position INTEGER NOT NULL,part_kind INTEGER NOT NULL,part_ordinal INTEGER NOT NULL,kind INTEGER NOT NULL CHECK(kind BETWEEN 0 AND 2),ordinal INTEGER NOT NULL,turn_id TEXT,${recipe},UNIQUE(cache_conversation_id,position,part_kind,part_ordinal,kind,ordinal));
    CREATE TABLE cache_fragment_operations (${generation},position INTEGER NOT NULL,part_kind INTEGER NOT NULL,part_ordinal INTEGER NOT NULL,ordinal INTEGER NOT NULL,category INTEGER NOT NULL,count INTEGER NOT NULL,native_name TEXT,other_kind INTEGER CHECK(other_kind IN (0,1)),UNIQUE(cache_conversation_id,position,part_kind,part_ordinal,ordinal));
    CREATE TABLE cache_operation_names (${generation},position INTEGER NOT NULL,part_kind INTEGER NOT NULL,part_ordinal INTEGER NOT NULL,operation INTEGER NOT NULL,ordinal INTEGER NOT NULL,name TEXT NOT NULL,UNIQUE(cache_conversation_id,position,part_kind,part_ordinal,operation,ordinal));
    CREATE TABLE cache_execution_steps (${generation},position INTEGER NOT NULL,part_kind INTEGER NOT NULL,part_ordinal INTEGER NOT NULL,ordinal INTEGER NOT NULL,shell TEXT,forwarding INTEGER NOT NULL CHECK(forwarding BETWEEN 0 AND 2),UNIQUE(cache_conversation_id,position,part_kind,part_ordinal,ordinal));
  `,
};

/** All copies use one generation ownership inventory, including variable child facts. */
export function copyIndexGeneration(db: SqliteDatabase, sourceId: number, targetId: number, sourceSchema = 'main'): number {
  let count=0;
  for (const table of CONVERSATION_CACHE_FORMAT.tables) {
    const columns=(db.prepare(`PRAGMA main.table_info(${table})`).all() as Array<{name:string}>).map(row=>row.name);
    const remaining=columns.filter(column=>column!=='cache_conversation_id');
    const result=db.prepare(`INSERT INTO main.${table} (${columns.join(',')}) SELECT ?,${remaining.join(',')} FROM ${sourceSchema}.${table} WHERE cache_conversation_id=?`).run(targetId,sourceId);
    count+=Number(result.changes);
  }
  return count;
}
