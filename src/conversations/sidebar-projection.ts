import { createHash } from "node:crypto";

export type ConversationSidebarSort = "started_at" | "block_count";
export type ConversationSidebarGroupKind = "pinned" | "project" | "chats";

export interface ConversationSidebarRow {
  id: string;
  source: string;
  project_path: string | null;
  cwd: string | null;
  starred: number;
  started_at: string;
  block_count: number;
}

export interface ConversationSidebarRepo {
  root: string;
  name: string;
}

export interface ConversationSidebarGroup<Row extends ConversationSidebarRow> {
  key: string;
  kind: ConversationSidebarGroupKind;
  label: string;
  total: number;
  rows: Row[];
  next_cursor: string | null;
}

interface CursorPayload {
  v: 1;
  group: string;
  query: string;
  sort: ConversationSidebarSort;
  value: string | number;
  id: string;
}

export class ConversationSidebarCursorError extends Error {}

function normalizePathish(value: string | null | undefined): string {
  return (value ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function pathKey(value: string | null | undefined): string {
  return normalizePathish(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function decodeClaudeProjectPath(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizePathish(value);
  const leaf = normalized.split("/").filter(Boolean).pop() ?? normalized;
  if (!leaf.startsWith("-")) return normalized;
  const parts = leaf.split("-").filter(Boolean);
  return parts.length === 0 ? normalized : `/${parts.join("/")}`;
}

function isCodexUnboundArchivePath(value: string | null | undefined): boolean {
  return /\/Documents\/Codex\/\d{4}-\d{2}-\d{2}\/[^/]+$/i.test(normalizePathish(value));
}

function projectNameFromPath(value: string | null | undefined): string {
  const normalized = normalizePathish(value);
  if (normalized === "No Project") return normalized;
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || "No Project";
}

export function conversationSidebarProject(
  conversation: ConversationSidebarRow,
  workRepos: ConversationSidebarRepo[],
): string {
  if (
    conversation.source === "codex"
    && !conversation.project_path
    && isCodexUnboundArchivePath(conversation.cwd)
  ) {
    return "No Project";
  }

  const candidates = [
    conversation.cwd,
    conversation.project_path,
    decodeClaudeProjectPath(conversation.project_path),
  ].filter((value): value is string => Boolean(value));
  const repos = workRepos
    .map((repo) => ({
      root: normalizePathish(repo.root),
      rootKey: pathKey(repo.root),
      name: repo.name.trim() || projectNameFromPath(repo.root),
    }))
    .filter((repo) => repo.root && repo.rootKey && repo.name && !repo.root.includes("/worktrees/"))
    .sort((left, right) => right.rootKey.length - left.rootKey.length);

  for (const candidate of candidates) {
    const normalized = normalizePathish(candidate);
    const candidateKey = pathKey(candidate);
    for (const repo of repos) {
      if (
        normalized === repo.root
        || normalized.startsWith(`${repo.root}/`)
        || candidateKey.startsWith(repo.rootKey)
      ) {
        return repo.name;
      }
    }
  }

  const fallback = decodeClaudeProjectPath(conversation.project_path)
    ?? conversation.project_path
    ?? conversation.cwd;
  return projectNameFromPath(fallback);
}

function projectGroupKey(label: string): string {
  return `project:${createHash("sha256").update(label).digest("base64url")}`;
}

function sortValue(row: ConversationSidebarRow, sort: ConversationSidebarSort): string | number {
  return sort === "block_count" ? row.block_count : row.started_at;
}

function compareRows(
  left: ConversationSidebarRow,
  right: ConversationSidebarRow,
  sort: ConversationSidebarSort,
): number {
  if (sort === "block_count" && left.block_count !== right.block_count) {
    return right.block_count - left.block_count;
  }
  if (sort === "started_at" && left.started_at !== right.started_at) {
    return right.started_at.localeCompare(left.started_at);
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (
      parsed.v !== 1
      || typeof parsed.group !== "string"
      || typeof parsed.query !== "string"
      || (parsed.sort !== "started_at" && parsed.sort !== "block_count")
      || (typeof parsed.value !== "string" && typeof parsed.value !== "number")
      || typeof parsed.id !== "string"
    ) {
      throw new Error("shape");
    }
    return parsed as CursorPayload;
  } catch {
    throw new ConversationSidebarCursorError("Invalid conversation sidebar cursor");
  }
}

function paginate<Row extends ConversationSidebarRow>(
  rows: Row[],
  key: string,
  sort: ConversationSidebarSort,
  querySignature: string,
  limit: number,
  cursor: string | null,
): { rows: Row[]; next_cursor: string | null } {
  let start = 0;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded.group !== key || decoded.query !== querySignature || decoded.sort !== sort) {
      throw new ConversationSidebarCursorError("Conversation sidebar cursor does not match this query");
    }
    const cursorIndex = rows.findIndex(
      (row) => row.id === decoded.id && sortValue(row, sort) === decoded.value,
    );
    if (cursorIndex < 0) {
      throw new ConversationSidebarCursorError("Conversation sidebar cursor is no longer valid");
    }
    start = cursorIndex + 1;
  }

  const page = rows.slice(start, start + limit);
  const last = page[page.length - 1];
  const nextCursor = last && start + page.length < rows.length
    ? encodeCursor({
      v: 1,
      group: key,
      query: querySignature,
      sort,
      value: sortValue(last, sort),
      id: last.id,
    })
    : null;
  return { rows: page, next_cursor: nextCursor };
}

export function projectConversationSidebar<Row extends ConversationSidebarRow>(options: {
  rows: Row[];
  workRepos: ConversationSidebarRepo[];
  sort: ConversationSidebarSort;
  querySignature: string;
  limit: number;
  groupKey?: string;
  cursor?: string;
}): ConversationSidebarGroup<Row>[] {
  const pinned: Row[] = [];
  const chats: Row[] = [];
  const projects = new Map<string, Row[]>();

  for (const row of options.rows) {
    if (row.starred === 1) {
      pinned.push(row);
      continue;
    }
    const project = conversationSidebarProject(row, options.workRepos);
    if (project === "No Project") {
      chats.push(row);
      continue;
    }
    const group = projects.get(project) ?? [];
    group.push(row);
    projects.set(project, group);
  }

  const groups: Array<{ key: string; kind: ConversationSidebarGroupKind; label: string; rows: Row[] }> = [];
  if (pinned.length > 0) groups.push({ key: "pinned", kind: "pinned", label: "Pinned", rows: pinned });
  for (const [label, rows] of [...projects.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    groups.push({ key: projectGroupKey(label), kind: "project", label, rows });
  }
  if (chats.length > 0) groups.push({ key: "chats", kind: "chats", label: "Chats", rows: chats });

  const selected = options.groupKey
    ? groups.filter((group) => group.key === options.groupKey)
    : groups;
  return selected.map((group) => {
    const sorted = [...group.rows].sort((left, right) => compareRows(left, right, options.sort));
    const page = paginate(
      sorted,
      group.key,
      options.sort,
      options.querySignature,
      options.limit,
      options.cursor ?? null,
    );
    return {
      key: group.key,
      kind: group.kind,
      label: group.label,
      total: sorted.length,
      rows: page.rows,
      next_cursor: page.next_cursor,
    };
  });
}
