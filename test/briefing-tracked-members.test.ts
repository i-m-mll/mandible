import { expect, it } from "vitest";
import { computeAuthMergeReviewMetadata } from "../src/auth-context.js";
import { AuthQueue } from "../src/auth-queue.js";
import { createBriefingBundle, replaceBriefingBundleLayout } from "../src/feedback/briefing-bundles.js";
import { configureBriefingGroup, createBriefingGroup, readBriefingGroup } from "../src/feedback/briefing-groups.js";
import { publishBriefingFromArtifactVersion } from "../src/feedback/briefings.js";
import { convertTrackedBriefingGroup, planTrackedBriefingGroupConversion } from "../src/feedback/convert-tracked-briefing-group.js";
import { readRequestReview } from "../src/feedback/request-review.js";
import { addOrUpdateCheckout, addProject } from "../src/ledger/project-registry.js";
import { getOperatorId } from "../src/users/store.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import {
  AUTH_MERGE_REVIEW, createAuthCheckRepo, createMigratedDb, createNoopHookManager, git, registerWorkRepo, writeFile,
} from "./helpers/auth-queue-fixtures.js";

it("qualifies tracked paths by project and keeps reviewed pins and custody history across conversion", async () => {
  const db = createMigratedDb();
  const queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
  const viewer = { userId: getOperatorId(db)!, operator: true };
  const firstRepo = createAuthCheckRepo();
  const secondRepo = createAuthCheckRepo();
  const commit = (repo: string, subject: string) => {
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", subject]);
    return git(repo, ["rev-parse", "HEAD"]);
  };
  const register = (project_key: string, root: string) => {
    registerWorkRepo(db, root);
    const project = addProject(db, { project_key });
    addOrUpdateCheckout(db, project.id, { root, default_branch: "main" });
    return project.id;
  };
  const first = register("first-project", firstRepo);
  const second = register("second-project", secondRepo);
  const source = "Text copied from the former source.\n";
  try {
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
    const beforePlan = db.prepare("SELECT total_changes() AS writes").get();
    const plan = planTrackedBriefingGroupConversion(db, group.id);
    expect(plan).toMatchObject({ pending_proposal_ids: [pending.id], members: [
      { kind: "track", old_path: "legacy.md", path: "current.md", evidence: "recorded_rename" },
    ] });
    expect(() => convertTrackedBriefingGroup(db, group.id, current.id)).toThrow(/decide all custody proposals/i);
    expect(db.prepare("SELECT total_changes() AS writes").get()).toEqual(beforePlan);
    const dismissal = configureBriefingGroup(db, group.id, { currentBundleRef: current.id, bundleRefs: [] }, viewer).group.history[0]!;
    const conversion = convertTrackedBriefingGroup(db, group.id, current.id);
    const converted = readBriefingGroup(db, group.id, viewer);
    expect(converted.history[0]).toMatchObject({ id: dismissal.id, prior_base: { id: current.id } });
    expect(converted.current?.id).toBe(conversion.bundle_id);
    expect(converted.current?.layout[1]).toMatchObject({ kind: "subgroup", members: [
      { kind: "tracked", tracked: { path: "renamed.md", content: null } },
      { kind: "tracked", tracked: { path: "current.md", content: "Existing custody file.\n" } },
      { kind: "tracked", tracked: { path: "shared.md", commit_sha: firstBase, content: "First project text.\n" } },
      { kind: "tracked", tracked: { path: "copy.md", content: null } },
      { kind: "tracked", tracked: { path: "source.md" } },
    ] });
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
        base_branch: "main", head_branch: "feature/review", merge_head_sha, change_report: changeReport }, viewer.userId);
    };
    const firstRequest = await submit("first-project", firstRepo, firstHead);
    const secondRequest = await submit("second-project", secondRepo, secondHead, [firstRequest.id]);
    const entries = readBriefingGroup(db, group.id, viewer).tracked_proposals;
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
  } finally {
    await queue.dispose();
    db.close();
  }
});
