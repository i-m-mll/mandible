import { providerEvidenceWriter, readProviderEvidence, type ProviderIndexEvidence } from './index-provider-evidence.js';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { CONVERSATION_CACHE_FORMAT, copyIndexGeneration, conversationCacheSchemaIdentity, validateConversationCacheColumns } from './index-storage.js';
import { writeDisplayIndex, readCompleteDisplayIndex, readDisplayContextPlan, type DisplayIndexInput, type DisplayContextPlan } from './display-index.js';
import { nextReadingContext, type ReadingContextEntry, type ReadingContextState } from './reading-context.js';
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import SqliteDatabase from "../sqlite.js";

import type { Db } from "../db.js";
import type { BlockType, Role } from "../parsers/types.js";
import { conversationSourceEpochsMatch, type ConversationSourceEpochs } from "./source-types.js";

import { conversationStructureCachePath, CONVERSATION_STRUCTURE_CACHE_VERSION } from "./structure-cache-path.js";
export { CONVERSATION_STRUCTURE_CACHE_VERSION } from "./structure-cache-path.js";

const BLOCK_TYPES: readonly BlockType[] = [
  "user_message",
  "assistant_message",
  "thinking",
  "plan",
  "tool_use",
  "tool_result",
  "system",
  "event",
];
const ROLES: readonly Role[] = ["user", "assistant", "system", "tool"];

const BLOCK_TYPE_TO_CODE = new Map(BLOCK_TYPES.map((value, index) => [value, index]));
const ROLE_TO_CODE = new Map(ROLES.map((value, index) => [value, index]));

export interface SparseConversationBlockRow {
  conversationId: string;
  sourceVersionId: string;
  position: number;
  type: BlockType;
  role: Role;
  parentPosition: number | null;
  toolEvidence?: ProviderIndexEvidence;
  recordOffset: number;
  recordLength: number;
  recordOrdinal: number;
  subBlockOrdinal: number;
  model?: string | null;
  clientIntentId?: string | null;
  parserFormat: string;
  parserVersion: string;
  normalizationVersion: string;
  redactionEpoch: number;
}

export interface SparseConversationPage {
  rows: SparseConversationBlockRow[];
  total: number;
  offset: number;
  limit: number;
}

interface CacheConversationRow {
  cache_id: number;
  conversation_id: string;
  source_version_id: string;
  parser_format: string;
  parser_version: string;
  normalization_version: string;
  redaction_epoch: number;
  block_count: number;
}

interface CacheBlockRow {
  position: number;
  type_code: number;
  role_code: number;
  parent_position: number | null;
  record_offset: number;
  record_length: number;
  record_ordinal: number;
  sub_block_ordinal: number;
  model: string | null;
  client_intent_id: string | null;
}

export interface SourceManifestRow {
  conversation_id: string;
  source_version_id: string;
  parser_format: string;
  parser_version: string;
  normalization_version: string;
  redaction_epoch: number;
  block_count: number;
}

export interface ConversationStructureCacheOptions {
  cachePath?: string;
  readonly?: boolean;
  maxBytes?: number;
}

export function defaultConversationStructureCachePath(db?: Db): string {
  return conversationStructureCachePath(db?.name ?? "", process.env.MANDIBLE_CONVERSATION_STRUCTURE_DB);
}

export function sparseConversationBlockId(conversationId: string, position: number): string {
  return `cblk:${conversationId}:${position}`;
}

export function sparseConversationBlockPosition(
  conversationId: string,
  blockRef: string,
): number | null {
  const prefix = `cblk:${conversationId}:`;
  if (!blockRef.startsWith(prefix)) return null;
  const raw = blockRef.slice(prefix.length);
  if (!/^\d+$/.test(raw)) return null;
  const position = Number(raw);
  return Number.isSafeInteger(position) ? position : null;
}

export function parseSparseConversationBlockId(
  blockRef: string,
): { conversationId: string; position: number } | null {
  if (!blockRef.startsWith("cblk:")) return null;
  const separator = blockRef.lastIndexOf(":");
  if (separator <= "cblk:".length) return null;
  const conversationId = blockRef.slice("cblk:".length, separator);
  const rawPosition = blockRef.slice(separator + 1);
  if (!conversationId || !/^\d+$/.test(rawPosition)) return null;
  const position = Number(rawPosition);
  return Number.isSafeInteger(position) ? { conversationId, position } : null;
}

function blockTypeCode(type: string): number {
  const code = BLOCK_TYPE_TO_CODE.get(type as BlockType);
  if (code === undefined) throw new Error(`unsupported conversation block type: ${type}`);
  return code;
}

function roleCode(role: string): number {
  const code = ROLE_TO_CODE.get(role as Role);
  if (code === undefined) throw new Error(`unsupported conversation block role: ${role}`);
  return code;
}

