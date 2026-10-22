/**
 * Issue 117ba80 — protected-base history audit.
 *
 * Runs only where Mandible already reads a protected base for a merge request
 * (submission, candidate refresh, and approval just before execution). It
 * walks the base's first-parent history back to the newest recorded Mandible
 * merge into that repo and branch, the last tip Mandible knows, so it is
 * incremental and needs no state of its own beyond the stored result.
 * Recorded merges therefore pass whatever key signed them. Every commit above
 * that tip is one Mandible did not record, and must be signed with an operator
 * `ssh_key` (the `unrecorded_commit` rule in src/protected-branch-signers.ts);
 * anything else, including a delegated-key signature, is listed on the
 * request.
 */

import { childOutput } from "./child-observation.js";

import type { ProtectedBaseAudit, ProtectedBaseAuditCommit } from "./contracts.js";
import type { Db } from "./db.js";
import { readCommitSignatures } from "./protected-branch-signers.js";

/** First-parent commits examined above the last known tip before the audit stops. */
export const PROTECTED_BASE_AUDIT_LIMIT = 100;
/** Newer recorded merges checked for presence in the base's history. */
const MISSING_MERGE_CHECK_LIMIT = 10;

export interface ProtectedBaseAuditInput {
  cwd: string;
  baseSha: string;
  /** Recorded Mandible merge commits into this repo and branch, with their completion times. */
  recordedMerges: ReadonlyMap<string, number>;
  now: number;
}

export async function auditProtectedBase(db: Db, input: ProtectedBaseAuditInput): Promise<ProtectedBaseAudit> {
  const audit: ProtectedBaseAudit = {
    status: "clean",
    base_sha: input.baseSha,
    baseline_sha: null,
    checked_commits: 0,
    truncated: false,
    unexpected: [],
    missing_merges: [],
    error: null,
    checked_at: input.now,
  };
  if (input.recordedMerges.size === 0) return { ...audit, status: "no_baseline" };
  const git = async (args: string[]): Promise<string> => (await childOutput("git", args, {
    cwd: input.cwd,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  })).trim();
  try {
    const history = (await git(["rev-list", "--first-parent", "-n", String(PROTECTED_BASE_AUDIT_LIMIT + 1), input.baseSha]))
      .split(/\s+/).filter(Boolean);
    const above: string[] = [];
    for (const sha of history) {
      if (input.recordedMerges.has(sha)) {
        audit.baseline_sha = sha;
        break;
      }
      above.push(sha);
    }
    audit.truncated = !audit.baseline_sha && above.length > PROTECTED_BASE_AUDIT_LIMIT;
    const checked = above.slice(0, PROTECTED_BASE_AUDIT_LIMIT);
    audit.checked_commits = checked.length;
    audit.unexpected = (await readCommitSignatures(db, input.cwd, checked, "unrecorded_commit")).flatMap((commit): ProtectedBaseAuditCommit[] =>
      commit.status === "operator" ? [] : [{
        sha: commit.sha,
        subject: commit.subject,
        signer: commit.fingerprint,
        reason: commit.status === "invalid" ? "invalid_signature" : commit.status,
      }]);
    const baselineAt = audit.baseline_sha ? input.recordedMerges.get(audit.baseline_sha)! : -Infinity;
    const newer = [...input.recordedMerges]
      .filter(([, resolvedAt]) => resolvedAt > baselineAt)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MISSING_MERGE_CHECK_LIMIT);
    for (const [sha] of newer) {
      try {
        (await git(["merge-base", "--is-ancestor", sha, input.baseSha]));
      } catch {
        audit.missing_merges.push(sha);
      }
    }
  } catch (error) {
    return { ...audit, status: "error", error: error instanceof Error ? error.message : String(error) };
  }
  audit.status = audit.unexpected.length || audit.missing_merges.length ? "unexpected" : "clean";
  return audit;
}

export function saveProtectedBaseAudit(db: Db, requestId: string, audit: ProtectedBaseAudit): void {
  db.prepare(
    `INSERT INTO auth_base_audits (auth_request_id, base_sha, result_json, checked_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(auth_request_id) DO UPDATE SET
       base_sha = excluded.base_sha, result_json = excluded.result_json, checked_at = excluded.checked_at`,
  ).run(requestId, audit.base_sha, JSON.stringify(audit), audit.checked_at);
}

export function loadProtectedBaseAudit(db: Db, requestId: string): ProtectedBaseAudit | null {
  const row = db.prepare("SELECT result_json FROM auth_base_audits WHERE auth_request_id = ?")
    .get(requestId) as { result_json: string } | undefined;
  return row ? JSON.parse(row.result_json) as ProtectedBaseAudit : null;
}

/** Findings in `current` that `shown` did not already list. */
export function unseenBaseAuditFindings(
  shown: ProtectedBaseAudit | null,
  current: ProtectedBaseAudit,
): Pick<ProtectedBaseAudit, "unexpected" | "missing_merges"> {
  const seenCommits = new Set(shown?.unexpected.map((commit) => commit.sha) ?? []);
  const seenMissing = new Set(shown?.missing_merges ?? []);
  return {
    unexpected: current.unexpected.filter((commit) => !seenCommits.has(commit.sha)),
    missing_merges: current.missing_merges.filter((sha) => !seenMissing.has(sha)),
  };
}

/** One line per finding: short SHA, subject, and signer or "unsigned". */
export function describeBaseAuditFindings(findings: Pick<ProtectedBaseAudit, "unexpected" | "missing_merges">): string {
  return [
    ...findings.unexpected.map((commit) =>
      `${commit.sha.slice(0, 10)} ${commit.subject} (${commit.signer ? `signed by ${commit.signer}, not an operator hardware key` : "unsigned"})`),
    ...findings.missing_merges.map((sha) => `${sha.slice(0, 10)} recorded Mandible merge is no longer in the branch history`),
  ].join("\n");
}
