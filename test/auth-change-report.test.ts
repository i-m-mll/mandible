// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectAuthMergeReview,
} from "../src/auth-change-report.js";
import { AuthQueue } from "../src/auth-queue.js";
import { MERGE_CHANGE_MESSAGE } from "./helpers/auth-delivery-fixtures.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { setDb } from "../src/db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setupOperator } from "../src/users/store.js";
import {
  createLedgerIssue,
  createLedgerProject,
  createMigratedDb,
  registerWorkRepo,
} from "./helpers/auth-queue-fixtures.js";

let tempRoot = "";
let repo = "";

function git(args: string[], cwd = repo): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

function write(file: string, content: string | Buffer): void {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-report-"));
  repo = path.join(tempRoot, "repo");
  fs.mkdirSync(repo);
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Mandible Test"]);
  git(["config", "user.email", "mandible-test@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);

  write(".gitattributes", "generated/** linguist-generated\ngenerated/not-generated.ts linguist-generated=false\nvendor/** linguist-vendored linguist-language=JavaScript\n");
  write("src/app.ts", "export const value = 1;\n");
  write("config/settings.json", "{\"enabled\":true}\n");
  write("docs/old.md", "old documentation\n");
  git(["add", "-A"]);
  git(["commit", "-m", "base"]);

  git(["checkout", "-b", "feature/report"]);
  write("src/app.ts", "export const value = 1;\nexport const next = 2;\nexport const last = 3;\n");
  fs.renameSync(path.join(repo, "config/settings.json"), path.join(repo, "config/renamed.json"));
  fs.rmSync(path.join(repo, "docs/old.md"));
  write("generated/client.ts", "export const generated = true;\n");
  write("generated/not-generated.ts", "export const generated = false;\n");
  write("vendor/library.js", "export const vendored = true;\n");
  write("fixtures/sample.json", "{\"fixture\":true}\n");
  write("assets/image.bin", Buffer.from([0, 1, 2, 0, 255]));
  write("assets/widget.zzz", "unknown format\n");
  write("odd name\tline\n.ts", "export const odd = true;\n");
  fs.symlinkSync("src/app.ts", path.join(repo, "app-link"));

  const nested = path.join(tempRoot, "nested");
  fs.mkdirSync(nested);
  git(["init", "-b", "main"], nested);
  git(["config", "user.name", "Mandible Test"], nested);
  git(["config", "user.email", "mandible-test@example.invalid"], nested);
  git(["config", "commit.gpgsign", "false"], nested);
  fs.writeFileSync(path.join(nested, "README.md"), "nested\n");
  git(["add", "README.md"], nested);
  git(["commit", "-m", "nested"], nested);
  const nestedSha = git(["rev-parse", "HEAD"], nested);

  git(["add", "-A"]);
  git(["update-index", "--add", "--cacheinfo", `160000,${nestedSha},deps/module`]);
  git(["commit", "-m", "mixed report fixture\n\nMandible-Issue: d5edbb9"]);
  git(["checkout", "main"]);
  write("unrelated-after-branch.txt", "this belongs only to main\n");
  git(["add", "-A"]);
  git(["commit", "-m", "advance base independently"]);

  fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".git", "info", "attributes"),
    "assets/image.bin diff\nsrc/app.ts -diff\ngenerated/client.ts linguist-generated=false\n",
  );
  git(["config", "diff.renames", "false"]);
  git(["config", "diff.algorithm", "histogram"]);
  git(["config", "diff.ambient.binary", "true"]);
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function report() {
  const baseSha = git(["rev-parse", "main"]);
  const headSha = git(["rev-parse", "feature/report"]);
  const mergeBaseSha = git(["merge-base", baseSha, headSha]);
  const result = await collectAuthMergeReview(repo, {
    base_sha: baseSha,
    head_sha: headSha,
    merge_base_sha: mergeBaseSha,
  });
  if (!result.ok) throw result.error;
  if (!result.value.report) throw new Error("Expected a report.");
  return result.value;
}

function ambientGitOverrides(): Record<string, string> {
  const globalAttributes = path.join(tempRoot, "ambient.attributes");
  const globalConfig = path.join(tempRoot, "ambient.gitconfig");
  const xdg = path.join(tempRoot, "xdg");
  fs.mkdirSync(path.join(xdg, "git"), { recursive: true });
  fs.writeFileSync(globalAttributes, "assets/image.bin diff\nsrc/app.ts -diff\n");
  fs.writeFileSync(globalConfig, `[core]\n\tattributesFile = ${globalAttributes}\n[diff]\n\trenames = false\n\talgorithm = patience\n`);
  fs.writeFileSync(path.join(xdg, "git", "attributes"), "*.ts -diff linguist-language=AmbientOverride\n");
  return {
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "diff.renames",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "diff.algorithm",
    GIT_CONFIG_VALUE_1: "histogram",
    GIT_CONFIG_PARAMETERS: "'diff.renames=false' 'diff.algorithm=patience'",
    GIT_DIR: path.join(tempRoot, "ambient-git-dir"),
    GIT_COMMON_DIR: path.join(tempRoot, "ambient-common-dir"),
    GIT_OBJECT_DIRECTORY: path.join(tempRoot, "ambient-objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(tempRoot, "ambient-alternates"),
    GIT_WORK_TREE: path.join(tempRoot, "ambient-work-tree"),
    GIT_INDEX_FILE: path.join(tempRoot, "ambient-index"),
  };
}

async function withEnvironment<T>(overrides: Record<string, string>, task: () => Promise<T>): Promise<T> {
  const prior = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return await task();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("auth change reports", () => {
  it("returns a typed collection failure instead of leaking a foreign exception", async () => {
    const captured = (await report()).report!;
    const result = await withEnvironment(
      { PATH: path.join(tempRoot, "no-executables") },
      () => collectAuthMergeReview(repo, captured.comparison),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected collection failure.");
    expect(result.error.kind).toBe("git_failed");
    expect(result.error.message).toMatch(/Unable to locate the repository object store/);
  });

  it("captures one deterministic pinned review despite every ambient Git override", async () => {
    git(["checkout", "feature/report"]);
    write("zzz-large.txt", "x\n".repeat(60_000));
    git(["add", "zzz-large.txt"]);
    git(["commit", "-m", "add large review fixture\n\nMandible-Issue: d5edbb9"]);
    git(["checkout", "main"]);
    const baseline = await report();
    const captured = baseline.report!;
    const hostile = await withEnvironment(
      ambientGitOverrides(),
      () => collectAuthMergeReview(repo, captured.comparison),
    );
    if (!hostile.ok) throw hostile.error;
    expect(JSON.stringify(hostile.value)).toBe(JSON.stringify(baseline));
    expect(hostile.value.diffSummary).toContain("+export const generated = false;");
    expect(hostile.value.diffSummary).not.toContain("AmbientOverride");
    expect(hostile.value.diffSummary).toContain("[truncated: diff preview exceeded 102400 bytes]");
    expect(captured.files.map((file) => file.new_path ?? file.old_path)).not.toContain("unrelated-after-branch.txt");
    expect(captured.totals.files).toBe(captured.files.length);
    expect(captured.totals.additions).toBe(
      captured.files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    );
    expect(captured.totals.deletions).toBe(
      captured.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    );

    expect(captured.files.find((file) => file.new_path === "config/renamed.json")).toMatchObject({
      old_path: "config/settings.json",
      change_kind: "renamed",
      language: "JSON",
      file_role: "configuration",
    });
    expect(captured.files.find((file) => file.new_path === "generated/client.ts")).toMatchObject({
      generated: true,
      vendor: false,
      language: "TypeScript",
      file_role: "implementation",
    });
    expect(captured.files.find((file) => file.new_path === "generated/not-generated.ts")?.generated)
      .toBe(false);
    expect(captured.files.find((file) => file.new_path === "vendor/library.js")).toMatchObject({
      generated: false,
      vendor: true,
      language: "JavaScript",
    });
    expect(captured.files.find((file) => file.new_path === "fixtures/sample.json")?.file_role)
      .toBe("fixtures_data");
    expect(captured.files.find((file) => file.new_path === "assets/widget.zzz")?.language)
      .toBe("Unknown");
    expect(captured.files.find((file) => file.new_path === "odd name\tline\n.ts")?.language)
      .toBe("TypeScript");
    expect(captured.files.find((file) => file.new_path === "assets/image.bin")).toMatchObject({
      additions: null,
      deletions: null,
      bytes_before: null,
      bytes_after: 5,
      file_type_after: "blob",
    });
    expect(captured.files.find((file) => file.new_path === "app-link")).toMatchObject({
      file_type_before: "absent",
      file_type_after: "symlink",
    });
    expect(captured.files.find((file) => file.new_path === "deps/module")).toMatchObject({
      file_type_before: "absent",
      file_type_after: "gitlink",
      additions: null,
      deletions: null,
      bytes_before: null,
      bytes_after: null,
    });
  });

  it("keeps captured reports and their headline counts immutable while prose remains editable", async () => {
    const captured = (await report()).report!;
    const db = createMigratedDb();
    const queue = new AuthQueue({ db, backgroundMaintenance: false });
    try {
      const request = queue.submit({
        type: "merge",
        command: "echo reviewed",
        title: "Reviewed candidate",
        cwd: repo,
        base_branch: "main",
        head_branch: "feature/report",
        merge_head_sha: captured.comparison.head_sha,
        change_report: captured,
        files_changed: captured.totals.files,
        additions: captured.totals.additions,
        deletions: captured.totals.deletions,
      });
      const revised = queue.update(request.id, { title: "Edited prose" });
      expect(revised.change_report).toEqual(captured);
      expect(() => queue.update(request.id, { additions: captured.totals.additions + 1 }))
        .toThrow(/immutable/);
      expect(() => db.prepare("UPDATE auth_requests SET change_report_json = NULL WHERE id = ?").run(request.id))
        .toThrow(/immutable/);
      expect(() => db.prepare("UPDATE auth_requests SET files_changed = files_changed + 1 WHERE id = ?").run(request.id))
        .toThrow(/immutable/);
      expect(() => queue.submit({
        type: "commit",
        command: "echo invalid",
        title: "Non-merge report",
        change_report: captured,
      })).toThrow(/only to merge requests/);
    } finally {
      queue.dispose();
      db.close();
    }
  });

  /** The real authenticated submission route with committed delivery custody for feature/report. */
  function authenticatedRoute() {
    const db = createMigratedDb();
    setDb(db);
    const operator = setupOperator(db, { slug: "report-route", display_name: "Report Route" });
    const secretsDir = path.join(tempRoot, "secrets");
    const authenticator = new ClientAuthenticator(db, { secretsDir });
    const { token, credential } = authenticator.mintApiToken(operator.id);
    const project = createLedgerProject(db, repo);
    registerWorkRepo(db, repo);
    const issue = createLedgerIssue(db, project.project.id, "d5edbb9", "Auth report");
    db.prepare(`INSERT INTO work_units
      (id, issue_id, repo_id, branch, kind, state, created_at, activated_at,
       ledger_issue_id, owner_user_id, owner_credential_id, custody_generation)
      VALUES (?, 'd5edbb9', ?, 'feature/report', 'solo', 'committed', 1, 1, ?, ?, ?, 1)`)
      .run(crypto.randomUUID(), project.project.project_key, issue.id, operator.id, credential.id);
    const queue = new AuthQueue({ db, backgroundMaintenance: false, broadcast: () => {} });
    const router = new Router({ clientAuth: authenticator });
    registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
    const submit = (body: Record<string, unknown>) => router.invoke({
      method: "POST",
      url: "/api/auth/request",
      body: {
        type: "merge",
        command: "mandible auth merge feature/report --into main",
        title: "Capture report",
        cwd: repo,
        repo: project.project.project_key,
        base_branch: "main",
        head_branch: "feature/report",
        issue_references: ["d5edbb9"],
        ...body,
      },
      credential: token,
      transport: "http",
    });
    return { db, queue, router, token, project, submit };
  }

  it("refuses merge requests and supersessions without a change message or verification, or with a spec (issues 4720024, 8ae6b5f)", async () => {
    const { db, queue, router, token, submit } = authenticatedRoute();
    try {
      const { verification: _verification, ...withoutVerification } = MERGE_CHANGE_MESSAGE;
      for (const [body, missing] of [
        [{}, "--message <text> or --message-file <file>"],
        [{ commit_message: MERGE_CHANGE_MESSAGE.commit_message }, "--message <text> or --message-file <file>"],
        [withoutVerification, "--verification <text>"],
      ] as const) {
        const refused = await submit(body);
        expect(refused.status).toBe(400);
        expect(refused.body).toMatchObject({ code: "change_message_required" });
        expect(String((refused.body as { error: string }).error)).toContain(missing);
      }
      const withSpec = await submit({ ...MERGE_CHANGE_MESSAGE, spec_content: "Intent" });
      expect(withSpec.status).toBe(400);
      expect(String((withSpec.body as { error: string }).error)).toContain("spec_content");
      expect(queue.listActive()).toHaveLength(0);

      const accepted = await submit(MERGE_CHANGE_MESSAGE);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
      const refusedSuccessor = await submit({
        supersedes_request_id: (accepted.body as { request_id: string }).request_id,
        expected_revision: 1,
        expected_custody_generation: 1,
      });
      expect(refusedSuccessor.status).toBe(400);
      expect(refusedSuccessor.body).toMatchObject({ code: "change_message_required" });

      const demoted = await router.invoke({
        method: "PUT",
        url: `/api/auth/request/${(accepted.body as { request_id: string }).request_id}`,
        body: { canonical_message: false, expected_revision: 1, expected_custody_generation: 1 },
        credential: token,
        transport: "http",
      });
      expect(demoted.status, JSON.stringify(demoted.body)).toBe(400);
      expect(demoted.body).toMatchObject({ code: "change_message_required" });

      const revisedSpec = await router.invoke({
        method: "PUT",
        url: `/api/auth/request/${(accepted.body as { request_id: string }).request_id}`,
        body: { spec_content: "Intent", expected_revision: 1, expected_custody_generation: 1 },
        credential: token,
        transport: "http",
      });
      expect(revisedSpec.status).toBe(400);
      expect(String((revisedSpec.body as { error: string }).error)).toContain("spec_content");
    } finally {
      queue.dispose();
      db.close();
    }
  });

  // Issue 8ae6b5f — a dirty policy's note says where uncommitted work went.
  it("stores a protected-root stash action on the request and reads it back", async () => {
    const { db, queue, router, token, submit } = authenticatedRoute();
    try {
      const stash = "0123456789abcdef0123456789abcdef01234567";
      const accepted = await submit({
        ...MERGE_CHANGE_MESSAGE,
        protected_root_dirty_action: {
          policy: "stash", action: "stashed", branch: null, worktree: null, stash,
          files: [{ status: " M", path: "notes.md" }, { status: "??", path: "scratch.txt" }],
          message: `Protected-root changes were preserved in stash ${stash} before auth request submission.`,
        },
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
      const id = (accepted.body as { request_id: string }).request_id;
      const detail = await router.invoke({
        method: "GET", url: `/api/auth/request/${id}`, credential: token, transport: "http",
      });
      expect((detail.body as { protected_root_dirty_action: unknown }).protected_root_dirty_action).toEqual({
        policy: "stash", action: "stashed", branch: null, worktree: null, stash,
        files: [{ status: " M", path: "notes.md" }, { status: "??", path: "scratch.txt" }],
        message: `Protected-root changes were preserved in stash ${stash} before auth request submission.`,
      });
      const listed = await router.invoke({ method: "GET", url: "/api/auth/queue", credential: token, transport: "http" });
      expect((listed.body as { requests: Array<{ id: string; protected_root_dirty_action: { stash: string } | null }> })
        .requests.find((row) => row.id === id)?.protected_root_dirty_action?.stash).toBe(stash);
    } finally {
      queue.dispose();
      db.close();
    }
  });

  it("ignores caller-supplied counts and returns the server-captured headline", async () => {
    const { db, queue, router, token, project } = authenticatedRoute();

    try {
      const response = await withEnvironment(ambientGitOverrides(), () => router.invoke({
        method: "POST",
        url: "/api/auth/request",
        body: {
          ...MERGE_CHANGE_MESSAGE,
          type: "merge",
          command: "mandible auth merge feature/report --into main",
          title: "Capture report",
          cwd: repo,
          repo: project.project.project_key,
          base_branch: "main",
          head_branch: "feature/report",
          issue_references: ["d5edbb9"],
          diff_summary: "caller supplied content that must never be stored",
          files_changed: 999,
          additions: 999,
          deletions: 999,
        },
        credential: token,
        transport: "http",
      }));
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const body = response.body as { request_id: string; files_changed: number; additions: number; deletions: number };
      expect(body.files_changed).not.toBe(999);
      const request = queue.getRequest(body.request_id);
      expect(request?.diff_summary).not.toContain("caller supplied content");
      expect(request?.diff_summary).toContain("diff --git a/src/app.ts b/src/app.ts");
      expect(request?.change_report?.totals).toMatchObject({
        files: body.files_changed,
        additions: body.additions,
        deletions: body.deletions,
      });
      expect(request?.merge_head_sha).toBe(request?.change_report?.comparison.head_sha);

      const revised = queue.update(body.request_id, { title: "Prose only" });
      expect(revised.change_report).toEqual(request?.change_report);
      const firstReport = revised.change_report;

      git(["checkout", "feature/report"]);
      write("src/superseding.ts", "export const replacement = true;\n");
      git(["add", "src/superseding.ts"]);
      git(["commit", "-m", "extend candidate\n\nMandible-Issue: d5edbb9"]);
      git(["checkout", "main"]);

      const replacementResponse = await router.invoke({
        method: "POST",
        url: "/api/auth/request",
        body: {
          ...MERGE_CHANGE_MESSAGE,
          type: "merge",
          command: "mandible auth merge feature/report --into main",
          title: "Capture replacement report",
          cwd: repo,
          repo: project.project.project_key,
          base_branch: "main",
          head_branch: "feature/report",
          issue_references: ["d5edbb9"],
          supersedes_request_id: body.request_id,
          expected_revision: 2,
          expected_custody_generation: 1,
          files_changed: 999,
          additions: 999,
          deletions: 999,
        },
        credential: token,
        transport: "http",
      });
      expect(replacementResponse.status, JSON.stringify(replacementResponse.body)).toBe(201);
      const replacementId = (replacementResponse.body as { request_id: string }).request_id;
      const replacement = queue.getRequest(replacementId);
      expect(replacement?.change_report?.comparison.head_sha).not.toBe(firstReport?.comparison.head_sha);
      expect(replacement?.change_report?.files.some((file) => file.new_path === "src/superseding.ts")).toBe(true);
      expect(queue.getRequest(body.request_id)).toMatchObject({
        status: "superseded",
        change_report: firstReport,
      });
    } finally {
      queue.dispose();
      db.close();
    }
  });
});