function decodeType(code: number): BlockType {
  const type = BLOCK_TYPES[code];
  if (!type) throw new Error(`invalid cached conversation block type code: ${code}`);
  return type;
}

function decodeRole(code: number): Role {
  const role = ROLES[code];
  if (!role) throw new Error(`invalid cached conversation block role code: ${code}`);
  return role;
}

function toolKey(toolId: string): Buffer {
  // A 128-bit binary digest keeps the lookup compact without squeezing the key
  // through JavaScript's 53-bit integer ceiling.
  return createHash("sha256").update(toolId).digest().subarray(0, 16);
}

/**
 * Disposable, integer-only directory from normalized block positions to exact
 * provider JSONL record ranges. Conversation text and durable ledger metadata
 * never enter this database. Its only job is to make native-source paging
 * fast; deleting the file may cost a rebuild but cannot lose user data.
 */
export class ConversationStructureCache {
  readonly cachePath: string;
  private readonly cache: SqliteDatabase;
  private activeReaders = 0;

  constructor(mainDb?: Db, options: ConversationStructureCacheOptions = {}) {
    this.cachePath = options.readonly ? options.cachePath! : options.cachePath
      ? conversationStructureCachePath("", options.cachePath)
      : defaultConversationStructureCachePath(mainDb);
    if (this.cachePath !== ":memory:") {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    }
    this.cache = new SqliteDatabase(this.cachePath, options.readonly ? { readonly: true, fileMustExist: true } : undefined);
    if (options.readonly) {
      this.validateFormat();
      this.cache.pragma("query_only = ON");
      return;
    }
    this.cache.pragma("journal_mode = WAL");
    this.cache.pragma("synchronous = NORMAL");
    this.cache.pragma("foreign_keys = ON");
    const initialized = this.cache.prepare("SELECT name FROM sqlite_master WHERE name = 'cache_meta'").get();
    if (!initialized) this.cache.transaction(() => this.initialize()).immediate();
    this.validateFormat();
    if(options.maxBytes!==undefined)this.setByteLimit(options.maxBytes);
  }

  private validateFormat(): void {
    try {
    const row=this.cache.prepare("SELECT value FROM cache_meta WHERE key='schema_version'").get() as {value:string}|undefined;
    const identity=this.cache.prepare("SELECT value FROM cache_meta WHERE key='schema_identity'").get() as {value:string}|undefined;
    if(row?.value!==String(CONVERSATION_STRUCTURE_CACHE_VERSION)||identity?.value!==conversationCacheSchemaIdentity){throw new Error('Conversation cache format mismatch');}
    validateConversationCacheColumns(this.cache);
    } catch(error) {this.cache.close();throw error;}
  }

  private initialize(): void {
    const initialized = this.cache.prepare("SELECT name FROM sqlite_master WHERE name = 'cache_meta'").get();
    if (initialized) return;
    this.cache.exec(CONVERSATION_CACHE_FORMAT.schema);
    this.cache.prepare("INSERT INTO cache_meta (key, value) VALUES ('schema_version', ?)")
      .run(String(CONVERSATION_STRUCTURE_CACHE_VERSION));
    this.cache.prepare("INSERT INTO cache_meta(key,value) VALUES('schema_identity',?)").run(conversationCacheSchemaIdentity);
  }

  setByteLimit(maxBytes:number):void {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('Invalid conversation cache byte limit');
    const pageSize=Number(this.cache.pragma('page_size',{simple:true}));
    this.cache.pragma(`max_page_count = ${Math.max(1,Math.floor(maxBytes/pageSize))}`);
  }

