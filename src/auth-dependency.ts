import type { Db } from "./db.js";
import type { AuthDependencyProjection, AuthRequest } from "./types.js";
import { computeAuthRequestOutcome } from "./contracts.js";
import { resolveIds } from "./entity-refs.js";

export function authDependencies(db: Db, requestedIds: string[]): Map<string, AuthDependencyProjection> {
  const resolutions = resolveIds(db, "auth_request", requestedIds);
  const ids = [...new Set([...resolutions.values()].flatMap(result => result.ok ? [result.id] : []))];
  type Dependency = Pick<AuthRequest, "id" | "status" | "exit_code" | "merge_finalized_at">;
  const rows = ids.length === 0 ? [] : db.prepare(
    `SELECT id, status, exit_code, merge_finalized_at FROM auth_requests WHERE id IN (${ids.map(() => "?").join(", ")})`,
  ).all(...ids) as Dependency[];
  const dependencies = new Map(rows.map(row => [row.id, row]));
  return new Map(requestedIds.map((requestedId): [string, AuthDependencyProjection] => {
    const resolved = resolutions.get(requestedId.trim())!;
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
