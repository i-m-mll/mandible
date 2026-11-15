import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthQueue } from "../../src/auth-queue.js";
import type { Db } from "../../src/db.js";
import { buildMergeCommit, signedCommitObject } from "../../src/merge-commit.js";
import type { SignOutcome, SignRequest } from "../../src/operator-signing/signer.js";
import type { AuthRequest } from "../../src/types.js";
import { addCredential } from "../../src/users/store.js";
import {
  AUTH_MERGE_REVIEW, commitOnBranch, configureSigningCredential, createAuthCheckRepo, createMigratedDb,
  createNoopHookManager, git, publishFixtureExecution, registerWorkRepo, trackTempPath,
} from "./auth-queue-fixtures.js";
import { fixtureOperatorSigning, operatorCaller, SoftwareOperatorSigner } from "./operator-signing-fixtures.js";

export type Executor = NonNullable<ConstructorParameters<typeof AuthQueue>[0]>["executor"];
export type ExecOptions = Parameters<NonNullable<Executor>>[0];

/** A software signer whose sign can be blocked. */
export class ScriptedSigner extends SoftwareOperatorSigner {
  gate: Promise<void> | null = null;
  entered: (() => void) | null = null;
  override async sign(request: SignRequest, signal?: AbortSignal): Promise<SignOutcome> {
    this.entered?.();
    if (this.gate) await this.gate;
    return super.sign(request, signal);
  }
  block(): { release: () => void; entered: Promise<void> } {
    let release!: () => void;
    this.gate = new Promise((resolve) => { release = () => { this.gate = null; resolve(); }; });
    const entered = new Promise<void>((resolve) => { this.entered = () => { this.entered = null; resolve(); }; });
    return { release, entered };
  }
}

export function newKey(name = "other"): { key: string; pub: string; fingerprint: string } {
  const dir = trackTempPath(fs.mkdtempSync(path.join(os.tmpdir(), `qa-key-${name}-`)));
  const key = path.join(dir, "key");
  execFileSync("ssh-keygen", ["-q", "-t", "ecdsa", "-b", "256", "-N", "", "-C", "", "-f", key]);
  const pub = fs.readFileSync(`${key}.pub`, "utf8").trim();
  const fingerprint = execFileSync("ssh-keygen", ["-lf", `${key}.pub`, "-E", "sha256"], { encoding: "utf8" }).trim().split(/\s+/)[1]!;
  return { key, pub, fingerprint };
}

export function sshSign(key: string, bytes: Buffer): string {
  const signed = spawnSync("ssh-keygen", ["-q", "-Y", "sign", "-n", "git", "-f", key], { input: bytes, encoding: "buffer" });
  if (signed.status !== 0) throw new Error(signed.stderr.toString());
  return signed.stdout.toString("utf8");
}

/** Attacker-prepared commit X with the reviewed tree, parents and message; signed by `key` or unsigned. */
export function forgeX(repo: string, request: AuthRequest, key: string | null, seconds = 1_794_700_000): string {
  const unsigned = buildMergeCommit({
    tree: request.merge_candidate_tree_sha!, parents: [request.merge_preflight_base_sha!, request.merge_head_sha!],
    message: request.commit_message!, identity: { name: "Mandible Test", email: "mandible-test@localhost" },
    time: { seconds, offset_minutes: 0 },
  });
  const object = key ? signedCommitObject(unsigned, sshSign(key, unsigned)) : unsigned;
  const written = spawnSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: repo, input: object, encoding: "utf8" });
  if (written.status !== 0) throw new Error(written.stderr);
  return written.stdout.trim();
}

export function markers(request: AuthRequest, mergeSha: string): { prepared: string; applied: string; result: string; all: string } {
  const prepared = `MANDIBLE_MERGE_PREPARED ${JSON.stringify({ merge_sha: mergeSha, base_sha: request.merge_preflight_base_sha, head_sha: request.merge_head_sha, tree_sha: request.merge_candidate_tree_sha })}`;
  const applied = `MANDIBLE_MERGE_APPLIED ${JSON.stringify({ merge_sha: mergeSha, base_sha: request.merge_preflight_base_sha })}`;
  const result = `MANDIBLE_MERGE_RESULT ${JSON.stringify({ merge_sha: mergeSha, repo_id: request.repo, declared_issues: [] })}`;
  return { prepared, applied, result, all: `${prepared}\n${applied}\n${result}\n` };
}

