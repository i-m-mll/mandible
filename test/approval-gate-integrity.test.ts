/** @vitest-environment node */
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthQueue } from "../src/auth-queue.js";
import type { AuthRequest } from "../src/types.js";
import { commitOnBranch, git } from "./helpers/auth-queue-fixtures.js";
import { operatorCaller } from "./helpers/operator-signing-fixtures.js";
import { forgeX, insertEvidence, markers, newKey, plainMove, registerExternalOperatorKey, rig, row, type Rig } from "./helpers/approval-gate-rig.js";
import { TOUCH_ID_ONLY_OPERATOR_MIGRATION_SQL } from "../src/operator-signing/schema.js";
import { listCredentials, revokeCredential } from "../src/users/store.js";

async function settle(queue: AuthQueue): Promise<void> {
  const internal = queue as unknown as { inFlight: Map<string, Promise<unknown>> };
  for (let i = 0; i < 50 && internal.inFlight.size; i += 1) await Promise.allSettled([...internal.inFlight.values()]);
}

function completed(r: Rig, id: string): boolean {
  const current = row(r.db, id);
  return current.status === "completed" && current.exit_code === 0;
}

async function attempt(fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch { /* refusal is the expected outcome; the assertions read state */ }
}

describe("only the approved merge of a request completes it", () => {
  it("a forged executor report naming a commit another operator key signed, published by plain git", async () => {
    const r = rig();
    try {
      const request = await r.submit("feature/forged-report");
      const held = r.hold();
      await r.approve(request.id);
      await held.started;
      const executing = (await r.queue.getRequest(request.id))!;
      const forged = forgeX(r.repo, executing, registerExternalOperatorKey(r).key);
      plainMove(r.repo, forged);
      await attempt(() => r.queue.setResult(request.id, 0, markers(executing, forged).all));
      held.release();
      await settle(r.queue);
      expect(completed(r, request.id)).toBe(false);
      const audit = await r.queue.baseAuditForRequest((await r.submit("feature/forged-report-later")).id);
      expect(audit?.baseline_sha).not.toBe(forged);
    } finally { await r.dispose(); }
  });

  it("an evidence row inserted by SQL does not complete a request whose branch moved by plain git", async () => {
    const r = rig();
    try {
      const request = await r.submit("feature/sql-row");
      const forged = forgeX(r.repo, request, null);
      plainMove(r.repo, forged);
      insertEvidence(r.db, "forged-publication", r.enclaveCredentialId, { auth_request_id: request.id, signer_user_id: r.operatorId,
        authorizer_user_id: r.operatorId, verified: true, publication_verified: true, commit_sha: forged });
      const now = Date.now();
      r.db.prepare("UPDATE auth_requests SET status = 'executing', approved_at = ?, updated_at = ?, approved_by_user_id = ?, merge_atomic_enabled = 1, execution_evidence_id = 'forged-publication' WHERE id = ?")
        .run(now, now, r.operatorId, request.id);
      await attempt(() => r.queue.setResult(request.id, 0, `${markers(request, forged).result}\n`));
      await settle(r.queue);
      expect(completed(r, request.id)).toBe(false);
    } finally { await r.dispose(); }
  });

  for (const signer of ["unsigned", "unregistered key"] as const) {
    it(`the base audit does not take a ${signer} commit recorded by SQL as its baseline`, async () => {
      const r = rig();
      try {
        commitOnBranch(r.repo, "feature/forged-baseline", { "baseline.txt": "baseline\n" });
        const base = r.main();
        const head = git(r.repo, ["rev-parse", "feature/forged-baseline"]);
        const tree = git(r.repo, ["merge-tree", "--write-tree", base, head]).split(/\s+/)[0]!;
        const forged = forgeX(r.repo, { merge_candidate_tree_sha: tree, merge_preflight_base_sha: base, merge_head_sha: head, commit_message: "Forged\n" } as AuthRequest,
          signer === "unsigned" ? null : newKey().key);
        insertEvidence(r.db, "forged-baseline", r.enclaveCredentialId, { verified: true, publication_verified: true, commit_sha: forged, signer_user_id: r.operatorId });
        r.db.prepare(`INSERT INTO auth_requests (id, session_id, type, command, title, cwd, repo, base_branch, head_branch, merge_head_sha, status, exit_code,
            created_at, updated_at, resolved_at, expires_at, output, execution_mode, files_changed, additions, deletions, approved_by_user_id, execution_evidence_id)
          VALUES ('forged-baseline-request', NULL, 'merge', 'mandible auth merge feature/forged-baseline --into main', 'Forged', ?, ?, 'main', 'feature/forged-baseline', ?, 'completed', 0,
            100, 100, 100, 1000, '', 'daemon', 0, 0, 0, ?, 'forged-baseline')`).run(r.repo, path.basename(r.repo), head, r.operatorId);
        plainMove(r.repo, forged);
        const audit = await r.queue.baseAuditForRequest((await r.submit("feature/after-forged-baseline")).id);
        expect(audit?.status).toBe("unexpected");
        expect(audit?.unexpected.map((commit) => commit.sha)).toContain(forged);
      } finally { await r.dispose(); }
    });
  }
});

