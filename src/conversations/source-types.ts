import type {
  BlockType,
  ConversationBlock,
  ConversationSource,
  ParserSourceSnapshot,
  Role,
} from "../parsers/types.js";

/** Durable source availability. Missing/stale sources retain all identities. */
export type ConversationSourceAvailability =
  | "available"
  | "missing"
  | "stale"
  | "unsupported"
  | "unchecked";

export type ConversationSourceCustodyState =
  | "provider"
  | "requested"
  | "capturing"
  | "verified"
  | "mirroring"
  | "sealed"
  | "error";

export interface ConversationSourceEpochs {
  parserFormat: string;
  parserVersion: string;
  normalizationVersion: string;
  redactionEpoch: number;
}

export interface ConversationSourceDescriptor extends ConversationSourceEpochs {
  sourceId: string;
  conversationId: string;
  provider: ConversationSource;
  nativeSessionId: string;
  availability: ConversationSourceAvailability;
  custodyState: ConversationSourceCustodyState;
  currentVersionId: string | null;
  unavailableReason: string | null;
}

export interface ConversationSourceAlias {
  id: string;
  sourceId: string;
  rootKind: "provider" | "managed_custody";
  rootPath: string;
  relativePath: string;
  path: string;
  aliasKind: "active" | "archive" | "provider" | "managed";
  availability: ConversationSourceAvailability;
}

export interface ConversationSourceVersion extends ConversationSourceEpochs {
  id: string;
  sourceId: string;
  contentSha256: string;
  byteLength: number;
  fileMtimeMs: number | null;
  /** Physical provider generation, independent of logical byteLength/contentSha256. */
  filesystemDevice: string | null;
  filesystemInode: string | null;
  filesystemCtimeNs: string | null;
  availability: ConversationSourceAvailability;
  custodyState: ConversationSourceCustodyState;
  generation: "sealed_sha256" | "legacy_hash";
}

/** Locator fields are verified against an already-opened descriptor. */
export interface ConversationBlockLocator extends ConversationSourceEpochs {
  sourceVersionId: string;
  recordOffset: number;
  recordLength: number;
  recordHash: string;
  recordOrdinal: number;
  subBlockOrdinal: number;
  normalizationCheckpointId: string | null;
}

export interface SourceBackedConversationBlock {
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
  locator: ConversationBlockLocator | null;
}

export type SourceReadFailureKind = "stale" | "unavailable" | "unsupported" | "not_found";

export type SourceReadResult<T> =
  | { status: "source"; value: T; sourceVersionId: string }
  | { status: "legacy"; value: T; reason: SourceReadFailureKind }
  | { status: SourceReadFailureKind; reason: string };

export interface SourceBlockPage {
  blocks: SourceBackedConversationBlock[];
  total: number;
  offset: number;
  limit: number;
}

export interface RecordConversationSourceInput extends ConversationSourceEpochs {
  conversationId: string;
  provider: ConversationSource;
  nativeSessionId: string;
  filePath: string;
  /** Full parser-observed SHA-256 when available; append markers are omitted. */
  expectedContentHash?: string;
  /** Parser-captured full extent or incremental append range for JSONL sources. */
  sourceSnapshot?: ParserSourceSnapshot;
  /**
   * Parser output supplied by ingestion so source indexing does not depend on
   * retaining a second body copy in conversation_blocks.
   */
  blocks?: ReadonlyArray<Omit<ConversationBlock, "id" | "conversation_id"> & { legacyId: string }>;
  structuralMode?: "replace" | "append";
}

export interface RecordConversationSourceAliasInput {
  sourceId: string;
  rootKind: "provider" | "managed_custody";
  rootPath: string;
  relativePath: string;
  aliasKind: "active" | "archive" | "provider" | "managed";
  availability?: ConversationSourceAvailability;
}

export interface RecordManagedNormalizedSourceInput extends ConversationSourceEpochs {
  conversationId: string;
  provider: ConversationSource;
  nativeSessionId: string;
  rootPath: string;
  filePath: string;
  expectedContentHash: string;
  blocks: ReadonlyArray<{
    id: string;
    type: BlockType;
    role: Role;
    position: number;
    timestamp: string | null;
    parentId: string | null;
    dagUuid: string | null;
    dagParentUuid: string | null;
    recordOffset: number;
    recordLength: number;
    recordHash: string;
    recordOrdinal: number;
  }>;
}

export interface RecordNormalizationCheckpointInput extends ConversationSourceEpochs {
  sourceVersionId: string;
  recordOrdinal: number;
  prefixOffset: number;
  state: Record<string, unknown>;
}

export interface UpdateConversationSourceCustodyInput {
  sourceId: string;
  sourceVersionId: string;
  sourceContentSha256: string;
  custodyState: ConversationSourceCustodyState;
  custodyRef?: string | null;
  captureConsistency?: string | null;
  verification?: Record<string, unknown>;
}

export const CURRENT_CONVERSATION_SOURCE_EPOCHS: Readonly<ConversationSourceEpochs> = Object.freeze({
  parserFormat: "provider-jsonl",
  parserVersion: "2",
  normalizationVersion: "2",
  redactionEpoch: 0,
});
