import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { computeAuthMergeReviewMetadata } from "../src/auth-context.js";
import { AuthQueue } from "../src/auth-queue.js";
import { setSetting } from "../src/client-auth/settings-kv.js";
import type { Db } from "../src/db.js";
import { createBriefingBundle, replaceBriefingBundleLayout, type BriefingBundleViewer } from "../src/feedback/briefing-bundles.js";
import { configureBriefingGroup, createBriefingGroup, readBriefingGroup } from "../src/feedback/briefing-groups.js";
import { publishBriefingFromArtifactVersion } from "../src/feedback/briefings.js";
import { readRequestReview } from "../src/feedback/request-review.js";
import { addOrUpdateCheckout, addProject } from "../src/ledger/project-registry.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { registerBriefingConversionRequests, registerBriefingRoutes } from "../src/routes/briefing.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { Router } from "../src/server.js";
import Database from "../src/sqlite.js";
import { createUser } from "../src/users/store.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import {
  AUTH_MERGE_REVIEW, createAuthCheckRepo, createNoopHookManager, git, registerWorkRepo, uniqueMissingPath, waitForStatus, writeFile,
} from "./helpers/auth-queue-fixtures.js";
import { operatorCaller } from "./helpers/operator-signing-fixtures.js";
import { runCli, startStubDaemon, type StubDaemon } from "./helpers/cli-process.js";
import { migratedFileDb } from "./helpers/ledger-fixtures.js";

function createConversionTransport(db: Db) {
  const queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false,
    executor: async () => { throw new Error("A native Briefing conversion must not start a shell command"); } });
  const operator = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" });
  setSetting(db, "user.operator_id", operator.id);
  const viewer = { userId: operator.id, operator: true };
  const agent = createUser(db, { slug: "layout-editor", kind: "agent", display_name: "Layout editor" });
  const router = new Router({ clientAuth: {
    authenticate: token => {
      const userId = token === "operator" ? viewer.userId : token === "agent" ? agent.id : null;
      return userId ? { user_id: userId, slug: token!, method: "api_token", credential_id: null,
        source: "in_process", effect_ceiling: PRODUCTION_EFFECTS } : null;
    },
    mode: () => "compat",
    recordUnattributedWrite: () => {},
  } });
  registerBriefingRoutes(router, db, inlineLedgerReader(() => db));
  registerBriefingConversionRequests(router, db, queue);
  const connectAgent = () => startStubDaemon(({ method, url, headers, body }) =>
    router.invoke({ method, url, credential: headers.authorization?.replace(/^Bearer /i, ""), body }));
  return { agent, viewer, queue, router, connectAgent };
}

function commit(repo: string, subject: string) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", subject]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function seedMixedBriefingGroup(db: Db, viewer: BriefingBundleViewer) {
  const firstRepo = createAuthCheckRepo();
  const secondRepo = createAuthCheckRepo();
  const register = (projectKey: string, root: string) => {
    registerWorkRepo(db, root);
    const project = addProject(db, { project_key: projectKey });
    addOrUpdateCheckout(db, project.id, { root, default_branch: "main" });
    return project.id;
  };
  const first = register("first-project", firstRepo);
  const second = register("second-project", secondRepo);
  const source = "Text copied from the former source.\n";
  writeFile(firstRepo, "shared.md", "First project text.\n");
  writeFile(firstRepo, "legacy.md", "Existing custody file.\n");
  writeFile(firstRepo, "source.md", source);
  const oldBase = commit(firstRepo, "First project's original documents");
  git(firstRepo, ["mv", "legacy.md", "current.md"]);
  const firstBase = commit(firstRepo, "Record a protected rename");
  writeFile(secondRepo, "shared.md", "Second project text.\n");
  const secondBase = commit(secondRepo, "Second project's original document");
  const version = recordArtifactVersion(db, { source_kind: "tracked_repo", project: first,
    commit: oldBase, path: "legacy.md", custody_mode: "git" }).artifact_version;
  const legacy = publishBriefingFromArtifactVersion(db, {
    profile: "mandible-briefing.v3", title: "Existing custody file",
    artifact_version_ref: version.id, responder_user_ids: [viewer.userId],
  }).briefing_id;
  const current = createBriefingBundle(db, { name: "Current", briefingRefs: [], viewer });
  const pending = createBriefingBundle(db, { name: "Custody proposal", briefingRefs: [], viewer });
  replaceBriefingBundleLayout(db, current.id, { layout: [
    { kind: "tracked", project_ref: second, path: "shared.md" },
    { kind: "subgroup", name: "Shared instructions", members: [
      { kind: "tracked", project_ref: first, path: "renamed.md" },
      { kind: "briefing", briefing_ref: legacy },
      { kind: "tracked", project_ref: first, path: "shared.md" },
      { kind: "tracked", project_ref: first, path: "copy.md" },
      { kind: "tracked", project_ref: first, path: "source.md" },
    ] },
  ] }, viewer);
  const group = createBriefingGroup(db, { key: "mixed-policy", name: "Mixed policy",
    currentBundleRef: current.id, bundleRefs: [pending.id], viewer });
  return { group, current, pending, first, firstRepo, firstBase, second, secondRepo, secondBase, source };
}