  async projectGenerationsTo(destination:ConversationStructureCache,manifests:readonly SourceManifestRow[],options:{signal?:AbortSignal;maxBytes?:number;batchSize?:number;cooperate?:()=>Promise<void>}={}):Promise<{generations:number;rows:number}> {
    const batchSize=options.batchSize??512;if(!Number.isSafeInteger(batchSize)||batchSize<1)throw new Error('Invalid projection batch size');
    let rows=0,generations=0;
    if(options.maxBytes!==undefined)destination.setByteLimit(options.maxBytes);
    const check=()=>{options.signal?.throwIfAborted();if(options.maxBytes!==undefined) {
      const bytes=['','-wal','-shm'].reduce((sum,suffix)=>sum+(fs.existsSync(destination.cachePath+suffix)?fs.statSync(destination.cachePath+suffix).size:0),0);
      if(bytes>options.maxBytes)throw new Error('Conversation cache projection exceeds its byte budget');
    }};
    this.cache.exec('BEGIN');
    try {
      for(const manifest of manifests) {
        check();const source=this.cachedConversation(manifest.conversation_id,manifest.source_version_id,{parserFormat:manifest.parser_format,parserVersion:manifest.parser_version,normalizationVersion:manifest.normalization_version,redactionEpoch:manifest.redaction_epoch});
        if(!source||source.block_count!==manifest.block_count)continue;
        if(destination.hasCompleteConversation(manifest.conversation_id,manifest.source_version_id,manifest.block_count,{parserFormat:manifest.parser_format,parserVersion:manifest.parser_version,normalizationVersion:manifest.normalization_version,redactionEpoch:manifest.redaction_epoch}))continue;
        const target=destination.beginGeneration(manifest);
        try {
          for(const table of CONVERSATION_CACHE_FORMAT.tables) {
            const columns=(this.cache.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(row=>row.name);
            const insert=destination.cache.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
            const tableInfo=this.cache.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string;pk:number}>;
            const withoutRowid=(this.cache.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {sql:string}).sql.includes('WITHOUT ROWID');
            const cursorColumns=withoutRowid?tableInfo.filter(column=>column.pk>0&&column.name!=='cache_conversation_id').sort((left,right)=>left.pk-right.pk).map(column=>column.name):['rowid'];
            let cursor:unknown[]|undefined;
            while(true) {
              check();const after=cursor?` AND (${cursorColumns.join(',')})>(${cursorColumns.map(()=>'?').join(',')})`:'';
              const batch=this.cache.prepare(`SELECT ${withoutRowid?'*':'rowid AS __cursor,*'} FROM ${table} WHERE cache_conversation_id=?${after} ORDER BY ${cursorColumns.join(',')} LIMIT ?`).all(source.cache_id,...(cursor??[]),batchSize) as Array<Record<string,unknown>>;
              if(!batch.length)break;
              destination.cache.transaction(()=>{for(const row of batch)insert.run(...columns.map(column=>column==='cache_conversation_id'?target:row[column]));})();
              rows+=batch.length;const last=batch[batch.length-1];cursor=cursorColumns.map(column=>column==='rowid'?last.__cursor:last[column]);check();if(options.cooperate)await options.cooperate();else await yieldToEventLoop();
            }
          }
          destination.completeGeneration(target);generations++;
        } catch(error) {destination.discardGeneration(target);throw error;}
      }
      return {generations,rows};
    } finally {this.cache.exec('ROLLBACK');}
  }

  close(): void {
    this.cache.close();
  }

  clear(): void {
    this.cache.exec("DELETE FROM cache_reading_scopes; DELETE FROM cache_tool_links; DELETE FROM cache_blocks; DELETE FROM cache_conversations");
  }

  beginGeneration(manifest: SourceManifestRow, priorVersionId?: string, options:{replaceReady?:boolean}={}): number {
    return this.cache.transaction(() => {
      const tuple=[manifest.conversation_id,manifest.source_version_id,manifest.parser_format,manifest.parser_version,manifest.normalization_version,manifest.redaction_epoch];
      const existing=this.cache.prepare('SELECT cache_id,ready,block_count FROM cache_conversations WHERE conversation_id=? AND source_version_id=? AND parser_format=? AND parser_version=? AND normalization_version=? AND redaction_epoch=? ORDER BY ready DESC,cache_id DESC').get(...tuple) as {cache_id:number;ready:number;block_count:number}|undefined;
      if(existing?.ready&&existing.block_count===manifest.block_count&&!options.replaceReady)return existing.cache_id;
      this.cache.prepare('DELETE FROM cache_conversations WHERE conversation_id=? AND source_version_id=? AND parser_format=? AND parser_version=? AND normalization_version=? AND redaction_epoch=? AND ready=0').run(...tuple);
      const now=Date.now();
      const id=Number(this.cache.prepare('INSERT INTO cache_conversations(conversation_id,source_version_id,parser_format,parser_version,normalization_version,redaction_epoch,block_count,updated_at,accessed_at) VALUES(?,?,?,?,?,?,?,?,?)').run(...tuple,manifest.block_count,now,now).lastInsertRowid);
      if(priorVersionId) {
        const prior=this.cachedConversation(manifest.conversation_id,priorVersionId,{parserFormat:manifest.parser_format,parserVersion:manifest.parser_version,normalizationVersion:manifest.normalization_version,redactionEpoch:manifest.redaction_epoch});
        if(!prior)throw new Error('Append structure generation is missing');
        copyIndexGeneration(this.cache,prior.cache_id,id);
      }
      return id;
    })();
  }

