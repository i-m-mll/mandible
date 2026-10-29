import { createHash } from "node:crypto";
import { childOutput } from "./child-observation.js";
import { realpathSync, readFileSync } from "node:fs";
import { resolveProjectRefAsync, type RegistryProject } from "./ledger/project-registry.js";
import { compiledBuildDigest, readBuildRevision, runtimeDependenciesDigest } from "../scripts/build-revision.mjs";
import type { Db } from "./db.js";
import { readGitCommitFacts } from "./git-object-facts.js";
import { canonicalizeChangeMessage } from "./auth-change-message.js";
import { acceptedReleaseSelection, type AcceptedReleaseSelection } from './accepted-release-selection.js';
import { authorizedMergeSignerLines, extractAtomicMergeState, extractSuccessfulMergeCommitSha, verifyAuthorizedMergeCommitSignature } from "./auth-signature-verification.js";
import { addAttributionEvidence, getAttributionEvidence } from "./users/store.js";
import { systemAction } from "./identity/resolver.js";

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
  publicationEvidence?: { evidenceId: string; digest: string };
}

export interface RuntimeDeliveryReference {
  publicationEvidence: { evidenceId: string; digest: string };
  journal: string;
}

type RuntimeHookIdentity = Pick<RuntimePublicationBinding, "requestId" | "executionId" | "hookId" | "commandDigest">;
export interface RuntimeDeliveryIntent {
  publicationEvidence: { evidenceId: string; digest: string };
  publication: ReturnType<typeof publicationPayload>;
}