function agentConversionRequests(router: Router, groupId: string, baseRef: string) {
  const endpoint = `/api/briefing-groups/${groupId}/tracking-conversion`;
  const plan = async () => {
    const response = await router.invoke({ method: "GET", url: endpoint, credential: "agent" });
    expect(response.status).toBe(200);
    return (response.body as { plan: { plan_digest: string } }).plan;
  };
  const requestConversion = (plan_digest: string) => router.invoke({
    method: "POST", url: `${endpoint}/requests`, credential: "agent",
    body: { expected_base_bundle_ref: baseRef, plan_digest },
  });
  return { plan, requestConversion };
}

function runAgentCli(daemon: StubDaemon, args: string[]) {
  return runCli(args, { env: { ...daemon.env, MANDIBLE_TOKEN: "agent", MANDIBLE_NO_KEYCHAIN_TOKEN: "1" } });
}

async function submitCrossProjectProposals(queue: AuthQueue, userId: string,
  { firstRepo, secondRepo, source }: ReturnType<typeof seedMixedBriefingGroup>) {
  git(firstRepo, ["switch", "-c", "feature/review"]);
  git(firstRepo, ["mv", "shared.md", "renamed.md"]);
  writeFile(firstRepo, "copy.md", source);
  writeFile(firstRepo, "source.md", "Different retained source text.\n");
  const firstHead = commit(firstRepo, "Rename and copy");
  git(firstRepo, ["switch", "main"]);
  git(secondRepo, ["switch", "-c", "feature/review"]);
  writeFile(secondRepo, "shared.md", "Second project edit.\n");
  const secondHead = commit(secondRepo, "Edit the second project's shared path");
  git(secondRepo, ["switch", "main"]);
  const submit = async (project: string, repo: string, merge_head_sha: string, depends_on_ids: string[] = []) => {
    const { changeReport } = await computeAuthMergeReviewMetadata(repo, "main", "feature/review");
    return queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", depends_on_ids, repo: project, cwd: repo, target_repo_root: repo,
      command: "mandible auth merge feature/review --into main", title: "Review instructions",
      base_branch: "main", head_branch: "feature/review", merge_head_sha, change_report: changeReport }, userId);
  };
  const firstRequest = await submit("first-project", firstRepo, firstHead);
  const secondRequest = await submit("second-project", secondRepo, secondHead, [firstRequest.id]);
  return { firstRequest, secondRequest };
}

