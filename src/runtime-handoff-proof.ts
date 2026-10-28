import { createHash } from "node:crypto";
import { childOutput } from "./child-observation.js";
import { realpathSync, readFileSync } from "node:fs";
import { resolveProjectRefAsync, type RegistryProject } from "./ledger/project-registry.js";
import { compiledBuildDigest, readBuildRevision, runtimeDependenciesDigest } from "../scripts/build-revision.mjs";
import type { Db } from "./db.js";
import { readGitCommitFacts } from "./git-object-facts.js";
import { canonicalizeChangeMessage } from "./auth-change-message.js";
import { acceptedReleaseSelection, type AcceptedReleaseSelection } from './accepted-release-selection.js';
import path from 'node:path';
import { authorizedMergeSignerLines, extractAtomicMergeState, extractSuccessfulMergeCommitSha, verifyAuthorizedMergeCommitSignature } from "./auth-signature-verification.js";

export interface RuntimePublicationBinding {
  requestId: string;
  executionId: string;
  hookId: string;
  commandDigest: string;
  root: string;
  source?: { root: string; commonGitDir: string; head: string; buildRevision: string; compiledDigest: string; dependencies: { root: string; digest: string }; runtime: { path: string; sha256: string }; files: Record<string, string> };
  sourceProjectId?: string;
  acceptedRelease?: AcceptedReleaseSelection;
  delivery?: 'accepted-release';
  mergeCommit?: string;
  mergeBase?: string;
  mergeHead?: string;
  frozenCandidate?: { tree: string; snapshotRevision: number; snapshotDigest: string; signerCredentialId: string };
}

export type RuntimeSourceReadiness =
  | { ok: true; projectId: string; commonGitDir: string }
  | { ok: false; reason: string };

async function registeredCheckoutProject(db: Db, root: string): Promise<RegistryProject | null> {
  const resolved = await resolveProjectRefAsync(db, root);
  return resolved.ok && resolved.matched_by === "checkout_root" ? resolved.project : null;
}