/** Move refs/heads/main to `sha` by plain git and sync the checkout, as an attacker with repo access would. */
export function plainMove(repo: string, sha: string): void {
  const before = git(repo, ["rev-parse", "main"]);
  git(repo, ["update-ref", "refs/heads/main", sha]);
  git(repo, ["read-tree", "-m", "-u", before, sha]);
}

export interface Held { started: Promise<ExecOptions>; release: (result?: { exit_code: number; output: string }) => void }

export interface Rig {
  repo: string;
  db: Db;
  queue: AuthQueue;
  signer: ScriptedSigner;
  operatorId: string;
  enclaveCredentialId: string;
  execs: ExecOptions[];
  hold(): Held;
  submit(branch: string, files?: Record<string, string>): Promise<AuthRequest>;
  approve(id: string): Promise<AuthRequest>;
  main(): string;
  dispose(): Promise<void>;
}

export function rig(): Rig {
  const repo = createAuthCheckRepo();
  const db = createMigratedDb();
  const signing = configureSigningCredential(db, repo);
  git(repo, ["config", "--unset", "user.signingkey"]);
  const signer = new ScriptedSigner();
  const execs: ExecOptions[] = [];
  const mode: { kind: "publish" | "hold" } = { kind: "publish" };
  let holder: { resolve: (o: ExecOptions) => void; done: Promise<{ exit_code: number; output: string }>; finish: (r: { exit_code: number; output: string }) => void } | null = null;
  let queue!: AuthQueue;
  const executor: Executor = async (opts) => {
    execs.push(opts);
    if (mode.kind === "publish") return publishFixtureExecution(queue, opts);
    const h = holder!;
    h.resolve(opts);
    const r = await h.done;
    return { exit_code: r.exit_code, signal: null, stdout: "", stderr: r.output, output: r.output, started_at: Date.now(), finished_at: Date.now() };
  };
  queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false,
    operatorSigning: fixtureOperatorSigning(db, signer), executor });
  registerWorkRepo(db, repo);
  const r: Rig = {
    repo, db, queue, signer, operatorId: signing.operatorId, enclaveCredentialId: signing.credentialId, execs,
    hold() {
      mode.kind = "hold";
      let resolve!: (o: ExecOptions) => void;
      const started = new Promise<ExecOptions>((res) => { resolve = res; });
      let finish!: (x: { exit_code: number; output: string }) => void;
      const done = new Promise<{ exit_code: number; output: string }>((res) => { finish = res; });
      holder = { resolve, done, finish };
      return { started, release: (result = { exit_code: 1, output: "held executor released\n" }) => finish(result) };
    },
    async submit(branch, files = { [`${branch.replace(/\//g, "_")}.txt`]: `${branch}\n` }) {
      commitOnBranch(repo, branch, files);
      return queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", command: `mandible auth merge ${branch} --into main`,
        title: `Merge ${branch}`, cwd: repo, repo: path.basename(repo), base_branch: "main", head_branch: branch,
        merge_head_sha: git(repo, ["rev-parse", branch]) });
    },
    approve: (id) => queue.approveAsOperator(id, operatorCaller(signing.operatorId), queue.lifecycleRevision(id)!),
    main: () => git(repo, ["rev-parse", "main"]),
    async dispose() {
      holder?.finish({ exit_code: 1, output: "dispose\n" });
      await queue.dispose().catch(() => undefined);
      db.close();
    },
  };
  return r;
}

export function registerExternalOperatorKey(r: Rig): { key: string; credentialId: string } {
  const k = newKey("external");
  const credential = addCredential(r.db, r.operatorId, { type: "ssh_key", fingerprint: k.fingerprint, public_material: k.pub, label: "YubiKey stand-in" });
  return { key: k.key, credentialId: credential.id };
}

export function row(db: Db, id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM auth_requests WHERE id = ?").get(id) as Record<string, unknown>;
}

export function insertEvidence(db: Db, id: string, credentialId: string | null, details: Record<string, unknown>): void {
  db.prepare("INSERT INTO attribution_evidence (id, evidence_method, credential_id, verified_at, details_json) VALUES (?, 'credential_signature', ?, ?, ?)")
    .run(id, credentialId, Date.now(), JSON.stringify(details));
}
