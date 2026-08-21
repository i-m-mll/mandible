import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import type { BlockType, Role } from "../parsers/types.js";

export const MANAGED_NORMALIZED_SOURCE_EPOCHS = Object.freeze({
  parserFormat: "mandible-normalized-jsonl",
  parserVersion: "1",
  normalizationVersion: "1",
  redactionEpoch: 1,
});

export interface ManagedNormalizedBlockRecord {
  format: "mandible-normalized-block/1";
  id: string;
  conversation_id: string;
  type: BlockType;
  role: Role;
  content: string;
  position: number;
  timestamp: string | null;
  parent_id: string | null;
  metadata_json: string;
  dag_uuid: string | null;
  dag_parent_uuid: string | null;
}

export interface ManagedNormalizedRecordRange {
  ordinal: number;
  offset: number;
  length: number;
  hash: string;
}

const BLOCK_TYPES = new Set<BlockType>([
  "user_message", "assistant_message", "thinking", "plan", "tool_use",
  "tool_result", "system", "event",
]);
const ROLES = new Set<Role>(["user", "assistant", "system", "tool"]);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requiredNullableString(value: unknown, name: string): string | null {
  if (value === null || typeof value === "string") return value;
  throw new Error(`managed normalized record has invalid ${name}`);
}

export function parseManagedNormalizedRecord(bytes: Buffer): ManagedNormalizedBlockRecord {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("managed normalized record is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("managed normalized record is not an object");
  }
  const row = value as Record<string, unknown>;
  if (row.format !== "mandible-normalized-block/1") {
    throw new Error("managed normalized record format is unsupported");
  }
  if (typeof row.id !== "string" || typeof row.conversation_id !== "string"
      || typeof row.content !== "string" || typeof row.metadata_json !== "string"
      || !Number.isSafeInteger(row.position) || Number(row.position) < 0
      || !BLOCK_TYPES.has(row.type as BlockType) || !ROLES.has(row.role as Role)) {
    throw new Error("managed normalized record has invalid block fields");
  }
  return {
    format: row.format,
    id: row.id,
    conversation_id: row.conversation_id,
    type: row.type as BlockType,
    role: row.role as Role,
    content: row.content,
    position: Number(row.position),
    timestamp: requiredNullableString(row.timestamp, "timestamp"),
    parent_id: requiredNullableString(row.parent_id, "parent_id"),
    metadata_json: row.metadata_json,
    dag_uuid: requiredNullableString(row.dag_uuid, "dag_uuid"),
    dag_parent_uuid: requiredNullableString(row.dag_parent_uuid, "dag_parent_uuid"),
  };
}

export function serializeManagedNormalizedRecords(records: readonly ManagedNormalizedBlockRecord[]): {
  bytes: Buffer;
  contentHash: string;
  ranges: ManagedNormalizedRecordRange[];
} {
  const chunks: Buffer[] = [];
  const ranges: ManagedNormalizedRecordRange[] = [];
  let offset = 0;
  for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
    const bytes = Buffer.from(JSON.stringify(records[ordinal]), "utf8");
    ranges.push({ ordinal, offset, length: bytes.length, hash: sha256(bytes) });
    chunks.push(bytes, Buffer.from("\n"));
    offset += bytes.length + 1;
  }
  const bytes = Buffer.concat(chunks);
  return { bytes, contentHash: sha256(bytes), ranges };
}

function verifyPrivateExactFile(filePath: string, expected: Buffer): void {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("managed custody target is not a regular file");
    if ((stat.mode & 0o7777) !== 0o600) {
      throw new Error("managed custody target permissions are not owner-only 0600");
    }
    if (stat.size !== expected.length || !fs.readFileSync(fd).equals(expected)) {
      throw new Error("managed custody target contains different bytes");
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function managedNormalizedSourcePath(
  rootPath: string,
  conversationId: string,
  contentHash: string,
): string {
  const conversationKey = createHash("sha256").update(conversationId).digest("hex").slice(0, 24);
  return path.join(path.resolve(rootPath), "normalized-v1", `${conversationKey}.${contentHash}.jsonl`);
}

/** Write immutable content without an overwrite window. Existing exact bytes are idempotent. */
export function writeManagedNormalizedSource(input: {
  rootPath: string;
  conversationId: string;
  bytes: Buffer;
  contentHash: string;
}): { rootPath: string; filePath: string } {
  if (sha256(input.bytes) !== input.contentHash) {
    throw new Error("managed custody content hash does not match its bytes");
  }
  fs.mkdirSync(input.rootPath, { recursive: true, mode: 0o700 });
  const rootPath = fs.realpathSync.native(path.resolve(input.rootPath));
  const directory = path.join(rootPath, "normalized-v1");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryReal = fs.realpathSync.native(directory);
  if (path.dirname(directoryReal) !== rootPath) {
    throw new Error("managed custody directory escapes its declared root");
  }
  const filePath = managedNormalizedSourcePath(rootPath, input.conversationId, input.contentHash);
  if (path.dirname(filePath) !== directoryReal) {
    throw new Error("managed custody file escapes its declared root");
  }
  if (fs.existsSync(filePath)) {
    verifyPrivateExactFile(filePath, input.bytes);
    return { rootPath, filePath };
  }

  const tempPath = path.join(directoryReal, `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let tempCreated = false;
  try {
    const fd = fs.openSync(
      tempPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    tempCreated = true;
    try {
      fs.writeFileSync(fd, input.bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tempPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      verifyPrivateExactFile(filePath, input.bytes);
    }
    verifyPrivateExactFile(filePath, input.bytes);
    const directoryFd = fs.openSync(directoryReal, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return { rootPath, filePath };
  } finally {
    if (tempCreated) fs.rmSync(tempPath, { force: true });
  }
}
