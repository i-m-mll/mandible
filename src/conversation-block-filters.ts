import type { BlockType, ConversationBlock, ConversationSource, Role } from "./parsers/types.js";

export interface ConversationLike {
  id?: string | null;
  source?: ConversationSource | string | null;
  session_id?: string | null;
  title?: string | null;
  source_path?: string | null;
}

export interface InspectableBlock {
  id?: string | null;
  conversation_id?: string | null;
  type: BlockType | string;
  role: Role | string;
  content: string;
  position: number;
  timestamp?: string | null;
  parent_id?: string | null;
  metadata?: Record<string, unknown>;
  metadata_json?: string | null;
}

export interface BlockFilterOptions {
  roles?: string[];
  types?: string[];
  tool?: string | null;
  toolKind?: string | null;
  since?: string | null;
  until?: string | null;
  content?: string | null;
  limit: number;
}

export interface BlockFilterEnvelope {
  source: "log" | "database";
  provider: string | null;
  conversation: ConversationLike;
  filters: {
    role: string[];
    type: string[];
    tool: string | null;
    tool_kind: string | null;
    since: string | null;
    until: string | null;
    content: string | null;
    limit: number;
  };
  total: number;
  provider_capabilities?: unknown;
  blocks: InspectableBlock[];
}

export function parseCsv(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function parseBound(value: string | null | undefined, now = Date.now()): string | null {
  if (!value) return null;
  if (/^\d+d$/.test(value)) {
    const days = Number(value.slice(0, -1));
    return new Date(now - days * 86400_000).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`).toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return parsed.toISOString();
}

export function metadataForBlock(block: InspectableBlock): Record<string, unknown> {
  if (block.metadata && typeof block.metadata === "object") return block.metadata;
  if (!block.metadata_json) return {};
  try {
    const parsed = JSON.parse(block.metadata_json);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function normalizeParsedBlock(
  block: Omit<ConversationBlock, "id" | "conversation_id">,
  conversation: ConversationLike,
): InspectableBlock {
  return {
    conversation_id: conversation.id ?? null,
    type: block.type,
    role: block.role,
    content: block.content,
    position: block.position,
    timestamp: block.timestamp,
    parent_id: block.parent_id,
    metadata: { ...(block.metadata ?? {}) },
  };
}

export function matchesBlock(block: InspectableBlock, filters: BlockFilterOptions): boolean {
  const metadata = metadataForBlock(block);
  if (filters.roles?.length && !filters.roles.includes(block.role)) return false;
  if (filters.types?.length && !filters.types.includes(block.type)) return false;
  if (filters.tool && metadata.tool_name !== filters.tool) return false;
  if (filters.toolKind && metadata.tool_kind !== filters.toolKind) return false;
  if (filters.content && !block.content.toLowerCase().includes(filters.content.toLowerCase())) {
    return false;
  }

  const since = filters.since ? new Date(filters.since).getTime() : null;
  const until = filters.until ? new Date(filters.until).getTime() : null;
  if (since !== null || until !== null) {
    if (!block.timestamp) return false;
    const ts = new Date(block.timestamp).getTime();
    if (Number.isNaN(ts)) return false;
    if (since !== null && ts < since) return false;
    if (until !== null && ts > until) return false;
  }

  return true;
}

export function filterBlocks(
  blocks: InspectableBlock[],
  filters: BlockFilterOptions,
): InspectableBlock[] {
  return blocks.filter((block) => matchesBlock(block, filters)).slice(0, filters.limit);
}

export function makeEnvelope(
  source: "log" | "database",
  provider: string | null,
  conversation: ConversationLike,
  filters: BlockFilterOptions,
  blocks: InspectableBlock[],
  providerCapabilities?: unknown,
): BlockFilterEnvelope {
  return {
    source,
    provider,
    conversation,
    filters: {
      role: filters.roles ?? [],
      type: filters.types ?? [],
      tool: filters.tool ?? null,
      tool_kind: filters.toolKind ?? null,
      since: filters.since ?? null,
      until: filters.until ?? null,
      content: filters.content ?? null,
      limit: filters.limit,
    },
    total: blocks.length,
    provider_capabilities: providerCapabilities,
    blocks: blocks.map((block) => ({
      ...block,
      metadata: metadataForBlock(block),
    })),
  };
}