it("qualifies tracked paths by project and keeps reviewed pins and custody history across conversion", async () => {
  const db = migratedFileDb(uniqueMissingPath("tracking-conversion.db"));
  const { agent, viewer, queue, router, connectAgent } = createConversionTransport(db);
  let daemon: StubDaemon | undefined;
  try {
    const fixture = seedMixedBriefingGroup(db, viewer);
    const { group, current, pending, first, firstBase, second, secondRepo, secondBase } = fixture;
    const baseRef = current.id.slice(0, 8);
    const { plan, requestConversion } = agentConversionRequests(router, group.id, baseRef);
    const backupDirectory = path.join(path.dirname(db.name), "backups");
    const beforePlan = db.prepare("SELECT total_changes() AS writes").get();
    const blocked = await plan();
    expect(blocked).toMatchObject({ pending_proposal_ids: [pending.id], members: [
      { kind: "track", old_path: "legacy.md", path: "current.md", evidence: "recorded_rename" },
    ] });
    expect(await requestConversion(blocked.plan_digest)).toMatchObject({
      status: 409, body: { code: "conversion_pending_proposals", proposal_ids: [pending.id] },
    });
    expect(db.prepare("SELECT total_changes() AS writes").get()).toEqual(beforePlan);
    expect(existsSync(backupDirectory)).toBe(false);

    const dismissal = configureBriefingGroup(db, group.id, { currentBundleRef: current.id, bundleRefs: [] }, viewer).group.history[0]!;
    const ready = await plan();
    expect(await requestConversion(blocked.plan_digest)).toMatchObject({
      status: 409, body: { code: "conversion_plan_drift" },
    });
    const approve = (id: string) => queue.approveAsOperator(id, operatorCaller(viewer.userId), queue.lifecycleRevision(id)!);
    const stale = await requestConversion(ready.plan_digest);
    expect(stale.status).toBe(201);
    const staleId = (stale.body as { request_id: string }).request_id;
    configureBriefingGroup(db, group.id, { currentBundleRef: current.id, bundleRefs: [pending.id] }, viewer);
    await approve(staleId);
    await waitForStatus(queue, staleId, "failed");
    expect(queue.getRequestExact(staleId)?.error).toMatch(/decide all custody proposals/i);
    expect(existsSync(backupDirectory)).toBe(false);

    configureBriefingGroup(db, group.id, { currentBundleRef: current.id, bundleRefs: [] }, viewer);
    daemon = await connectAgent();
    const requested = await runAgentCli(daemon, ["briefing", "group", "convert", group.key, "--request",
      "--expected-base", baseRef, "--plan-digest", (await plan()).plan_digest, "--json"]);
    expect(requested.status, requested.stderr).toBe(0);
    const { request_id: requestId } = JSON.parse(requested.stdout) as { request_id: string };
    expect(queue.getRequestExact(requestId)).toMatchObject({ status: "pending", requested_by_user_id: agent.id,
      type: "config-change" });
    await expect(queue.approveAsOperator(requestId, operatorCaller(agent.id), queue.lifecycleRevision(requestId)!))
      .rejects.toMatchObject({ code: "operator_required" });
    expect(existsSync(backupDirectory)).toBe(false);
    await approve(requestId);
    await waitForStatus(queue, requestId, "completed");
    const conversion = JSON.parse(queue.getRequestExact(requestId)!.output) as {
      bundle_id: string; backup_path: string; changed: boolean;
    };
    expect(conversion.changed).toBe(true);
    const backup = new Database(conversion.backup_path, { readonly: true, fileMustExist: true });
    try {
      expect(backup.prepare("SELECT current_bundle_id FROM briefing_groups WHERE id = ?").get(group.id))
        .toEqual({ current_bundle_id: current.id });
    } finally {
      backup.close();
    }
    const converted = readBriefingGroup(db, group.id, viewer);
    expect(converted.history.find(decision => decision.id === dismissal.id)).toMatchObject({ prior_base: { id: current.id } });
    expect(converted.current?.id).toBe(conversion.bundle_id);
    expect(converted.current?.layout[1]).toMatchObject({ kind: "subgroup", members: [
      { kind: "tracked", tracked: { path: "renamed.md", content: null } },
      { kind: "tracked", tracked: { path: "current.md", content: "Existing custody file.\n" } },
      { kind: "tracked", tracked: { path: "shared.md", commit_sha: firstBase, content: "First project text.\n" } },
      { kind: "tracked", tracked: { path: "copy.md", content: null } },
      { kind: "tracked", tracked: { path: "source.md" } },
    ] });

    const { firstRequest, secondRequest } = await submitCrossProjectProposals(queue, viewer.userId, fixture);
    const shown = await runAgentCli(daemon, ["briefing", "group", "show", group.key, "--json"]);
    expect(shown.status, shown.stderr).toBe(0);
    const agentGroup = (JSON.parse(shown.stdout) as { group: typeof converted }).group;
    expect(agentGroup.current?.layout[0]).toMatchObject({ kind: "tracked",
      tracked: { project_id: second, commit_sha: secondBase, content: "Second project text.\n" } });
    const entries = agentGroup.tracked_proposals;
    const namedFiles = firstRequest.change_report!.files.map(({ change_kind, old_path, new_path }) => [change_kind, old_path, new_path]);
    const rename = namedFiles.findIndex(([kind, oldPath, newPath]) => kind === "renamed" && oldPath === "shared.md" && newPath === "renamed.md");
    const copy = namedFiles.findIndex(([kind, oldPath, newPath]) => kind === "copied" && oldPath === "source.md" && newPath === "copy.md");
    const edit = namedFiles.findIndex(([kind, oldPath]) => kind === "modified" && oldPath === "source.md");
    expect(Math.min(rename, copy, edit)).toBeGreaterThanOrEqual(0);
    expect(entries.find(entry => entry.request_id === firstRequest.id)?.members).toEqual([
      { project_id: first, path: "renamed.md", file_indexes: [rename] },
      { project_id: first, path: "shared.md", file_indexes: [rename] },
      { project_id: first, path: "copy.md", file_indexes: [copy] },
      { project_id: first, path: "source.md", file_indexes: [edit] },
    ]);
    expect(entries.find(entry => entry.request_id === secondRequest.id)).toMatchObject({
      members: [{ project_id: second, path: "shared.md" }],
      depends_on: [{ request_id: firstRequest.id, state: "pending" }],
    });

    const review = await readRequestReview(db, firstRequest, viewer.userId);
    expect(review.tracked_groups[0]?.members).toEqual(entries.find(entry => entry.request_id === firstRequest.id)?.members);
    expect(review.tracked_groups[0]?.documents[0]).toMatchObject({ project_id: second, commit_sha: secondBase, content: "Second project text.\n" });
    const frozen = db.prepare("SELECT snapshot_json FROM briefing_request_group_snapshots").get() as { snapshot_json: string };
    expect(JSON.parse(frozen.snapshot_json)[0].documents[0]).toEqual({
      project_id: second, path: "shared.md", project_key: "second-project", commit_sha: secondBase,
    });
    const pinned = db.prepare("SELECT tracked_snapshot_json FROM briefing_group_dispositions WHERE id = ?")
      .get(dismissal.id) as { tracked_snapshot_json: string };
    expect(JSON.parse(pinned.tracked_snapshot_json)[0].layout[0].tracked).toEqual(
      JSON.parse(frozen.snapshot_json)[0].documents[0],
    );
    expect(git(secondRepo, ["rev-parse", `refs/mandible/review/${secondBase}`])).toBe(secondBase);
    writeFile(secondRepo, "shared.md", "Second project protected update.\n");
    const secondCurrent = commit(secondRepo, "Advance the other protected branch");
    expect((await readRequestReview(db, firstRequest, viewer.userId)).tracked_groups).toEqual(review.tracked_groups);
    const reread = readBriefingGroup(db, group.id, viewer);
    expect(reread.history[0]?.prior_base?.layout[0]).toMatchObject({
      kind: "tracked", tracked: { commit_sha: secondBase, content: "Second project text.\n" },
    });
    expect(reread.current?.layout[0]).toMatchObject({
      kind: "tracked", tracked: { commit_sha: secondCurrent, content: "Second project protected update.\n" },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM artifact_version").get()).toEqual({ count: 1 });
    db.prepare("DELETE FROM ledger_project_checkouts WHERE project_id = ?").run(second);
    const unavailable = await readRequestReview(db, firstRequest, viewer.userId);
    expect(unavailable.tracked_groups[0]?.documents[0]).toMatchObject({ project_id: second, commit_sha: secondBase, content: null });
  } finally {
    await daemon?.close();
    await queue.dispose();
    db.close();
  }
});