  appendGeneration(cacheId:number,batch:{rows?:readonly Omit<SparseConversationBlockRow,'conversationId'|'sourceVersionId'|'parserFormat'|'parserVersion'|'normalizationVersion'|'redactionEpoch'>[];display?:DisplayIndexInput;tools?:ReadonlyMap<string,number>;toolKeys?:Array<{key:Uint8Array;position:number}>}):void {
    this.cache.transaction(()=>{
      const generation=this.cache.prepare('SELECT ready FROM cache_conversations WHERE cache_id=?').get(cacheId) as {ready:number}|undefined;
      if(!generation||generation.ready)throw new Error('Index generation is not building');
      const previousRow=this.cache.prepare('SELECT position,type_code,role_code,activity_owner,action_start FROM cache_blocks WHERE cache_conversation_id=? ORDER BY position DESC LIMIT 1').get(cacheId) as {position:number;type_code:number;role_code:number;activity_owner:number|null;action_start:number}|undefined;
      let previous:ReadingContextState|null=previousRow?{position:previousRow.position,type:decodeType(previousRow.type_code),role:decodeRole(previousRow.role_code),activity_owner:previousRow.activity_owner,action_scope:{start:previousRow.action_start,end:previousRow.position}}:null;
      const parent=this.cache.prepare('SELECT activity_owner FROM cache_blocks WHERE cache_conversation_id=? AND position=?');
      const scope=this.cache.prepare('INSERT INTO cache_reading_scopes VALUES(?,?,?) ON CONFLICT(cache_conversation_id,start) DO UPDATE SET end=excluded.end');
      const insert=this.cache.prepare('INSERT INTO cache_blocks(cache_conversation_id,position,type_code,role_code,parent_position,record_offset,record_length,record_ordinal,sub_block_ordinal,model,client_intent_id,activity_owner,action_start) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const writeEvidence=providerEvidenceWriter(this.cache,cacheId);
      for(const row of batch.rows??[]) {
        const owner=row.parentPosition===null?null:parent.get(cacheId,row.parentPosition) as {activity_owner:number|null}|undefined;
        previous=nextReadingContext(row,previous,owner?.activity_owner??null);
        scope.run(cacheId,previous.action_scope.start,row.position);
        writeEvidence(row.position,row.toolEvidence);
        insert.run(cacheId,row.position,blockTypeCode(row.type),roleCode(row.role),row.parentPosition,row.recordOffset,row.recordLength,row.recordOrdinal,row.subBlockOrdinal,row.model??null,row.clientIntentId??null,previous.activity_owner,previous.action_scope.start);
      }
      if(batch.display)writeDisplayIndex(this.cache,cacheId,batch.display);
      const insertTool=this.cache.prepare('INSERT INTO cache_tool_links VALUES(?,?,?) ON CONFLICT(cache_conversation_id,tool_key) DO UPDATE SET position=excluded.position');
      for(const [key,position] of batch.tools??[])insertTool.run(cacheId,toolKey(key),position);
      for(const {key,position} of batch.toolKeys??[])insertTool.run(cacheId,key,position);
    })();
  }

  completeGeneration(cacheId:number):void {
    this.cache.transaction(()=>{
      const manifest=this.cache.prepare('SELECT * FROM cache_conversations WHERE cache_id=?').get(cacheId) as CacheConversationRow&{ready:number}|undefined;
      if(!manifest)throw new Error('Index generation is missing');
      if(manifest.ready)return;
      const count=this.cache.prepare('SELECT COUNT(*) AS count,MIN(position) AS first,MAX(position) AS last FROM cache_blocks WHERE cache_conversation_id=?').get(cacheId) as {count:number;first:number|null;last:number|null};
      if(count.count!==manifest.block_count||(count.count>0&&(count.first!==0||count.last!==count.count-1)))throw new Error('Prepared conversation structure is incomplete');
      const invalid=this.cache.prepare(`SELECT 1 FROM cache_blocks b WHERE b.cache_conversation_id=? AND (b.record_offset<0 OR b.record_length<0 OR (b.parent_position IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cache_blocks p WHERE p.cache_conversation_id=b.cache_conversation_id AND p.position=b.parent_position))) LIMIT 1`).get(cacheId);
      if(invalid)throw new Error('Invalid source coordinates in index generation');
      const fragments=this.cache.prepare('SELECT COUNT(*) AS count FROM cache_display_fragments WHERE cache_conversation_id=?').get(cacheId) as {count:number};
      if(this.cache.prepare('SELECT 1 FROM cache_blocks WHERE cache_conversation_id=? AND revision IS NULL LIMIT 1').get(cacheId))throw new Error('Prepared presentation position facts are incomplete');
      if(fragments.count) {

        if(this.cache.prepare(`SELECT 1 FROM cache_display_aliases a WHERE a.cache_conversation_id=? AND (NOT EXISTS(SELECT 1 FROM cache_blocks b WHERE b.cache_conversation_id=a.cache_conversation_id AND b.position=a.position) OR NOT EXISTS(SELECT 1 FROM cache_display_fragments f WHERE f.cache_conversation_id=a.cache_conversation_id AND f.position=a.owner_position AND f.part_kind=a.owner_kind AND f.part_ordinal=a.owner_ordinal AND f.activity_kind=0)) LIMIT 1`).get(cacheId))throw new Error('Prepared presentation alias owner is missing');
      }
      this.cache.prepare('DELETE FROM cache_conversations WHERE conversation_id=? AND source_version_id=? AND parser_format=? AND parser_version=? AND normalization_version=? AND redaction_epoch=? AND cache_id!=? AND ready=1').run(manifest.conversation_id,manifest.source_version_id,manifest.parser_format,manifest.parser_version,manifest.normalization_version,manifest.redaction_epoch,cacheId);
      this.cache.prepare('UPDATE cache_conversations SET ready=1 WHERE cache_id=?').run(cacheId);
    })();
  }

  discardGeneration(cacheId:number):void {this.cache.prepare('DELETE FROM cache_conversations WHERE cache_id=? AND ready=0').run(cacheId);}

  replaceRows(manifest:SourceManifestRow,rows:readonly Omit<SparseConversationBlockRow,'conversationId'|'sourceVersionId'|'parserFormat'|'parserVersion'|'normalizationVersion'|'redactionEpoch'>[],tools:ReadonlyMap<string,number>=new Map(),priorVersionId?:string,display?:DisplayIndexInput):void {
    const id=this.beginGeneration(manifest,priorVersionId,{replaceReady:true});
    try {
      const size=512;
      for(let offset=0;offset<rows.length;offset+=size) {
        const part=rows.slice(offset,offset+size);const first=part[0].position,last=part[part.length-1].position;
        this.appendGeneration(id,{rows:part,display:display?{positions:display.positions.filter(position=>position.position>=first&&position.position<=last),fragments:display.fragments.filter(fragment=>fragment.coordinate.position>=first&&fragment.coordinate.position<=last),aliases:display.aliases.filter(alias=>alias.position>=first&&alias.position<=last)}:undefined});
      }
      this.appendGeneration(id,{tools});this.completeGeneration(id);
    } catch(error){this.discardGeneration(id);throw error;}
  }

  private cachedConversation(conversationId: string, sourceVersionId: string, epochs?: ConversationSourceEpochs): CacheConversationRow | null {
    const conditions = epochs ? "AND parser_format = ? AND parser_version = ? AND normalization_version = ? AND redaction_epoch = ?" : "";
    return (this.cache.prepare(`
      SELECT cache_id, conversation_id, source_version_id, parser_format, parser_version,
             normalization_version, redaction_epoch, block_count
        FROM cache_conversations
       WHERE ready = 1 AND conversation_id = ? AND source_version_id = ? ${conditions}
       ORDER BY cache_id DESC LIMIT 1
    `).get(conversationId, sourceVersionId, ...(epochs ? [epochs.parserFormat, epochs.parserVersion, epochs.normalizationVersion, epochs.redactionEpoch] : [])) as CacheConversationRow | undefined) ?? null;
  }

  /** A read-only WAL snapshot pins all admitted navigation until the source read finishes. */
  openReadSession(): { cache: ConversationStructureCache; close(): void } {
    if (this.cachePath === ":memory:") {
      this.activeReaders += 1;
      return { cache: this, close: () => { this.activeReaders -= 1; } };
    }
    const reader = new ConversationStructureCache(undefined, { cachePath: this.cachePath, readonly: true });
    try {
      reader.cache.exec("BEGIN");
      reader.cache.prepare("SELECT cache_id FROM cache_conversations LIMIT 1").get();
    } catch (error) { reader.close(); throw error; }
    return { cache: reader, close: () => { try { reader.cache.exec("ROLLBACK"); } finally { reader.close(); } } };
  }

  /** Only the preparation owner prunes; admitted WAL readers retain their own snapshot. */
  prune(conversationId: string, protectedVersionId: string | null): void {
    if (this.activeReaders > 0) return;
    const generations = this.cache.prepare(`SELECT cache_id, source_version_id FROM cache_conversations
      WHERE conversation_id = ? ORDER BY cache_id DESC`).all(conversationId) as CacheConversationRow[];
    let retained = 0;
    let protectedCurrent = false;
    const remove = this.cache.prepare("DELETE FROM cache_conversations WHERE cache_id = ?");
    this.cache.transaction(() => {
      for (const row of generations) {
        const protect = !protectedCurrent && row.source_version_id === protectedVersionId;
        if (protect) protectedCurrent = true;
        if (protect || retained++ < 3) continue;
        remove.run(row.cache_id);
      }
    })();
  }

  readPage(
    conversationId: string,
    sourceVersionId: string,
    options: { offset: number; limit: number; types?: readonly string[]; epochs?: ConversationSourceEpochs; prefix?: { blockCount: number; byteLength: number; verified?: boolean } },
  ): SparseConversationPage | null {
    const conversation = this.cachedConversation(conversationId, sourceVersionId, options.epochs);
    if (!conversation) return null;
    const typeCodes = options.types?.map(blockTypeCode);
    const conditions = ["cache_conversation_id = ?"];
    const params: unknown[] = [conversation.cache_id];
    if (options.prefix) {
      conditions.push("position >= 0 AND position < ?", "record_offset >= 0 AND record_length >= 0 AND record_offset + record_length <= ?",
        "(parent_position IS NULL OR (parent_position >= 0 AND parent_position < ?))");
      params.push(options.prefix.blockCount, options.prefix.byteLength, options.prefix.blockCount);
      if (!options.prefix.verified) {
        const coverage = this.cache.prepare(`SELECT COUNT(*) AS count, MIN(position) AS first, MAX(position) AS last
          FROM cache_blocks WHERE ${conditions.join(" AND ")}`).get(...params) as { count: number; first: number | null; last: number | null };
        if (coverage.count !== options.prefix.blockCount || (coverage.count > 0 && (coverage.first !== 0 || coverage.last !== coverage.count - 1))) return null;
      }
    }
    if (typeCodes && typeCodes.length > 0) {
      conditions.push(`type_code IN (${typeCodes.map(() => "?").join(",")})`);
      params.push(...typeCodes);
    }
    const where = conditions.join(" AND ");
    const total = typeCodes && typeCodes.length > 0
      ? (this.cache.prepare(`SELECT COUNT(*) AS count FROM cache_blocks WHERE ${where}`)
        .get(...params) as { count: number }).count
      : options.prefix?.blockCount ?? conversation.block_count;
    const rows = this.cache.prepare(`
      SELECT position, type_code, role_code, parent_position, record_offset,
             record_length, record_ordinal, sub_block_ordinal, model, client_intent_id
        FROM cache_blocks WHERE ${where}
       ORDER BY position LIMIT ? OFFSET ?
    `).all(...params, options.limit, options.offset) as CacheBlockRow[];
    const evidence=readProviderEvidence(this.cache,conversation.cache_id,rows.map(row=>row.position));
    return {
      rows: rows.map((row) => ({
        conversationId,
        sourceVersionId,
        position: row.position,
        toolEvidence:evidence.get(row.position),
        type: decodeType(row.type_code),
        role: decodeRole(row.role_code),
        parentPosition: row.parent_position,
        recordOffset: row.record_offset,
        recordLength: row.record_length,
        recordOrdinal: row.record_ordinal,
        subBlockOrdinal: row.sub_block_ordinal,
        model: row.model,
        clientIntentId: row.client_intent_id,
        parserFormat: conversation.parser_format,
        parserVersion: conversation.parser_version,
        normalizationVersion: conversation.normalization_version,
        redactionEpoch: conversation.redaction_epoch,
      })),
      total,
      offset: options.offset,
      limit: options.limit,
    };
  }

  readPresentationIndex(conversationId: string, sourceVersionId: string, epochs?: ConversationSourceEpochs) {
    const conversation = this.cachedConversation(conversationId, sourceVersionId, epochs);
    return conversation ? readCompleteDisplayIndex(this.cache, conversation.cache_id) : null;
  }

  readDisplayContext(conversationId: string, sourceVersionId: string, positions: readonly number[], epochs?: ConversationSourceEpochs): DisplayContextPlan | null {
    const conversation = this.cachedConversation(conversationId, sourceVersionId, epochs);
    return conversation ? readDisplayContextPlan(this.cache, conversation.cache_id, positions) : null;
  }

  readReadingContextPositions(conversationId: string, sourceVersionId: string, positions: readonly number[], epochs?: ConversationSourceEpochs): ReadingContextEntry[] | null {
    const conversation = this.cachedConversation(conversationId, sourceVersionId, epochs);
    if (!conversation) return null;
    const rows = this.cache.prepare(`SELECT b.position,b.activity_owner,s.start,s.end FROM cache_blocks b
      JOIN cache_reading_scopes s ON s.cache_conversation_id=b.cache_conversation_id AND s.start=b.action_start
      WHERE b.cache_conversation_id=? AND b.position IN (SELECT value FROM json_each(?)) ORDER BY b.position`)
      .all(conversation.cache_id, JSON.stringify(positions)) as Array<{ position: number; activity_owner: number | null; start: number; end: number }>;
    return rows.map(row => ({ position: row.position, activity_owner: row.activity_owner, action_scope: {start: row.start, end: row.end} }));
  }

  readReadingContext(conversationId: string, sourceVersionId: string, start: number, end: number, epochs?: ConversationSourceEpochs): ReadingContextEntry[] | null {
    const conversation = this.cachedConversation(conversationId, sourceVersionId, epochs);
    if (!conversation) return null;
    const rows = this.cache.prepare(`SELECT b.position, b.activity_owner, s.start, s.end
      FROM cache_blocks b JOIN cache_reading_scopes s
        ON s.cache_conversation_id = b.cache_conversation_id AND s.start = b.action_start
      WHERE b.cache_conversation_id = ? AND b.position >= ? AND b.position <= ? ORDER BY b.position`)
      .all(conversation.cache_id, start, end) as Array<{ position: number; activity_owner: number | null; start: number; end: number }>;
    return rows.map(row => ({ position: row.position, activity_owner: row.activity_owner, action_scope: { start: row.start, end: row.end } }));
  }

  readStructure(conversationId: string, sourceVersionId: string, epochs?: ConversationSourceEpochs): Array<{
    position: number;
    type: BlockType;
    role: Role;
    parentPosition: number | null;
    recordOffset: number;
    recordLength: number;
  }> | null {
    const conversation = this.cachedConversation(conversationId, sourceVersionId, epochs);
    if (!conversation) return null;
    const rows = this.cache.prepare(`
      SELECT position, type_code, role_code, parent_position, record_offset, record_length
        FROM cache_blocks WHERE cache_conversation_id = ? ORDER BY position
    `).all(conversation.cache_id) as Array<Pick<CacheBlockRow,
      "position" | "type_code" | "role_code" | "parent_position" | "record_offset" | "record_length">>;
    if (rows.length !== conversation.block_count) return null;
    return rows.map((row) => ({
      position: row.position,
      type: decodeType(row.type_code),
      role: decodeRole(row.role_code),
      parentPosition: row.parent_position,
      recordOffset: row.record_offset,
      recordLength: row.record_length,
    }));
  }

  readPosition(conversationId: string, sourceVersionId: string, position: number, epochs?: ConversationSourceEpochs): SparseConversationBlockRow | null {
    return this.readPositions(conversationId, sourceVersionId, [position], epochs)?.[0] ?? null;
  }

  /** Exact requested coordinates and their verified direct parents, from the admitted navigation snapshot. */
  readPositions(conversationId: string, sourceVersionId: string, positions: readonly number[], epochs?: ConversationSourceEpochs,
    includeParents = false): SparseConversationBlockRow[] | null {
    const conversation = this.cachedConversation(conversationId, sourceVersionId, epochs);
    if (!conversation) return null;
    const rows = this.cache.prepare(`WITH RECURSIVE requested(position) AS (
      SELECT value FROM json_each(?)
      UNION SELECT b.parent_position FROM cache_blocks b JOIN requested r ON r.position=b.position WHERE b.cache_conversation_id=? AND ? AND b.parent_position IS NOT NULL
      UNION SELECT e.origin_position FROM cache_provider_evidence e JOIN requested r ON r.position=e.position WHERE e.cache_conversation_id=? AND ? AND e.origin_position IS NOT NULL
    ) SELECT b.* FROM cache_blocks b JOIN requested r ON r.position=b.position WHERE b.cache_conversation_id=? ORDER BY b.position`).all(JSON.stringify([...new Set(positions)]),conversation.cache_id,includeParents?1:0,conversation.cache_id,includeParents?1:0,conversation.cache_id) as CacheBlockRow[];
    const evidence=readProviderEvidence(this.cache,conversation.cache_id,rows.map(row=>row.position));
    return rows.map(row => ({
      conversationId,
      sourceVersionId,
      position: row.position,
      toolEvidence:evidence.get(row.position),
      type: decodeType(row.type_code),
      role: decodeRole(row.role_code),
      parentPosition: row.parent_position,
      recordOffset: row.record_offset,
      recordLength: row.record_length,
      recordOrdinal: row.record_ordinal,
      subBlockOrdinal: row.sub_block_ordinal,
      model: row.model,
      clientIntentId: row.client_intent_id,
      parserFormat: conversation.parser_format,
      parserVersion: conversation.parser_version,
      normalizationVersion: conversation.normalization_version,
      redactionEpoch: conversation.redaction_epoch,
    }));
  }

  hasCompleteConversation(
    conversationId: string,
    sourceVersionId: string,
    expectedBlockCount: number,
    epochs?: ConversationSourceEpochs,
  ): boolean {
    const conversation = this.cachedConversation(conversationId, sourceVersionId, epochs);
    return conversation?.block_count === expectedBlockCount && (!epochs || conversationSourceEpochsMatch({
      parserFormat: conversation.parser_format,
      parserVersion: conversation.parser_version,
      normalizationVersion: conversation.normalization_version,
      redactionEpoch: conversation.redaction_epoch,
    }, epochs));
  }

  blockCount(conversationId: string, sourceVersionId: string, epochs?: ConversationSourceEpochs): number | null {
    return this.cachedConversation(conversationId, sourceVersionId, epochs)?.block_count ?? null;
  }

  turnPosition(
    conversationId: string,
    sourceVersionId: string,
    position: number,
    epochs?: ConversationSourceEpochs,
  ): number | null {
    const conversation = this.cachedConversation(conversationId, sourceVersionId, epochs);
    if (!conversation) return null;
    const userType = blockTypeCode("user_message");
    const target = this.cache.prepare(`
      SELECT type_code FROM cache_blocks
       WHERE cache_conversation_id = ? AND position = ?
    `).get(conversation.cache_id, position) as { type_code: number } | undefined;
    if (!target) return null;
    if (target.type_code === userType) return position;
    const previousUser = this.cache.prepare(`
      SELECT MAX(position) AS position FROM cache_blocks
       WHERE cache_conversation_id = ? AND position <= ? AND type_code = ?
    `).get(conversation.cache_id, position, userType) as { position: number | null };
    return (this.cache.prepare(`
      SELECT MIN(position) AS position FROM cache_blocks
       WHERE cache_conversation_id = ? AND position <= ? AND position > ?
         AND type_code != ?
    `).get(
      conversation.cache_id,
      position,
      previousUser.position ?? -1,
      userType,
    ) as { position: number | null }).position ?? position;
  }

  /** First block that must be materialized to show the target's complete turn. */
  turnWindowStart(
    conversationId: string,
    sourceVersionId: string,
    position: number,
    epochs?: ConversationSourceEpochs,
  ): number | null {
    const conversation = this.cachedConversation(conversationId, sourceVersionId, epochs);
    if (!conversation) return null;
    const userType = blockTypeCode("user_message");
    const target = this.cache.prepare(`
      SELECT type_code FROM cache_blocks
       WHERE cache_conversation_id = ? AND position = ?
    `).get(conversation.cache_id, position) as { type_code: number } | undefined;
    if (!target) return null;
    if (target.type_code === userType) return position;
    const previousUser = this.cache.prepare(`
      SELECT MAX(position) AS position FROM cache_blocks
       WHERE cache_conversation_id = ? AND position <= ? AND type_code = ?
    `).get(conversation.cache_id, position, userType) as { position: number | null };
    if (previousUser.position !== null) return previousUser.position;
    return (this.cache.prepare(`
      SELECT MIN(position) AS position FROM cache_blocks
       WHERE cache_conversation_id = ? AND position <= ?
    `).get(conversation.cache_id, position) as { position: number | null }).position;
  }

  findToolPosition(conversationId: string, toolId: string, sourceVersionId?: string, epochs?: ConversationSourceEpochs): number | null {
    const conversation = sourceVersionId && epochs ? this.cachedConversation(conversationId, sourceVersionId, epochs) : this.cache.prepare(
      "SELECT cache_id FROM cache_conversations WHERE conversation_id = ? AND (? IS NULL OR source_version_id = ?) ORDER BY cache_id DESC LIMIT 1",
    ).get(conversationId, sourceVersionId ?? null, sourceVersionId ?? null) as { cache_id: number } | undefined;
    if (!conversation) return null;
    return (this.cache.prepare(`
      SELECT position FROM cache_tool_links
       WHERE cache_conversation_id = ? AND tool_key = ?
    `).get(conversation.cache_id, toolKey(toolId)) as { position: number } | undefined)?.position ?? null;
  }

  stats(): { conversations: number; blocks: number; fileBytes: number | null } {
    const conversations = (this.cache.prepare("SELECT COUNT(*) AS count FROM cache_conversations")
      .get() as { count: number }).count;
    const blocks = (this.cache.prepare("SELECT COUNT(*) AS count FROM cache_blocks")
      .get() as { count: number }).count;
    const fileBytes = this.cachePath === ":memory:" || !fs.existsSync(this.cachePath)
      ? null
      : fs.statSync(this.cachePath).size;
    return { conversations, blocks, fileBytes };
  }
}

const services = new WeakMap<Db, ConversationStructureCache>();

export function getConversationStructureCache(db: Db): ConversationStructureCache {
  const existing = services.get(db);
  if (existing) return existing;
  const service = new ConversationStructureCache(db);
  services.set(db, service);
  return service;
}

/** Exact ready generations only; projection and prefix copies share the ownership manifest. */
export async function projectConversationCache(sourcePath:string,destinationPath:string,manifests:readonly SourceManifestRow[],options:{signal?:AbortSignal;maxBytes?:number;batchSize?:number;cooperate?:()=>Promise<void>}={}):Promise<{generations:number;rows:number}> {
  if(path.resolve(sourcePath)===path.resolve(destinationPath))throw new Error('Cache projection requires a distinct destination');
  const source=new ConversationStructureCache(undefined,{cachePath:sourcePath,readonly:true});
  const suffix=`.v${CONVERSATION_STRUCTURE_CACHE_VERSION}`;
  const destination=new ConversationStructureCache(undefined,{cachePath:destinationPath.endsWith(suffix)?destinationPath.slice(0,-suffix.length):destinationPath});
  try{return await source.projectGenerationsTo(destination,manifests,options);}finally{destination.close();source.close();}
}
export { CONVERSATION_CACHE_FORMAT } from './index-storage.js';