/** Intent is historical ownership, independently of today's signing permission. */
export function findRuntimeDeliveryIntents(db: Db, hooks: readonly RuntimeHookIdentity[]): Map<string, RuntimeDeliveryIntent> {
  const found = new Map<string, RuntimeDeliveryIntent>();
  if (!hooks.length) return found;
  const expected = new Map(hooks.map(hook => [hook.executionId, hook]));
  const rows = db.prepare(`SELECT id FROM attribution_evidence
    WHERE evidence_method = 'credential_signature'
      AND json_extract(details_json, '$.runtime_publication.schema') = 'mandible-runtime-publication@1'
      AND json_extract(details_json, '$.runtime_publication.executionId') IN (${[...expected].map(() => "?").join(",")})
    ORDER BY id`).all(...expected.keys()) as Array<{ id: string }>;
  for (const row of rows) {
    const evidence = getAttributionEvidence(db, row.id)!;
    const publication = evidence.details.runtime_publication as RuntimeDeliveryIntent["publication"];
    const hook = expected.get(publication.executionId)!;
    const hash = digest(publication);
    if (publication.requestId !== hook.requestId || publication.hookId !== hook.hookId || publication.commandDigest !== hook.commandDigest
        || evidence.details.runtime_publication_digest !== hash) throw new Error("Stored runtime delivery intent differs from its hook.");
    const prior = found.get(hook.executionId);
    if (prior && prior.publicationEvidence.digest !== hash) throw new Error("Conflicting runtime delivery intents name this hook.");
    if (!prior) found.set(hook.executionId, { publicationEvidence: { evidenceId: evidence.id, digest: hash }, publication });
  }
  return found;
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

const fail = (reason: string): never => { throw new Error(`Runtime handoff publication refused: ${reason}`); };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function readPublicationState(db: Db, binding: RuntimePublicationBinding) {
  const row = db.prepare("SELECT * FROM auth_requests WHERE id = ?").get(binding.requestId) as Record<string, any> | undefined;
  const hook = db.prepare("SELECT * FROM auth_hook_executions WHERE id = ?").get(binding.executionId) as Record<string, any> | undefined;
  if (!row || !hook || binding.hookId !== "builtin-mandible-rebuild" || row.type !== "merge" || !["executing", "completed"].includes(row.status) ||
      row.status === "completed" && row.exit_code !== 0 || !row.approved_by_user_id ||
      hook.auth_request_id !== row.id || hook.hook_id !== binding.hookId || hook.command_digest !== binding.commandDigest ||
      createHash("sha256").update(hook.command).digest("hex") !== binding.commandDigest) throw new Error("Runtime handoff publication refused: request or hook binding differs");
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
  for (const [field, expected] of [["merge_preflight_base_sha", base], ["merge_head_sha", head],
    ["merge_candidate_tree_sha", tree], ["merge_candidate_pin_sha", frozen.merge_candidate_pin_sha]] as const) {
    if (row[field] && row[field] !== expected) fail("current reviewed candidate differs");
  }
  const selected = binding.delivery === 'accepted-release' ? acceptedReleaseSelection(db, frozen, snapshot.actions ?? [], false) : null;
  let liveSelection: { state: string; payload: string } | undefined;
  if (selected) {
    if (binding.acceptedRelease && JSON.stringify(binding.acceptedRelease) !== JSON.stringify(selected.selection)) fail('accepted release selection changed');
    liveSelection = db.prepare('SELECT state, payload FROM auth_request_actions WHERE id = ? AND auth_request_id = ?').get(
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
  return { row, hook, event: event!, frozen, base, head, tree, commit: commit!, selected, liveSelection, lease };
}

type PublicationState = ReturnType<typeof readPublicationState>;
const stateDigest = (state: PublicationState) => digest({ row: state.row, hook: state.hook, event: state.event, selection: state.liveSelection });

function publicationProof(state: PublicationState, signerCredentialId: string) {
  return { mergeCommit: state.commit, mergeBase: state.base, mergeHead: state.head,
    frozenCandidate: { tree: state.tree, snapshotRevision: state.event.revision, snapshotDigest: state.event.snapshot_sha256, signerCredentialId },
    ...(state.selected ? { acceptedRelease: state.selected.selection } : {}) };
}

function checkFrozenCandidate(binding: RuntimePublicationBinding, frozen: NonNullable<RuntimePublicationBinding["frozenCandidate"]>) {
  if (binding.frozenCandidate && (Object.keys(frozen) as Array<keyof typeof frozen>).some(key => binding.frozenCandidate![key] !== frozen[key])) fail("frozen proof binding differs");
}

/** Read-only initial admission verifies the actual published checkout. */
export async function verifyRuntimeHandoffPublication(db: Db, binding: RuntimePublicationBinding) {
  const state = readPublicationState(db, binding);
  const { row, hook, base, head, tree, commit } = state;
  const root = realpathSync(binding.root);
  if (realpathSync(row.target_repo_root ?? row.cwd) !== root) fail("repository binding differs");
  const lease = state.lease;
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
  if (published.parents.join(" ") !== `${base} ${head}` || published.tree !== tree) fail("published candidate object differs");
  if ((await git(["rev-parse", "HEAD"])) !== commit || (await git(["rev-parse", `refs/heads/${row.base_branch}`])) !== commit ||
      (await git(["write-tree"])) !== tree || (await git(["status", "--porcelain", "--untracked-files=no"]))) fail("exact applied checkout differs");
  if (state.frozen.commit_message_digest && canonicalizeChangeMessage(published.message) !== state.frozen.commit_message) fail("canonical merge message differs");
  if (JSON.stringify(db.prepare("SELECT * FROM auth_requests WHERE id = ?").get(binding.requestId)) !== JSON.stringify(row) ||
      JSON.stringify(db.prepare("SELECT * FROM auth_hook_executions WHERE id = ?").get(binding.executionId)) !== JSON.stringify(hook)) fail("request or hook changed during publication observation");
  if (authorizedMergeSignerLines(db, row.approved_by_user_id, signature.credential_id).length === 0) fail("publication signer is no longer authorized");
  const proof = publicationProof(state, signature.credential_id!);
  checkFrozenCandidate(binding, proof.frozenCandidate);
  return { ...proof, ...(sourceProjectId ? { sourceProjectId } : {}) };
}

function publicationPayload(binding: RuntimePublicationBinding, state: PublicationState,
  signer: { credentialId: string; fingerprint: string }, canonicalRoot: string) {
  return { schema: "mandible-runtime-publication@1",
    requestId: binding.requestId, executionId: binding.executionId, hookId: binding.hookId, commandDigest: binding.commandDigest,
    repository: { root: binding.root, target: state.row.target_repo_root ?? state.row.cwd, canonicalRoot },
    command: state.row.command, repo: state.row.repo, baseBranch: state.row.base_branch, headBranch: state.row.head_branch,
    mergeCommit: state.commit, mergeBase: state.base, mergeHead: state.head, tree: state.tree,
    snapshotRevision: state.event.revision, snapshotDigest: state.event.snapshot_sha256,
    commitMessageDigest: state.frozen.commit_message_digest ?? null, approvalLeaseId: state.row.approval_lease_id ?? null,
    authorizerUserId: state.row.approved_by_user_id, signerCredentialId: signer.credentialId, fingerprint: signer.fingerprint,
    acceptedRelease: state.selected?.selection ?? null };
}

/** Freeze verified publication before arming; the awaiting request's token stays unchanged. */
export async function freezeRuntimeHandoffPublication(db: Db, binding: RuntimePublicationBinding) {
  const observed = stateDigest(readPublicationState(db, binding));
  const proof = await verifyRuntimeHandoffPublication(db, binding);
  const canonicalRoot = realpathSync(binding.root);
  return db.transaction(() => {
    const state = readPublicationState(db, binding);
    if (stateDigest(state) !== observed) fail("request, hook or approval changed before publication freeze");
    const credentialId = proof.frozenCandidate.signerCredentialId;
    if (!authorizedMergeSignerLines(db, state.row.approved_by_user_id, credentialId).length) fail("publication signer is no longer authorized");
    const credential = db.prepare("SELECT fingerprint FROM user_credentials WHERE id = ?").get(credentialId) as { fingerprint: string };
    const payload = publicationPayload(binding, state, { credentialId, fingerprint: credential.fingerprint }, canonicalRoot);
    const payloadDigest = digest(payload);
    if (binding.publicationEvidence) {
      readFrozenPublicationAuthority(db, { ...binding, ...proof });
      return { ...proof, publicationEvidence: binding.publicationEvidence };
    }
    const existing = db.prepare("SELECT id FROM attribution_evidence WHERE evidence_method = 'credential_signature' AND credential_id = ? AND json_extract(details_json, '$.runtime_publication_digest') = ? ORDER BY id")
      .get(credentialId, payloadDigest) as { id: string } | undefined;
    if (existing) return readFrozenPublicationAuthority(db, {
      ...binding, ...proof, publicationEvidence: { evidenceId: existing.id, digest: payloadDigest },
    });
    const authorization = state.row.execution_evidence_id ? getAttributionEvidence(db, state.row.execution_evidence_id) : null;
    const details = { auth_request_id: state.row.id, authorizer_user_id: state.row.approved_by_user_id,
      executor_user_id: systemAction().user_id, approval_source: state.row.approval_source,
      signer_user_id: state.row.approved_by_user_id, verified: true, publication_verified: true,
      commit_sha: state.commit, target_head_sha: state.commit, fingerprint: credential.fingerprint,
      authorization_evidence_id: authorization?.id ?? null, authorization_evidence_method: authorization?.evidence_method ?? null,
      runtime_publication: payload, runtime_publication_digest: payloadDigest };
    const evidence = addAttributionEvidence(db, {
      evidence_method: "credential_signature", credential_id: credentialId, details,
    });
    const reference = { evidenceId: evidence.id, digest: payloadDigest };
    return { ...proof, publicationEvidence: reference };
  }).immediate();
}

/** Continuing authority consumes the ledger proof; the checkout is no longer a resource. */
export async function verifyRuntimeHandoffAuthority(db: Db, binding: RuntimePublicationBinding) {
  return readFrozenPublicationAuthority(db, binding);
}

function readFrozenPublicationAuthority(db: Db, binding: RuntimePublicationBinding) {
  if (!binding.publicationEvidence || !binding.frozenCandidate || !binding.mergeCommit || !binding.mergeBase || !binding.mergeHead) {
    fail("durable frozen publication evidence is unavailable");
  }
  return db.transaction(() => {
    const state = readPublicationState(db, binding);
    const evidence = getAttributionEvidence(db, binding.publicationEvidence!.evidenceId);
    const payload = evidence?.details.runtime_publication as ReturnType<typeof publicationPayload> | undefined;
    if (!evidence || evidence.evidence_method !== "credential_signature" || !payload || payload.schema !== "mandible-runtime-publication@1"
        || typeof payload.repository?.canonicalRoot !== "string" || !payload.repository.canonicalRoot
        || digest(payload) !== binding.publicationEvidence!.digest || evidence.details.runtime_publication_digest !== binding.publicationEvidence!.digest
        || !evidence.credential_id || evidence.credential_id !== payload.signerCredentialId) fail("frozen publication evidence differs");
    const credentialId = evidence!.credential_id!;
    if (!authorizedMergeSignerLines(db, state.row.approved_by_user_id, credentialId).length
        || state.lease && state.lease.credential_id !== credentialId) fail("publication signer is no longer authorized");
    const credential = db.prepare("SELECT fingerprint FROM user_credentials WHERE id = ?").get(credentialId) as { fingerprint: string };
    const expected = publicationPayload(binding, state, { credentialId, fingerprint: credential.fingerprint }, payload!.repository.canonicalRoot);
    if (JSON.stringify(payload) !== JSON.stringify(expected)
        || evidence!.details.verified !== true || evidence!.details.publication_verified !== true
        || evidence!.details.auth_request_id !== state.row.id || evidence!.details.commit_sha !== state.commit
        || evidence!.details.authorizer_user_id !== state.row.approved_by_user_id || evidence!.details.signer_user_id !== state.row.approved_by_user_id
        || evidence!.details.fingerprint !== credential.fingerprint) fail("frozen publication evidence differs");
    const proof = publicationProof(state, credentialId);
    checkFrozenCandidate(binding, proof.frozenCandidate);
    return { ...proof, publicationEvidence: binding.publicationEvidence! };
  }).deferred();
}
