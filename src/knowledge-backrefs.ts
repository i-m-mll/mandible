import crypto from "node:crypto";
import type { Db } from "./db.js";
import type {
  KnowledgeBackrefInput,
  KnowledgeBackrefRecord,
  KnowledgeBackrefRefType,
  KnowledgeBackrefSourceType,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

export interface KnowledgeBackrefListOptions {
  sourceType?: string;
  sourceId?: string;
  providerId?: string;
  refType?: string;
  externalRef?: string;
  limit?: number;
  offset?: number;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJsonRecord(value: string | null | undefined): JsonRecord {
  if (!value) return {};
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function normalizeProviderId(value: unknown): string {
  const providerId = asString(value) ?? "humbleb";
  return providerId.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeSourceType(value: unknown): KnowledgeBackrefSourceType {
  if (value === undefined || value === null || value === "artifact") return "artifact";
  if (value === "document") return "document";
  throw new Error("source_type must be 'artifact' or 'document'");
}

function normalizeRefType(value: unknown): KnowledgeBackrefRefType {
  if (value === "document" || value === "entity" || value === "claim") return value;
  throw new Error("ref_type must be 'document', 'entity', or 'claim'");
}

function normalizeStatus(value: unknown): KnowledgeBackrefRecord["status"] {
  if (value === undefined || value === null || value === "returned") return "returned";
  if (value === "offered" || value === "indexed") return value;
  throw new Error("status must be 'offered', 'indexed', or 'returned'");
}

function parseExternalRef(input: KnowledgeBackrefInput): {
  refType: KnowledgeBackrefRefType;
  externalId: string;
  externalRef: string;
} {
  const providedRef = asString(input.external_ref);
  const providedType = input.ref_type === undefined ? undefined : normalizeRefType(input.ref_type);
  const providedId = asString(input.external_id);

  if (providedRef) {
    const match = /^humbleb:(document|entity|claim):(.+)$/i.exec(providedRef);
    if (!match) {
      throw new Error("external_ref must use humbleb:<document|entity|claim>:<id>");
    }
    const refType = match[1].toLowerCase() as KnowledgeBackrefRefType;
    const externalId = match[2].trim();
    if (!externalId) throw new Error("external_ref id is required");
    if (providedType && providedType !== refType) {
      throw new Error("ref_type does not match external_ref");
    }
    if (providedId && providedId !== externalId) {
      throw new Error("external_id does not match external_ref");
    }
    return {
      refType,
      externalId,
      externalRef: `humbleb:${refType}:${externalId}`,
    };
  }

  if (!providedType) throw new Error("ref_type is required when external_ref is omitted");
  if (!providedId) throw new Error("external_id is required when external_ref is omitted");
  return {
    refType: providedType,
    externalId: providedId,
    externalRef: `humbleb:${providedType}:${providedId}`,
  };
}

function stableId(parts: unknown[]): string {
  return `knowledge_backref:${crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

function tableExists(db: Db): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_backrefs'"
  ).get() as { name: string } | undefined;
  return Boolean(row);
}

function backrefFromRow(row: Record<string, unknown>): KnowledgeBackrefRecord {
  return {
    id: String(row.id),
    source_type: normalizeSourceType(row.source_type),
    source_id: String(row.source_id),
    provider_id: String(row.provider_id),
    ref_type: normalizeRefType(row.ref_type),
    external_id: String(row.external_id),
    external_ref: String(row.external_ref),
    status: normalizeStatus(row.status),
    metadata: parseJsonRecord(row.metadata_json as string),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function createKnowledgeBackref(
  db: Db,
  input: KnowledgeBackrefInput,
  now = Date.now(),
): KnowledgeBackrefRecord {
  if (!tableExists(db)) {
    throw new Error("knowledge_backrefs table is missing; run database migrations");
  }
  const sourceType = normalizeSourceType(input.source_type);
  const sourceId = asString(input.source_id);
  if (!sourceId) throw new Error("source_id is required");

  const providerId = normalizeProviderId(input.provider_id);
  if (!providerId) throw new Error("provider_id is invalid");
  const ref = parseExternalRef(input);
  const status = normalizeStatus(input.status);
  const id = stableId([sourceType, sourceId, providerId, ref.refType, ref.externalId]);

  db.prepare(
    `INSERT INTO knowledge_backrefs (
      id, source_type, source_id, provider_id, ref_type, external_id,
      external_ref, status, metadata_json, created_at, updated_at
    ) VALUES (
      @id, @source_type, @source_id, @provider_id, @ref_type, @external_id,
      @external_ref, @status, @metadata_json, @created_at, @updated_at
    )
    ON CONFLICT(source_type, source_id, provider_id, ref_type, external_id) DO UPDATE SET
      external_ref = excluded.external_ref,
      status = excluded.status,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at`
  ).run({
    id,
    source_type: sourceType,
    source_id: sourceId,
    provider_id: providerId,
    ref_type: ref.refType,
    external_id: ref.externalId,
    external_ref: ref.externalRef,
    status,
    metadata_json: jsonStringify(input.metadata ?? {}),
    created_at: now,
    updated_at: now,
  });

  const row = db.prepare(
    `SELECT id, source_type, source_id, provider_id, ref_type, external_id,
            external_ref, status, metadata_json, created_at, updated_at
       FROM knowledge_backrefs
      WHERE id = ?`
  ).get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("failed to load knowledge backref after write");
  return backrefFromRow(row);
}

export function listKnowledgeBackrefs(
  db: Db,
  options: KnowledgeBackrefListOptions = {},
): KnowledgeBackrefRecord[] {
  if (!tableExists(db)) return [];
  const where: string[] = [];
  const bindings: Record<string, unknown> = {};
  if (asString(options.sourceType)) {
    bindings.sourceType = options.sourceType;
    where.push("source_type = @sourceType");
  }
  if (asString(options.sourceId)) {
    bindings.sourceId = options.sourceId;
    where.push("source_id = @sourceId");
  }
  if (asString(options.providerId)) {
    bindings.providerId = normalizeProviderId(options.providerId);
    where.push("provider_id = @providerId");
  }
  if (asString(options.refType)) {
    bindings.refType = normalizeRefType(options.refType);
    where.push("ref_type = @refType");
  }
  if (asString(options.externalRef)) {
    bindings.externalRef = options.externalRef;
    where.push("external_ref = @externalRef");
  }
  bindings.limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  bindings.offset = Math.max(options.offset ?? 0, 0);

  const rows = db.prepare(
    `SELECT id, source_type, source_id, provider_id, ref_type, external_id,
            external_ref, status, metadata_json, created_at, updated_at
       FROM knowledge_backrefs
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC, id
      LIMIT @limit OFFSET @offset`
  ).all(bindings) as Array<Record<string, unknown>>;
  return rows.map(backrefFromRow);
}
