import {
  compareConversationSidebarRows,
  type ConversationSidebarSort,
} from "./sidebar-order.js";

export type { ConversationSidebarSort } from "./sidebar-order.js";
export type ConversationSidebarGroupKind = "pinned" | "chats";

export interface ConversationSidebarRow {
  id: string;
  source: string;
  project_path: string | null;
  cwd: string | null;
  starred: number;
  started_at: string;
  block_count: number;
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

function sortValue(row: ConversationSidebarRow, sort: ConversationSidebarSort): string | number {
  return sort === "block_count" ? row.block_count : row.started_at;
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

export function buildConversationSidebar<Row extends ConversationSidebarRow>(options: {
  rows: Row[];
  sort: ConversationSidebarSort;
  querySignature: string;
  limit: number;
  groupKey?: string;
  cursor?: string;
}): ConversationSidebarGroup<Row>[] {
  const pinned: Row[] = [];
  const chats: Row[] = [];

  for (const row of options.rows) {
    if (row.starred === 1) {
      pinned.push(row);
      continue;
    }
    chats.push(row);
  }

  const groups: Array<{ key: string; kind: ConversationSidebarGroupKind; label: string; rows: Row[] }> = [];
  if (pinned.length > 0) groups.push({ key: "pinned", kind: "pinned", label: "Pinned", rows: pinned });
  if (chats.length > 0) groups.push({ key: "chats", kind: "chats", label: "Chats", rows: chats });

  const selected = options.groupKey
    ? groups.filter((group) => group.key === options.groupKey)
    : groups;
  return selected.map((group) => {
    const sorted = [...group.rows].sort((left, right) => (
      compareConversationSidebarRows(left, right, options.sort)
    ));
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
