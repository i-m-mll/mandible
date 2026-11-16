/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { git } from "./helpers/auth-queue-fixtures.js";
import { newKey } from "./helpers/approval-gate-rig.js";
import { operatorCliRig, type OperatorCliRig } from "./helpers/operator-cli-rig.js";

const BRANCH = "store/pending";
const TITLE = "Record 2 private store changes";

let harness: OperatorCliRig;
let foreignCommit: string;

/** A store-shaped checkout: untracked files beside main, and a pending line whose first commit a foreign key signed. */
beforeEach(async () => {
  harness = await operatorCliRig();
  const repo = harness.r.repo;
  fs.mkdirSync(path.join(repo, "backups"));
  fs.writeFileSync(path.join(repo, "backups", "untracked.txt"), "left alone\n");
  git(repo, ["checkout", "-b", BRANCH, "main"]);
  fs.writeFileSync(path.join(repo, "yubikeys.json"), "[\"enrolled\"]\n");
  git(repo, ["add", "yubikeys.json"]);
  git(repo, ["-c", "gpg.format=ssh", "-c", `user.signingkey=${newKey("yubikey").key}`, "commit", "-S", "-m", "Enroll a YubiKey"]);
  foreignCommit = git(repo, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repo, "handles.txt"), "handle\n");
  git(repo, ["add", "handles.txt"]);
  git(repo, ["commit", "-m", "Record the handle"]);
  git(repo, ["checkout", "main"]);
});
afterEach(async () => harness.close());

function deliver(env?: Record<string, string>) {
  return harness.mandible(["auth", "deliver", BRANCH, "--title", TITLE,
    "--message", `${TITLE}\n\nWhy:\nThe store's branch is protected, so these commits arrive by this merge.`,
    "--verification", "The tool generated the commits.", "--dirty-policy", "allow-untracked"], { cwd: harness.r.repo, env }).done;
}

/** The daemon finishes a completed request's ledger work after the CLI has its result. */
async function settled(): Promise<void> {
  const inFlight = (harness.r.queue as unknown as { inFlight: Map<string, Promise<unknown>> }).inFlight;
  while (inFlight.size) await Promise.allSettled([...inFlight.values()]);
  await harness.r.queue.drainFinalizers();
}

function count(sql: string): number {
  return (harness.r.db.prepare(sql).get() as { n: number }).n;
}

function issuesTitled(): Array<{ id: string; status: string; resolution: string | null }> {
  return harness.r.db.prepare("SELECT id, status, resolution FROM ledger_issues WHERE title = ?").all(TITLE) as never;
}

it("one touch merges the pending line, keeps the foreign-signed commit and closes the filed issue", async () => {
  const { r } = harness;
  const result = await deliver();
  expect(result.code, result.stderr).toBe(0);
  expect(r.signer.touches).toHaveLength(1);
  expect(git(r.repo, ["rev-parse", "main^2"])).toBe(git(r.repo, ["rev-parse", BRANCH]));
  git(r.repo, ["merge-base", "--is-ancestor", foreignCommit, "main^2"]);
  expect(fs.readFileSync(path.join(r.repo, "backups", "untracked.txt"), "utf8")).toBe("left alone\n");
  await settled();
  expect(issuesTitled()).toEqual([expect.objectContaining({ status: "closed", resolution: "delivered" })]);
});

it("a cancelled touch leaves no pending request, and a rerun delivers through the same issue", async () => {
  const { r } = harness;
  r.signer.next.push({ result: "cancelled" });
  const cancelled = await deliver();
  expect(cancelled.code).toBe(1);
  expect(count("SELECT COUNT(*) AS n FROM auth_requests WHERE status = 'pending'")).toBe(0);
  const [issue] = issuesTitled();
  expect(issue).toMatchObject({ status: "open" });
  const rerun = await deliver();
  expect(rerun.code, rerun.stderr).toBe(0);
  expect(r.signer.touches).toHaveLength(2);
  await settled();
  expect(issuesTitled()).toEqual([expect.objectContaining({ id: issue!.id, status: "closed" })]);
});

it("an agent context writes nothing to the ledger", async () => {
  const before = ["ledger_issues", "work_units", "auth_requests"].map((table) => count(`SELECT COUNT(*) AS n FROM ${table}`));
  const result = await deliver({ CLAUDE_CODE_SESSION_ID: "agent-session" });
  expect(result.code).toBe(1);
  expect(["ledger_issues", "work_units", "auth_requests"].map((table) => count(`SELECT COUNT(*) AS n FROM ${table}`))).toEqual(before);
  expect(harness.r.signer.touches).toHaveLength(0);
});
