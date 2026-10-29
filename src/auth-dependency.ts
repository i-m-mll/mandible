import type { Db } from "./db.js";
import type { AuthDependencyProjection, AuthRequest } from "./types.js";
import { computeAuthRequestOutcome } from "./contracts.js";
import { decodeAuthDependencies } from "./auth-request-row.js";
import { resolveIds } from "./entity-refs.js";

const authReference = (reference: string): string => reference.trim().replace(/^auth:/, "");

export function authDependencies(db: Db, requestedIds: string[]): Map<string, AuthDependencyProjection> {
  const resolutions = resolveIds(db, "auth_request", requestedIds.map(authReference));
  const ids = [...new Set([...resolutions.values()].flatMap(result => result.ok ? [result.id] : []))];
  type Dependency = Pick<AuthRequest, "id" | "status" | "exit_code" | "merge_finalized_at">;
  const rows = ids.length === 0 ? [] : db.prepare(
    `SELECT id, status, exit_code, merge_finalized_at FROM auth_requests WHERE id IN (${ids.map(() => "?").join(", ")})`,
  ).all(...ids) as Dependency[];
  const dependencies = new Map(rows.map(row => [row.id, row]));
  return new Map(requestedIds.map((requestedId): [string, AuthDependencyProjection] => {
    const resolved = resolutions.get(authReference(requestedId))!;
    const dependency = resolved.ok ? dependencies.get(resolved.id) : undefined;
    if (!dependency) return [requestedId, {
      state: !resolved.ok && resolved.error !== "not_found" ? "ambiguous" : "missing",
      requested_id: requestedId, request_id: null, status: null, outcome: null, exit_code: null, merge_finalized_at: null,
    }];
    const outcome = computeAuthRequestOutcome(dependency.status);
    return [requestedId, {
      state: dependency.status !== "completed" ? (outcome === null ? "pending" : "failed")
        : dependency.merge_finalized_at == null ? "unfinalized" : "ready",
      requested_id: requestedId, request_id: dependency.id, status: dependency.status, outcome,
      exit_code: dependency.exit_code, merge_finalized_at: dependency.merge_finalized_at ?? null,
    }];
  }));
}

export function canonicalAuthDependencies(db: Db, references: string[], requestId?: string): string[] {
  if (!Array.isArray(references) || references.some(ref => typeof ref !== "string" || !ref.trim())) {
    throw { status: 400, message: "depends_on_ids must be an array of nonempty request references." };
  }
  const resolutions = resolveIds(db, "auth_request", references.map(authReference));
  const ids = new Set<string>();
  for (const reference of references) {
    const resolved = resolutions.get(authReference(reference))!;
    if (!resolved.ok) throw { status: 400, message: `Dependency ${reference} is ${resolved.error === "not_found" ? "missing" : "ambiguous"}.` };
    ids.add(resolved.id);
  }
  const visiting = new Set<string>(requestId ? [requestId] : []);
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw { status: 400, message: "Auth prerequisites must not contain a cycle or self-reference." };
    if (visited.has(id)) return;
    visiting.add(id);
    const row = db.prepare("SELECT depends_on_id, depends_on_ids FROM auth_requests WHERE id = ?").get(id) as Record<string, unknown>;
    for (const dependency of authDependencies(db, decodeAuthDependencies(row)).values()) {
      if (!dependency.request_id) throw { status: 400, message: `Dependency ${dependency.requested_id} is ${dependency.state}.` };
      visit(dependency.request_id);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  return [...ids].sort();
}
