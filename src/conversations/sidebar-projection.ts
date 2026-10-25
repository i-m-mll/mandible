import path from "node:path";
import { createHash } from "node:crypto";

import {
  compareConversationSidebarRows,
  type ConversationSidebarSort,
} from "./sidebar-order.js";

export type { ConversationSidebarSort } from "./sidebar-order.js";
export type ConversationSidebarGroupKind = "pinned" | "project" | "chats";

export interface ConversationSidebarProject {
  id: string;
  project_key: string;
  display_name: string;
  checkout_roots: string[];
}

export interface ConversationSidebarRow {
  id: string;
  source: string;
  project_path: string | null;
  cwd: string | null;
  starred: number;
  started_at: string;
  block_count: number;
  canonical_project_id?: string | null;
  canonical_project_key?: string | null;
  canonical_placement_explicit?: boolean | number;
}

export interface ConversationSidebarGroup<Row extends ConversationSidebarRow> {
  key: string;
  kind: ConversationSidebarGroupKind;
  label: string;
  project_id?: string;
  project_key?: string;
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

export function conversationProjectGroupKey(projectId: string): string {
  return `project-${createHash("sha256").update(projectId).digest("base64url")}`;
}

function normalizedAbsolutePath(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  return path.normalize(trimmed);
}

function rootSpecificity(root: string): number {
  return root.split(path.sep).filter(Boolean).length;
}

type CanonicalProjectResolver = (row: ConversationSidebarRow) => ConversationSidebarProject | null;

/**
 * A checkout root contains a stored path when it equals the path or is a
 * prefix of it ending at a separator, so the roots that can contain a path are
 * the path itself and, at each separator, the prefix with and without that
 * separator.
 */
function* matchableRoots(candidate: string): Generator<string> {
  yield candidate;
  for (let index = candidate.indexOf(path.sep); index >= 0; index = candidate.indexOf(path.sep, index + 1)) {
    yield candidate.slice(0, index + 1);
    if (index > 0) yield candidate.slice(0, index);
  }
}

function createCanonicalProjectResolver(projects: ConversationSidebarProject[]): CanonicalProjectResolver {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const projectsByRoot = new Map<string, { depth: number; projects: ConversationSidebarProject[] }>();
  for (const project of projects) {
    for (const rawRoot of project.checkout_roots) {
      const root = normalizedAbsolutePath(rawRoot);
      if (!root) continue;
      const entry = projectsByRoot.get(root) ?? { depth: rootSpecificity(root), projects: [] };
      entry.projects.push(project);
      projectsByRoot.set(root, entry);
    }
  }
  const byStoredPaths = new Map<string, ConversationSidebarProject | null>();

  function resolveStoredPaths(cwd: string | null, projectPath: string | null): ConversationSidebarProject | null {
    let specificity = -1;
    const matches = new Map<string, ConversationSidebarProject>();
    for (const candidate of [normalizedAbsolutePath(cwd), normalizedAbsolutePath(projectPath)]) {
      if (candidate === null) continue;
      for (const root of matchableRoots(candidate)) {
        const entry = projectsByRoot.get(root);
        if (!entry || entry.depth < specificity) continue;
        if (entry.depth > specificity) {
          specificity = entry.depth;
          matches.clear();
        }
        for (const project of entry.projects) matches.set(project.id, project);
      }
    }
    return matches.size === 1 ? matches.values().next().value ?? null : null;
  }

  return (row) => {
    if (row.canonical_placement_explicit) {
      return row.canonical_project_id ? projectsById.get(row.canonical_project_id) ?? null : null;
    }
    const key = `${row.cwd ?? ""}\0${row.project_path ?? ""}`;
    let resolved = byStoredPaths.get(key);
    if (resolved === undefined) {
      resolved = resolveStoredPaths(row.cwd, row.project_path);
      byStoredPaths.set(key, resolved);
    }
    return resolved;
  };
}

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
  projects?: ConversationSidebarProject[];
  requestedProjectIds?: string[];
  pinnedIds?: string[];
}): ConversationSidebarGroup<Row>[] {
  const pinned: Row[] = [];
  const chats: Row[] = [];
  const requestedIds = new Set(options.requestedProjectIds ?? []);
  const pinnedIds = options.pinnedIds ? new Set(options.pinnedIds) : null;
  const projectRows = new Map<string, Row[]>(
    (options.requestedProjectIds ?? []).map((id) => [id, []]),
  );

  const resolveCanonicalProject = createCanonicalProjectResolver(options.projects ?? []);
  for (const originalRow of options.rows) {
    const project = resolveCanonicalProject(originalRow);
    const row = {
      ...originalRow,
      canonical_project_id: project?.id ?? null,
      canonical_project_key: project?.project_key ?? null,
    } as Row;
    if (pinnedIds ? pinnedIds.has(row.id) : row.starred === 1) {
      pinned.push(row);
      continue;
    }
    if (project && requestedIds.has(project.id)) {
      projectRows.get(project.id)!.push(row);
      continue;
    }
    chats.push(row);
  }

  const groups: Array<{
    key: string;
    kind: ConversationSidebarGroupKind;
    label: string;
    project_id?: string;
    project_key?: string;
    rows: Row[];
  }> = [];
  if (pinned.length > 0) groups.push({ key: "pinned", kind: "pinned", label: "Pinned", rows: pinned });
  for (const projectId of options.requestedProjectIds ?? []) {
    const project = options.projects?.find((candidate) => candidate.id === projectId);
    if (!project) continue;
    groups.push({
      key: conversationProjectGroupKey(project.id),
      kind: "project",
      label: project.display_name,
      project_id: project.id,
      project_key: project.project_key,
      rows: projectRows.get(project.id) ?? [],
    });
  }
  if (chats.length > 0) groups.push({ key: "chats", kind: "chats", label: "Chats", rows: chats });

  const selected = options.groupKey
    ? groups.filter((group) => group.key === options.groupKey)
    : groups;
  return selected.map((group) => {
    const pinnedPositions = group.kind === "pinned" && options.pinnedIds
      ? new Map(options.pinnedIds.map((id, index) => [id, index]))
      : null;
    const sorted = [...group.rows].sort((left, right) => pinnedPositions
      ? (pinnedPositions.get(left.id) ?? Number.MAX_SAFE_INTEGER)
        - (pinnedPositions.get(right.id) ?? Number.MAX_SAFE_INTEGER)
        || compareConversationSidebarRows(left, right, options.sort)
      : compareConversationSidebarRows(left, right, options.sort));
    if (group.kind === "pinned" && options.cursor) throw new ConversationSidebarCursorError("Pinned chats do not use pagination cursors");
    const page = group.kind === "pinned" ? { rows: sorted, next_cursor: null } : paginate(
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
      ...(group.project_id ? { project_id: group.project_id } : {}),
      ...(group.project_key ? { project_key: group.project_key } : {}),
      total: sorted.length,
      rows: page.rows,
      next_cursor: page.next_cursor,
    };
  });
}
