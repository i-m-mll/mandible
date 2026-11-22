/** @vitest-environment node */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listCredentials } from "../src/users/store.js";
import { git } from "./helpers/auth-queue-fixtures.js";
import { operatorCliRig, type OperatorCliRig } from "./helpers/operator-cli-rig.js";
import { row } from "./helpers/approval-gate-rig.js";

let harness: OperatorCliRig;
beforeEach(async () => { harness = await operatorCliRig(); });
afterEach(async () => harness.close());

function commit(message: string, options: { cwd?: string; env?: Record<string, string> } = {}) {
  return harness.mandible(["commit", "-m", message], { cwd: options.cwd ?? harness.r.repo, env: options.env });
}

function stage(files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(harness.r.repo, name), content);
  git(harness.r.repo, ["add", ...Object.keys(files)]);
}

function commitRequests(): Array<Record<string, unknown>> {
  return harness.r.db.prepare("SELECT * FROM auth_requests WHERE type = 'commit'").all() as Array<Record<string, unknown>>;
}

function verifyWithApprovalKey(ref: string): void {
  const { r } = harness;
  const approvalKey = listCredentials(r.db, r.operatorId).find((credential) => credential.id === r.enclaveCredentialId)!;
  const signers = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "direct-commit-signers-")), "allowed_signers");
  fs.writeFileSync(signers, `* ${approvalKey.public_material}\n`);
  git(r.repo, ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${signers}`, "verify-commit", ref]);
}

it("one touch commits the index onto the protected branch like git commit -m, leaving other changes alone", async () => {
  const { r } = harness;
  const before = r.main();
  fs.writeFileSync(path.join(r.repo, "unstaged.txt"), "first\n");
  git(r.repo, ["add", "unstaged.txt"]);
  git(r.repo, ["commit", "-m", "Track a file to leave modified"]);
  const parent = r.main();
  const staged = "# Long review\n\n" + "A line of proposed wording.\n".repeat(4_100);
  stage({ "staged.mdx": staged });
  fs.writeFileSync(path.join(r.repo, "unstaged.txt"), "edited but not staged\n");
  fs.writeFileSync(path.join(r.repo, "untracked.txt"), "untracked\n");
  const index = git(r.repo, ["write-tree"]);

  const result = await commit("Fix the typo  \n\n\nWith a body.\n\n").done;

  expect(result.code, result.stderr).toBe(0);
  expect(before).not.toBe(parent);
  expect(r.signer.touches).toHaveLength(1);
  expect(r.signer.touches[0]!.reason).toMatch(/commit directly to main of .+: "Fix the typo" \(1 file changed\)/);
  expect(git(r.repo, ["rev-parse", "main^"])).toBe(parent);
  expect(git(r.repo, ["rev-parse", "main^{tree}"])).toBe(index);
  expect(git(r.repo, ["log", "-1", "--format=%B", "main"])).toBe("Fix the typo\n\nWith a body.");
  verifyWithApprovalKey("main");
  expect(git(r.repo, ["status", "--porcelain"]).split("\n").map((line) => line.trim()).sort()).toEqual(["?? untracked.txt", "M unstaged.txt"]);
  const [request] = commitRequests();
  expect(request).toMatchObject({ status: "completed", exit_code: 0, base_branch: "main", commit_message: "Fix the typo\n\nWith a body.\n", files_changed: 1 });
  const token = harness.auth.mintApiToken(r.operatorId).token;
  const get = (suffix = "") => fetch(`${harness.base}/api/auth/request/${request!.id}${suffix}`,
    { headers: { Authorization: `Bearer ${token}` } });
  const detail = await get();
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ change_report: {
    comparison: { merge_base_sha: parent, head_sha: r.main() },
    files: [{ new_path: "staged.mdx", review_format: "markdown" }],
  } });
  const file = await get("/files/0");
  expect(file.status).toBe(200);
  expect(await file.json()).toMatchObject({ kind: "text", before: { contents: "" }, after: { contents: staged } });
});

it("a pending merge still approves after a direct commit, and the base audit stays clean", async () => {
  const { r } = harness;
  const pending = await r.submit("feature/before-direct-commit");
  stage({ "direct.txt": "direct\n" });
  expect((await commit("Direct change").done).code).toBe(0);
  const direct = r.main();

  await r.approve(pending.id);
  await expect.poll(() => row(r.db, pending.id).status).toBe("completed");

  expect(git(r.repo, ["rev-parse", "main^1"])).toBe(direct);
  expect(git(r.repo, ["rev-parse", "main^2"])).toBe(pending.merge_head_sha);
  const later = await r.submit("feature/after-direct-commit");
  expect(await r.queue.baseAuditForRequest(later.id)).toMatchObject({ status: "clean", unexpected: [] });
});

it("refuses with nothing changed and no touch when nothing is staged or the branch is not protected", async () => {
  const { r } = harness;
  const main = r.main();
  const nothingStaged = await commit("Nothing here").done;
  git(r.repo, ["checkout", "-q", "-b", "feature/unprotected"]);
  stage({ "elsewhere.txt": "x\n" });
  const unprotected = await commit("Not protected").done;

  for (const result of [nothingStaged, unprotected]) expect(result.code).toBe(1);
  expect(nothingStaged.stderr).toContain("No changes are staged");
  expect(unprotected.stderr).toContain("not a protected branch");
  expect(r.signer.touches).toHaveLength(0);
  expect(r.main()).toBe(main);
  expect(commitRequests()).toEqual([]);
});

it("refuses when the branch moves while the sheet is up", async () => {
  const { r } = harness;
  stage({ "racing.txt": "racing\n" });
  const held = r.signer.block();
  const run = commit("Raced");
  await held.entered;
  git(r.repo, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "Moved meanwhile"]);
  const moved = r.main();
  held.release();
  const result = await run.done;

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("moved");
  expect(r.main()).toBe(moved);
  expect(commitRequests()).toEqual([]);
});

it("an interrupted or cancelled sheet commits nothing", async () => {
  const { r } = harness;
  const main = r.main();
  stage({ "cancelled.txt": "cancelled\n" });
  r.signer.next.push({ result: "cancelled" });
  const cancelled = await commit("Cancelled").done;
  const held = r.signer.block();
  const run = commit("Interrupted");
  await held.entered;
  run.child.kill("SIGTERM");
  const interrupted = await run.done;
  held.release();

  expect(cancelled.code).toBe(1);
  expect(interrupted.code).toBe(130);
  await expect.poll(() => r.signer.touches.length).toBe(2);
  expect(r.main()).toBe(main);
  expect(commitRequests()).toEqual([]);
});

it("an agent context is refused before Mandible is contacted", async () => {
  const { r } = harness;
  stage({ "agent.txt": "agent\n" });
  const result = await commit("Agent commit", { env: { CLAUDE_CODE_SESSION_ID: "agent-session" } }).done;
  expect(result.code).toBe(1);
  expect(harness.posts("commit")).toBe(0);
  expect(r.signer.touches).toHaveLength(0);
});
