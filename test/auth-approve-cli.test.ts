/** @vitest-environment node */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { addGrant } from "../src/permissions/store.js";
import { createUser, listCredentials } from "../src/users/store.js";
import { git } from "./helpers/auth-queue-fixtures.js";
import { operatorCliRig, type OperatorCliRig } from "./helpers/operator-cli-rig.js";

let harness: OperatorCliRig;
beforeEach(async () => { harness = await operatorCliRig(); });
afterEach(async () => harness.close());

function revision(id: string): string {
  return String(harness.r.queue.lifecycleRevision(id));
}

function approve(args: string[], env?: Record<string, string>) {
  return harness.mandible(["auth", "approve", ...args], { env });
}

it("one touch publishes the merge signed by the approval key, even when it settles before the subscription", async () => {
  const { r } = harness;
  const request = await r.submit("feature/terminal-approve");
  harness.holdSubscription(() => harness.resolvedBroadcast(request.id));
  const result = await approve([request.id.slice(0, 8), "--revision", revision(request.id)]).done;
  expect(result.code, result.stderr).toBe(0);
  expect(r.signer.touches).toHaveLength(1);
  expect(git(r.repo, ["rev-parse", "main^2"])).toBe(request.merge_head_sha);
  const approvalKey = listCredentials(r.db, r.operatorId).find((credential) => credential.id === r.enclaveCredentialId)!;
  const signers = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "approve-cli-signers-")), "allowed_signers");
  fs.writeFileSync(signers, `* ${approvalKey.public_material}\n`);
  git(r.repo, ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${signers}`, "verify-commit", "main"]);
});

it("refuses a stale revision without a touch", async () => {
  const { r } = harness;
  const request = await r.submit("feature/stale-revision");
  const result = await approve([request.id, "--revision", String(Number(revision(request.id)) - 1)]).done;
  expect(result.code).toBe(1);
  expect(r.signer.touches).toHaveLength(0);
  expect((await r.queue.getRequest(request.id))!.status).toBe("pending");
});

it("a cancelled touch leaves the request pending", async () => {
  const { r } = harness;
  const request = await r.submit("feature/cancelled-touch");
  r.signer.next.push({ result: "cancelled" });
  const result = await approve([request.id, "--revision", revision(request.id)]).done;
  expect(result.code).toBe(1);
  expect(r.signer.touches).toHaveLength(1);
  expect((await r.queue.getRequest(request.id))!.status).toBe("pending");
});

it("TERM while the sheet is up dismisses it and leaves the request pending", async () => {
  const { r } = harness;
  const request = await r.submit("feature/terminated");
  const held = r.signer.block();
  const run = approve([request.id, "--revision", revision(request.id)]);
  await held.entered;
  run.child.kill("SIGTERM");
  const result = await run.done;
  held.release();
  expect(result.code).toBe(130);
  expect(harness.posts("cancel-proof")).toBe(1);
  await expect.poll(() => (r.queue as unknown as { operatorProofInFlight: Map<string, unknown> }).operatorProofInFlight.size).toBe(0);
  expect((await r.queue.getRequest(request.id))!.status).toBe("pending");
});

it("an agent context is refused before any approval request", async () => {
  const { r } = harness;
  const request = await r.submit("feature/agent-context");
  const result = await approve([request.id, "--revision", revision(request.id)], { CLAUDE_CODE_SESSION_ID: "agent-session" }).done;
  expect(result.code).toBe(1);
  expect(harness.posts("approve")).toBe(0);
  expect(r.signer.touches).toHaveLength(0);
});

it("a non-operator holding approve_auth is refused with 403, not a server error", async () => {
  const { r } = harness;
  const request = await r.submit("feature/deputy");
  const deputy = createUser(r.db, { slug: "deputy", kind: "human", display_name: "Deputy" });
  addGrant(r.db, { subject_type: "user", subject: deputy.id, permission: "approve_auth" });
  const response = await fetch(`${harness.base}/api/auth/request/${request.id}/approve`, {
    method: "POST", headers: { Authorization: `Bearer ${harness.auth.mintApiToken(deputy.id).token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ lifecycle_revision: r.queue.lifecycleRevision(request.id) }),
  });
  expect(response.status).toBe(403);
  expect(r.signer.touches).toHaveLength(0);
});