describe("an approval is of what was reviewed, one sheet at a time", () => {
  it("refuses a revision other than the one shown, before any sheet", async () => {
    const r = rig();
    try {
      const request = await r.submit("feature/reviewed");
      const shown = r.queue.lifecycleRevision(request.id)!;
      git(r.repo, ["checkout", "feature/reviewed"]); git(r.repo, ["commit", "--allow-empty", "-m", "newer head"]); git(r.repo, ["checkout", "main"]);
      await r.queue.update(request.id, { merge_head_sha: git(r.repo, ["rev-parse", "feature/reviewed"]) });
      expect(r.queue.lifecycleRevision(request.id)).not.toBe(shown);
      await expect(r.queue.approveAsOperator(request.id, operatorCaller(r.operatorId), shown)).rejects.toMatchObject({ code: "lifecycle_conflict" });
      expect(r.signer.touches).toHaveLength(0);
      expect(row(r.db, request.id).status).toBe("pending");
    } finally { await r.dispose(); }
  });

  it("refuses a second signed action while a sheet is open, without opening another", async () => {
    const r = rig();
    const gate = r.signer.block();
    try {
      const request = await r.submit("feature/first");
      const approving = r.approve(request.id);
      await gate.entered;
      let applied = false;
      const second = await r.queue.operatorSigningAuthority!.authorizeTrustChange("protected_branches", { from: ["main"], to: [] },
        "change which branches Mandible protects", undefined, () => { applied = true; });
      expect(second).toMatchObject({ ok: false, error: { code: "signing_in_progress" } });
      expect(applied).toBe(false);
      gate.release();
      await approving;
      expect(r.signer.touches).toHaveLength(1);
    } finally { gate.release(); await r.dispose(); }
  });
});

describe("approving with no usable approval key", () => {
  for (const state of ["not enrolled", "key_missing", "key_invalidated"] as const) {
    it(`is refused before any work when ${state}`, async () => {
      const r = rig();
      try {
        const request = await r.submit(`feature/${state.replace(/ /g, "-")}`);
        const authority = r.queue.operatorSigningAuthority!;
        const key = listCredentials(r.db, r.operatorId).find((credential) => credential.custody === "enclave")!;
        if (state === "not enrolled") revokeCredential(r.db, key.id);
        else r.signer.states.set(authority.keyPath(key.fingerprint), { state });
        const revision = r.queue.lifecycleRevision(request.id);
        await expect(r.approve(request.id)).rejects.toMatchObject({
          refusal: { code: state === "not enrolled" ? "approval_key_required" : state, detail: expect.stringContaining("Touch ID is not set up") },
        });
        expect(r.signer.touches).toHaveLength(0);
        expect(r.execs).toHaveLength(0);
        expect(r.queue.lifecycleRevision(request.id)).toBe(revision);
        expect(row(r.db, request.id).status).toBe("pending");
      } finally { await r.dispose(); }
    });
  }
});

describe("a signer revoked later still counts for merges recorded before its revocation", () => {
  /** A completed request, recorded at `recordedAt`, whose merge an external operator key signed. */
  async function recordedExternalMerge(r: Rig, recordedAt: number): Promise<{ sha: string; credentialId: string }> {
    const external = registerExternalOperatorKey(r);
    commitOnBranch(r.repo, "feature/historical", { "historical.txt": "historical\n" });
    const base = r.main();
    const head = git(r.repo, ["rev-parse", "feature/historical"]);
    const tree = git(r.repo, ["merge-tree", "--write-tree", base, head]).split(/\s+/)[0]!;
    const sha = forgeX(r.repo, { merge_candidate_tree_sha: tree, merge_preflight_base_sha: base, merge_head_sha: head, commit_message: "Historical\n" } as AuthRequest, external.key);
    insertEvidence(r.db, "historical-approval", external.credentialId, { verified: true, commit_sha: sha, signer_user_id: r.operatorId, authorizer_user_id: r.operatorId });
    r.db.prepare(`INSERT INTO auth_requests (id, session_id, type, command, title, cwd, repo, base_branch, head_branch, merge_head_sha, status, exit_code,
        created_at, updated_at, resolved_at, expires_at, output, execution_mode, files_changed, additions, deletions, approved_by_user_id, execution_evidence_id)
      VALUES ('historical-request', NULL, 'merge', 'mandible auth merge feature/historical --into main', 'Historical', ?, ?, 'main', 'feature/historical', ?, 'completed', 0,
        ?, ?, ?, ?, ?, 'daemon', 0, 0, 0, ?, 'historical-approval')`)
      .run(r.repo, path.basename(r.repo), head, recordedAt, recordedAt, recordedAt, recordedAt + 1000, `${markers({ repo: path.basename(r.repo) } as AuthRequest, sha).result}\n`, r.operatorId);
    plainMove(r.repo, sha);
    return { sha, credentialId: external.credentialId };
  }

  it("the migration revokes external operator signers, and the base audit still takes their recorded merge as its baseline", async () => {
    const r = rig();
    try {
      const { sha, credentialId } = await recordedExternalMerge(r, Date.now() - 60_000);
      for (const statement of TOUCH_ID_ONLY_OPERATOR_MIGRATION_SQL) r.db.exec(statement);
      expect(listCredentials(r.db, r.operatorId, { includeRevoked: true }).find((credential) => credential.id === credentialId)?.status).toBe("revoked");
      expect(listCredentials(r.db, r.operatorId).map((credential) => credential.custody)).toEqual(["enclave"]);
      const audit = await r.queue.baseAuditForRequest((await r.submit("feature/after-revocation")).id);
      expect(audit).toMatchObject({ status: "clean", baseline_sha: sha });
    } finally { await r.dispose(); }
  });

  it("a merge recorded after the revocation does not count", async () => {
    const r = rig();
    try {
      const { sha, credentialId } = await recordedExternalMerge(r, Date.now() + 60_000);
      revokeCredential(r.db, credentialId);
      const audit = await r.queue.baseAuditForRequest((await r.submit("feature/after-revocation")).id);
      expect(audit?.baseline_sha).not.toBe(sha);
      expect(audit?.unexpected.map((commit) => commit.sha)).toContain(sha);
    } finally { await r.dispose(); }
  });
});
