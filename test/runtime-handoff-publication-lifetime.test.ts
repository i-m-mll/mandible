// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { bindingDigest, handoffDirectory } from "../scripts/runtime-handoff.mjs";
import { createMigratedDb } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

it("keeps the staged publication database open until asynchronous verification rejects", async () => {
  const home = fs.mkdtempSync(path.join(testRuntimeRoot, "handoff-publication-"));
  const database = path.join(home, "fixture.db");
  const db = createMigratedDb({ path: database });
  const now = Date.now();
  const digest = "accepted-recovery";
  db.prepare(`INSERT INTO auth_requests (id, type, command, title, status, exit_code, repo, created_at, updated_at, expires_at)
    VALUES ('lifetime-request', 'merge', 'mandible auth merge feature/x --into main', 'Private recovery', 'completed', 0, 'fixture', ?, ?, ?)`).run(now, now, now + 60_000);
  db.prepare(`INSERT INTO auth_hook_executions (id, auth_request_id, hook_id, command, command_digest, state, attempts, exit_code, output, created_at, updated_at)
    VALUES ('lifetime-run', 'lifetime-request', 'builtin-mandible-rebuild', 'rebuild', ?, 'complete', 1, 0, ?, ?, ?)`).run("c".repeat(64), `MANDIBLE_RUNTIME_RECOVERY_ACCEPTED:${digest}`, now, now);
  db.close();
  try {
    const runtime = execFileSync("/bin/sh", ["scripts/bun-runtime.sh"], { encoding: "utf8", timeout: 10_000 }).trim();
    const binding = {
      home, requestId: "lifetime-request", executionId: "lifetime-run", hookId: 'builtin-mandible-rebuild', commandDigest: "c".repeat(64),
      runtime: { path: runtime, sha256: createHash("sha256").update(fs.readFileSync(runtime)).digest("hex") },
    };
    const dir = handoffDirectory(home, binding.requestId, binding.executionId);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync(runtime, ["build", "src/sqlite.ts", "--target", "bun", "--outfile", path.join(dir, "sqlite.mjs")], { stdio: "pipe", timeout: 10_000 });
    // This staged verifier instruments lifetime; it grants no publication proof.
    const proofPath = path.join(dir, "proof.mjs");
    fs.writeFileSync(proofPath, `let observe; export function configure(callback) { observe = callback; }
export async function verifyRuntimeHandoffPublication(db, binding) { return await observe(db, binding); }
`);
    const journal = {
      schema: "mandible-runtime-handoff@1", binding, bindingDigest: bindingDigest(binding), database,
      phase: "failed", recovery: { digest },
    };
    const journalPath = path.join(dir, "journal.json");
    const before = JSON.stringify(journal);
    fs.writeFileSync(journalPath, before);
    const runner = path.join(dir, "lifetime.mjs");
    fs.writeFileSync(runner, `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { configure } from './proof.mjs';
import { completeRuntimeHandoffRecovery } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "scripts/runtime-handoff.mjs")).href)};
const entered = Promise.withResolvers();
const release = Promise.withResolvers();
const sentinel = new Error('Publication verification rejected');
let verificationDb, recoveredState;
configure(async db => {
  verificationDb = db;
  entered.resolve();
  await release.promise;
  recoveredState = db.prepare('SELECT state FROM auth_hook_executions WHERE id = ?').get('lifetime-run');
  throw sentinel;
});
const journal = JSON.parse(fs.readFileSync(${JSON.stringify(journalPath)}, 'utf8'));
const recovery = completeRuntimeHandoffRecovery(journal);
void recovery.catch(() => undefined);
try {
  await Promise.race([entered.promise, recovery.then(() => { throw new Error('Recovery completed before verifier entry'); })]);
  await new Promise(resolve => setImmediate(resolve));
  release.resolve();
  await assert.rejects(recovery, error => error === sentinel);
  assert.deepEqual(recoveredState, { state: 'complete' });
  assert.throws(() => verificationDb.prepare('SELECT 1'));
  console.log(JSON.stringify({ readAfterAwait: true, identicalRejection: true, closedAfterRejection: true }));
} finally {
  release.resolve();
  await recovery.catch(() => undefined);
}
`);
    const result = execFileSync(runtime, [runner], { encoding: "utf8", timeout: 10_000 });
    expect(JSON.parse(result)).toEqual({ readAfterAwait: true, identicalRejection: true, closedAfterRejection: true });
    expect(fs.readFileSync(journalPath, "utf8")).toBe(before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