export async function validateRuntimeSource(db: Db, sourcePath: string, destinationPath: string): Promise<RuntimeSourceReadiness> {
  try {
    const source = realpathSync(sourcePath);
    const destination = realpathSync(destinationPath);
    const destinationProject = await registeredCheckoutProject(db, destination);
    const sourceProject = await registeredCheckoutProject(db, source);
    if (!destinationProject) return { ok: false, reason: `Destination checkout is unregistered. Register its verified canonical project with mandible project add-checkout <project> --root '${destination}'.` };
    if (!sourceProject) return { ok: false, reason: `Installed source checkout is unregistered. After verifying ownership, run mandible project add-checkout ${destinationProject.project_key} --root '${source}'.` };
    if (sourceProject.id !== destinationProject.id) return { ok: false, reason: 'Installed source and destination are registered to different canonical projects; reassociation is not automatic.' };
    const common = async (cwd: string) => realpathSync((await childOutput('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', timeout: 5000 })).trim());
    const commonGitDir = (await common(source));
    if ((await common(destination)) !== commonGitDir) return { ok: false, reason: 'Installed source and destination belong to different Git repositories.' };
    return { ok: true, projectId: destinationProject.id, commonGitDir };
  } catch (error) {
    return { ok: false, reason: `Runtime source readiness could not be verified: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Read-only, narrowly bound first-upgrade proof. A journal never authorizes a merge. */
export async function verifyRuntimeHandoffPublication(db: Db, binding: RuntimePublicationBinding) {
  const fail = (reason: string): never => { throw new Error(`Runtime handoff publication refused: ${reason}`); };
  const row = db.prepare("SELECT * FROM auth_requests WHERE id = ?").get(binding.requestId) as Record<string, any> | undefined;
  const hook = db.prepare("SELECT * FROM auth_hook_executions WHERE id = ?").get(binding.executionId) as Record<string, any> | undefined;
  if (!row || !hook || binding.hookId !== "builtin-mandible-rebuild" || row.type !== "merge" || !["executing", "completed"].includes(row.status) ||
      row.status === "completed" && row.exit_code !== 0 || !row.approved_by_user_id ||
      hook.auth_request_id !== row.id || hook.hook_id !== binding.hookId || hook.command_digest !== binding.commandDigest ||
      createHash("sha256").update(hook.command).digest("hex") !== binding.commandDigest) throw new Error("Runtime handoff publication refused: request or hook binding differs");
  const root = realpathSync(binding.root);
  if (realpathSync(row.target_repo_root ?? row.cwd) !== root) fail("repository binding differs");
  const commit = extractSuccessfulMergeCommitSha(row.output ?? "");
  if (!commit || binding.mergeCommit && binding.mergeCommit !== commit) fail("exact publication receipt is unavailable");
  const events = db.prepare("SELECT revision, snapshot_json, snapshot_sha256 FROM auth_request_lifecycle_events WHERE auth_request_id = ? AND next_status IN ('approved', 'executing') ORDER BY revision DESC").all(row.id) as Array<{ revision: number; snapshot_json: string; snapshot_sha256: string }>;
  const event = events[0];
  if (!event || createHash("sha256").update(event.snapshot_json).digest("hex") !== event.snapshot_sha256) fail("latest frozen approval snapshot is unavailable or corrupt");
  const snapshot = JSON.parse(event!.snapshot_json);
  const frozen = snapshot.request;
  if (frozen.type !== "merge" || frozen.id !== row.id || frozen.approved_by_user_id !== row.approved_by_user_id || !frozen.merge_preflight_base_sha || !frozen.merge_head_sha || !frozen.merge_candidate_tree_sha) fail("frozen approved candidate is unavailable");
  const base = frozen.merge_preflight_base_sha as string;
  const head = frozen.merge_head_sha as string;
  const tree = frozen.merge_candidate_tree_sha as string;
  const selected = binding.delivery === 'accepted-release' ? acceptedReleaseSelection(db, frozen, snapshot.actions ?? [], false) : null;
  if (selected) {
    if (binding.acceptedRelease && JSON.stringify(binding.acceptedRelease) !== JSON.stringify(selected.selection)) fail('accepted release selection changed');
    const liveSelection = db.prepare('SELECT state, payload FROM auth_request_actions WHERE id = ? AND auth_request_id = ?').get(
      snapshot.actions.find((action: any) => action.kind === 'checkpoint_add' && action.payload?.kind === 'accepted-release').id, row.id) as { state: string; payload: string } | undefined;
    if (!liveSelection || !['staged', 'applied'].includes(liveSelection.state)
        || JSON.stringify(JSON.parse(liveSelection.payload).payload) !== JSON.stringify(selected.selection)) fail('accepted release selection was removed or vetoed');
  }
  if (binding.mergeBase && binding.mergeBase !== base || binding.mergeHead && binding.mergeHead !== head) fail("reviewed revisions differ");
  for (const field of ["command", "repo", "base_branch", "head_branch", "approved_by_user_id", "commit_message", "commit_message_digest", "approval_lease_id"]) {
    if (row[field] !== frozen[field]) fail(`frozen ${field} differs`);
  }
  const atomic = extractAtomicMergeState(row.output ?? "");
  if (atomic.invalid || atomic.prepared && (atomic.prepared.merge_sha !== commit || atomic.prepared.base_sha !== base || atomic.prepared.head_sha !== head || atomic.prepared.tree_sha !== tree) ||
      atomic.applied && (atomic.applied.merge_sha !== commit || atomic.applied.base_sha !== base)) fail("atomic publication evidence differs");
  const lease = row.approval_lease_id ? db.prepare("SELECT credential_id FROM delegated_signing_leases WHERE id = ?").get(row.approval_lease_id) as { credential_id: string } | undefined : undefined;
  if (row.approval_lease_id && !lease) fail("delegated approval credential is unavailable");
  const signature = (await verifyAuthorizedMergeCommitSignature(db, root, commit!, row.approved_by_user_id, lease?.credential_id));
  if (!signature.verified || !signature.credential_id) fail("published signature is not authorized");
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of Object.keys(env)) if (/^GIT_(CONFIG_(COUNT|KEY_|VALUE_|PARAMETERS)|DIR$|WORK_TREE$|INDEX_FILE$)/.test(key)) delete env[key as keyof typeof env];
  const gitAt = async (cwd: string, args: string[]) => (await childOutput("git", args, { cwd, env, encoding: "utf8", timeout: 5000 })).trim();
  const git = async (args: string[]) => (await gitAt(root, args));
  let sourceProjectId: string | undefined;
  if (binding.source) {
    const source = binding.source;
    const sourceRoot = realpathSync(source.root);
    const readiness = (await validateRuntimeSource(db, sourceRoot, root));
    if (!readiness.ok) fail(readiness.reason);
    sourceProjectId = readiness.ok ? readiness.projectId : undefined;
    if (binding.sourceProjectId && binding.sourceProjectId !== sourceProjectId) fail("source canonical project changed");
    if (sourceRoot === root || realpathSync((await gitAt(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))) !== source.commonGitDir ||
        realpathSync((await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]))) !== source.commonGitDir ||
        source.head !== head || (await gitAt(sourceRoot, ["rev-parse", "HEAD"])) !== source.head ||
        (await gitAt(sourceRoot, ["status", "--porcelain", "--untracked-files=normal"]))) fail("retained installed source checkout changed");
    for (const name of ["bin/mandible"]) {
      if (createHash("sha256").update(readFileSync(`${sourceRoot}/${name}`)).digest("hex") !== source.files[name]) fail("retained installed source bytes changed");
    }
    if (createHash("sha256").update(readFileSync(source.runtime.path)).digest("hex") !== source.runtime.sha256) fail("retained installed runtime bytes changed");
    if (realpathSync(`${sourceRoot}/node_modules`) !== source.dependencies.root || runtimeDependenciesDigest(sourceRoot) !== source.dependencies.digest) fail("retained installed dependencies changed");
    if (readBuildRevision(sourceRoot) !== source.buildRevision || compiledBuildDigest(sourceRoot) !== source.compiledDigest) fail("retained installed source build changed");
  }
  const published = (await readGitCommitFacts(root, commit!, { env, timeout: 5000 }));
  if (published.parents.join(" ") !== `${base} ${head}` || published.tree !== tree ||
      (await git(["rev-parse", "HEAD"])) !== commit || (await git(["rev-parse", `refs/heads/${row.base_branch}`])) !== commit ||
      (await git(["write-tree"])) !== tree || (await git(["status", "--porcelain", "--untracked-files=no"]))) fail("exact applied checkout differs");
  if (frozen.commit_message_digest && canonicalizeChangeMessage(published.message) !== frozen.commit_message) fail("canonical merge message differs");
  if (selected) await childOutput(process.execPath, [path.join(root, 'scripts/verify-accepted-release.mjs'), selected.selection.reference,
    JSON.stringify(selected.receipt.candidate)], { timeout: 60_000, encoding: 'utf8' });
  if (JSON.stringify(db.prepare("SELECT * FROM auth_requests WHERE id = ?").get(binding.requestId)) !== JSON.stringify(row) ||
      JSON.stringify(db.prepare("SELECT * FROM auth_hook_executions WHERE id = ?").get(binding.executionId)) !== JSON.stringify(hook)) fail("request or hook changed during publication observation");
  if (authorizedMergeSignerLines(db, row.approved_by_user_id, signature.credential_id).length === 0) fail("publication signer is no longer authorized");
  const frozenCandidate = { tree, snapshotRevision: event!.revision, snapshotDigest: event!.snapshot_sha256, signerCredentialId: signature.credential_id! };
  if (binding.frozenCandidate && (Object.keys(frozenCandidate) as Array<keyof typeof frozenCandidate>).some(key => binding.frozenCandidate![key] !== frozenCandidate[key])) fail("frozen proof binding differs");
  return { mergeCommit: commit!, mergeBase: base, mergeHead: head, frozenCandidate, ...(selected ? { acceptedRelease: selected.selection } : {}), ...(sourceProjectId ? { sourceProjectId } : {}) };
}
