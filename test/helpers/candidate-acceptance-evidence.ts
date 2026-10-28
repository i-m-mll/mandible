import type { Db } from '../../src/db.js';

export function readCandidateAcceptanceEvidence(db: Db, requestId: string) {
  const row = db.prepare(`SELECT id, status, error, pin_sha, tree_sha, base_sha, head_sha, result_json
    FROM auth_candidate_acceptances WHERE auth_request_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`)
    .get(requestId) as { id: string; status: string; error: string | null; pin_sha: string; tree_sha: string;
      base_sha: string; head_sha: string; result_json: string | null } | undefined;
  if (!row) return null;
  const { result_json, ...record } = row;
  return { ...record, result: result_json === null ? null : JSON.parse(result_json) };
}

