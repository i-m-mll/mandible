// @vitest-environment node
/**
 * What only a real `mandible issue` spawn proves. Argument parsing, help and
 * instructions are the grammar's (command-instructions); the route each call
 * reaches is cli-route-coverage's. Here: exit-code contracts, refusal shapes,
 * the classification the CLI computes itself, cwd inference, and the file-URL
 * transport.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { fileRpc, runCli, scratchDir, startStubDaemon, type StubDaemon, type StubHandler } from "./helpers/cli-process.js";
import type { FileRpcResponder } from "./helpers/file-rpc-responder.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function daemon(handler: StubHandler): Promise<StubDaemon> {
  const stub = await startStubDaemon(handler);
  cleanups.push(() => stub.close());
  return stub;
}

function spool(handler: Parameters<typeof fileRpc>[0], dir?: string): { env: Record<string, string>; responder: FileRpcResponder } {
  const stub = fileRpc(handler, dir);
  cleanups.push(() => stub.responder.stop());
  return stub;
}

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
}

function head(shortId: string, digest: string, subtreeDigest: string, at = 1_700_000_000_000) {
  return {
    issue_id: `issue-${shortId}`, short_id: shortId, digest, subtree_digest: subtreeDigest,
    last_event_at: at, last_event_kind: "comment.created", subtree_last_event_at: at, subtree_last_event_kind: "comment.created",
  };
}

function checkpoint(id: string, createdAt: number, payload: unknown[]) {
  return { id, kind: "delegation-manifest", payload, author: { id: null, type: "mandible_user", display: "Mandible" }, source: "mandible", created_at: createdAt };
}

const issuesOf = (entries: Array<{ issue: string }>) => entries.map((entry) => entry.issue).sort();

/** Heads keyed by `<ref>` or `<ref>?<query>`; checkpoints newest first. */
function ledgerStub(heads: Record<string, unknown>, checkpoints: Record<string, ReturnType<typeof checkpoint>[]>): StubHandler {
  return ({ method, url, body }) => {
    const headMatch = url.match(/^\/api\/ledger\/issues\/([^/?]+)\/head(?:\?(.*))?$/);
    if (headMatch) {
      const found = heads[`${headMatch[1]}?${headMatch[2]}`] ?? heads[headMatch[1]];
      return found ? { body: found } : undefined;
    }
    const checkpointMatch = url.match(/^\/api\/ledger\/issues\/([^/?]+)\/checkpoints(?:\?(.*))?$/);
    if (!checkpointMatch) return undefined;
    if (method === "POST") return { body: { ...checkpoint("checkpoint-new", 1_700_000_090_000, []), ...(body as object) } };
    const query = new URLSearchParams(checkpointMatch[2] ?? "");
    const list = checkpoints[checkpointMatch[1]] ?? [];
    const found = query.get("id") ? list.find((entry) => entry.id === query.get("id")) : list[0];
    return found ? { body: found } : undefined;
  };
}

describe("issue CLI", () => {
  it("prints umbrella status through file RPC", async () => {
    const { env, responder } = spool(() => ({
      status: 200,
      body: { umbrella: { short_id: "abc", status: "open" }, delegation_manifest: null, children: [], auth_queue: { pending_requests: [] } },
    }));

    const result = await runCli(["umbrella", "status", "abc", "--json"], { env });

    expect(result.status, result.stderr).toBe(0);
    expect(responder.requests[0]).toMatchObject({ method: "GET", path: "/api/ledger/issues/abc/umbrella-status" });
    expect(JSON.parse(result.stdout).umbrella.short_id).toBe("abc");
  });

  it("refuses parent-role assumption by naming a live holder, reports other refusals as themselves, and takes the caller's own session", async () => {
    const stub = await daemon(({ method, url, body }) => {
      if (method !== "POST") return undefined;
      if (url === "/api/ledger/issues/closed/parent-role") {
        // Issue 7a97e2c: a 409 without a holder once printed the phantom holder `- (-)`.
        return { status: 409, body: { error: "parent role cannot be recorded while the umbrella is closed" } };
      }
      if (url === "/api/ledger/issues/unknown-session/parent-role") {
        return { status: 400, body: { error: 'unknown session id "sess-ghost": link it first with `mandible session link-issue sess-ghost`' } };
      }
      if (url !== "/api/ledger/issues/abc/parent-role") return undefined;
      if ((body as { override?: boolean }).override !== true) {
        return {
          status: 409,
          body: {
            error: "parent role is held by a live session",
            blocking_holder: { session_id: "sess-live", mechanism: "codex", liveness: { state: "live", provider: "claude" } },
          },
        };
      }
      return { body: { ok: true, checkpoint: { id: "checkpoint-parent", kind: "parent-role" } } };
    });
    const assume = (ref: string, ...rest: string[]) => runCli(["issue", "parent-role", "assume", ref, ...rest], { env: stub.env });

    const [held, heldJson, closed, ghost, missing] = await Promise.all([
      assume("abc", "--session", "sess-new"),
      assume("abc", "--session", "sess-new", "--json"),
      assume("closed", "--session", "sess-new"),
      assume("unknown-session", "--session", "sess-ghost"),
      assume("abc"),
    ]);

    expect(held.status).toBe(3);
    expect(held.stderr).toContain("parent role held by sess-live (claude): parent role is held by a live session");
    expect(heldJson.status).toBe(3);
    expect(JSON.parse(heldJson.stdout).blocking_holder.session_id).toBe("sess-live");
    expect(closed.status).toBe(1);
    expect(closed.stderr).not.toContain("parent role held by");
    expect(closed.stderr).toContain("parent role cannot be recorded while the umbrella is closed");
    expect(ghost.status).toBe(1);
    expect(ghost.stderr).toContain('unknown session id "sess-ghost"');
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("Missing parent-role session id");

    const assumed = await runCli(["issue", "parent-role", "assume", "abc", "--override", "--json"], {
      env: { ...stub.env, MANDIBLE_SESSION_ID: "sess-env", CLAUDE_CODE_SESSION_ID: "claude-session" },
    });
    expect(assumed.status, assumed.stderr).toBe(0);
    expect(JSON.parse(assumed.stdout).checkpoint.id).toBe("checkpoint-parent");
    expect(stub.requests.at(-1)?.body).toEqual({ session_id: "claude-session", override: true });
  });

  it("requires a concrete kind and exits non-zero with the server's singleton refusal", async () => {
    const message = "cannot create another open maintenance issue: this project already has one: b4e2937";
    const { env, responder } = spool(() => ({ status: 409, body: { error: message, code: "singleton_kind_open" } }));

    const [kindless, singleton] = await Promise.all([
      runCli(["issue", "new", "-t", "Experiment", "-m", "Body"], { env }),
      runCli(["issue", "new", "-t", "Repo maintenance", "-m", "Body", "--kind", "maintenance", "--project", "mandible"], { env }),
    ]);

    expect(kindless.status).toBe(2);
    expect(kindless.stderr).toContain("--kind");
    expect(singleton.status).toBe(1);
    expect(singleton.stderr).toContain(message);
    expect(singleton.stderr).not.toContain("Created issue");
    expect(responder.requests).toHaveLength(1);
  });

  it("reads through a file-URL base and keeps a POST's response when the spool turns read-only", async () => {
    const report = spool(() => ({ status: 200, body: { display_id: "abc", worker_status: "done", comments: [] } }));
    // Removing the response file fails once the spool is read-only; the POST still succeeded.
    const postDir = scratchDir("spool");
    const post = fileRpc(() => ({ status: 200, body: { id: "comment-3" } }), postDir, { afterResponse: () => fs.chmodSync(postDir, 0o555) });
    cleanups.push(() => { post.responder.stop(); fs.chmodSync(postDir, 0o755); });

    const [reported, posted] = await Promise.all([
      runCli(["issue", "report", "abc", "--json"], { env: report.env }),
      runCli(["-c", [
        "set -euo pipefail",
        `source ${JSON.stringify(path.join(process.cwd(), "cli", "api.sh"))}`,
        "tmp_response=$(mktemp)",
        `status=$(api_send_capture POST /api/ledger/issues/abc/comments '{"message":"New comment"}' "$tmp_response")`,
        "printf '%s\\n' \"$status\"",
        "cat \"$tmp_response\"",
      ].join("\n")], { command: "bash", env: post.env }),
    ]);

    expect(reported.status, reported.stderr).toBe(0);
    expect(report.responder.requests).toMatchObject([{ method: "GET", path: "/api/ledger/issues/abc" }]);
    expect(JSON.parse(reported.stdout)).toMatchObject({ display_id: "abc", worker_status: "done" });
    expect(posted.status, posted.stderr).toBe(0);
    expect(posted.stdout).toBe("200\n{\"id\":\"comment-3\"}\n");
  });

  it("sends label and triage filters through jq 1.6-safe keys", async () => {
    const label = spool(() => ({ status: 200, body: { ok: true } }));
    const triage = spool(() => ({
      status: 200,
      body: [{
        repo_name: "mandible",
        issues: [
          { id: "abc", status: "open", kind: "tracker", priority: "high", resolution: "delivered", title: "Kept", updated_at: "2026-06-12T12:00:00.000Z", labels: ["feature"] },
          { id: "def", status: "open", kind: "maintenance", priority: "normal", title: "Filtered", updated_at: "2026-06-12T12:00:00.000Z", labels: ["maintenance"] },
        ],
      }],
    }));

    const [removed, triaged] = await Promise.all([
      runCli(["issue", "label", "rm", "abc", "deferred"], { env: label.env }),
      runCli(["issue", "triage", "--repo", "/repo/mandible", "--kind", "tracker", "--priority", "high", "--resolution", "delivered", "--label", "feature", "--json"], { env: triage.env }),
    ]);

    expect(removed.status, removed.stderr).toBe(0);
    expect(label.responder.requests).toMatchObject([{ method: "POST", path: "/api/ledger/issues/abc/labels", body: { label: "deferred", present: false } }]);
    expect(triaged.status, triaged.stderr).toBe(0);
    expect(triaged.stderr).not.toContain("jq:");
    expect(JSON.parse(triaged.stdout)).toEqual([expect.objectContaining({ id: "abc" })]);
    expect(new URL(`http://x${triage.responder.requests[0].path}`).searchParams.get("repo")).toBe("/repo/mandible");
  });

  it("classifies a delegation manifest into changed, subtree_changed, unchanged, unknown, and missing", async () => {
    const stub = await daemon(ledgerStub({
      abc: head("abc", "digest-abc", "subtree-abc"),
      def: head("def", "digest-def", "subtree-def"),
      ghi: head("ghi", "digest-ghi", "subtree-ghi-now"),
    }, {}));
    const manifest = path.join(scratchDir("manifest"), "manifest.json");
    fs.writeFileSync(manifest, JSON.stringify([
      { issue: "abc", digest: "digest-abc", subtree_digest: "subtree-abc" },
      { issue: "def", digest: "digest-def-stale", subtree_digest: "subtree-def" },
      { issue: "ghi", digest: "digest-ghi", subtree_digest: "subtree-ghi-then" },
      { issue: "abc", digest: "digest-abc" },
      { issue: "missing", digest: "digest-missing" },
    ]));

    const result = await runCli(["issue", "changed", "--since-manifest", manifest, "--json"], { env: stub.env });

    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(issuesOf(body.unchanged)).toEqual(["abc"]);
    expect(issuesOf(body.changed)).toEqual(["def"]);
    expect(body.subtree_changed).toMatchObject([{ issue: "ghi", expected_subtree_digest: "subtree-ghi-then", current_subtree_digest: "subtree-ghi-now" }]);
    expect(body.unknown).toMatchObject([{ issue: "abc", subtree_state: "unknown" }]);
    expect(issuesOf(body.missing)).toEqual(["missing"]);
  });

  it("classifies the umbrella itself against its checkpoint's stored self baseline, never an inferred one", async () => {
    const T1 = 1_700_000_010_000;
    const T2 = 1_700_000_020_000;
    const child = { issue: "def", digest: "digest-def", subtree_digest: "subtree-def" };
    const stub = await daemon(ledgerStub({
      def: head("def", "digest-def", "subtree-def"),
      // Without a `self: true` entry the baseline is unknown, even though the
      // checkpoint-time reconstruction matches and children carry subtree digests.
      legacy: head("legacy", "digest-legacy", "subtree-legacy"),
      // The current head includes the checkpoint event itself; only the head
      // excluding that exact checkpoint compares against the stored baseline.
      stored: head("stored", "digest-stored-with-checkpoint", "subtree-stored-with-checkpoint"),
      "stored?exclude_checkpoint=checkpoint-stored": head("stored", "digest-stored", "subtree-stored-drifted"),
      pinned: head("pinned", "digest-pinned-new", "subtree-pinned-new", T2),
      [`pinned?at=${T1}`]: head("pinned", "digest-pinned-old", "subtree-pinned-old", T1),
    }, {
      legacy: [checkpoint("checkpoint-legacy", T2, [child])],
      stored: [checkpoint("checkpoint-stored", T2, [
        { issue_id: "issue-stored", short_id: "stored", digest: "digest-stored", subtree_digest: "subtree-stored-at-checkpoint", self: true },
        child,
      ])],
      pinned: [checkpoint("checkpoint-pinned-new", T2, [child]), checkpoint("checkpoint-pinned-old", T1, [child])],
    }));
    const changed = async (...args: string[]) => {
      const result = await runCli(["issue", "changed", "--since-issue", ...args, "--json"], { env: stub.env });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };

    const [legacy, stored, pinned] = await Promise.all([
      changed("legacy"),
      changed("stored"),
      changed("pinned", "--checkpoint", "checkpoint-pinned-old"),
    ]);

    expect(issuesOf(legacy.unknown)).toEqual(["legacy"]);
    expect(issuesOf(legacy.unchanged)).toEqual(["def"]);
    expect(stored.subtree_changed).toMatchObject([{ issue: "stored", expected_subtree_digest: "subtree-stored-at-checkpoint", current_subtree_digest: "subtree-stored-drifted" }]);
    expect(stored.changed).toEqual([]);
    expect(issuesOf(pinned.changed)).toEqual(["pinned"]);
    expect(issuesOf(pinned.unchanged)).toEqual(["def"]);
  });

  it("adds checkpoints from a file or stdin and shows the latest", async () => {
    const stub = await daemon(ledgerStub({}, { abc: [checkpoint("checkpoint-1", 1, [{ issue: "abc", digest: "d" }])] }));
    const payloadFile = path.join(scratchDir("checkpoint"), "payload.json");
    fs.writeFileSync(payloadFile, JSON.stringify([{ issue: "abc", digest: "digest-file" }]));

    const [fromFile, fromStdin, shown] = await Promise.all([
      runCli(["issue", "checkpoint", "add", "abc", "--kind", "delegation-manifest", "--payload-file", payloadFile], { env: stub.env }),
      runCli(["issue", "checkpoint", "add", "abc", "--kind", "closeout", "--payload", "-"], { env: stub.env, input: '{"worker_status":"done"}' }),
      runCli(["issue", "checkpoint", "show", "abc", "--kind", "delegation-manifest", "--json"], { env: stub.env }),
    ]);

    for (const result of [fromFile, fromStdin, shown]) expect(result.status, result.stderr).toBe(0);
    const posted = stub.requests.filter((request) => request.method === "POST").map((request) => request.body);
    expect(posted).toEqual(expect.arrayContaining([
      { kind: "delegation-manifest", payload: [{ issue: "abc", digest: "digest-file" }] },
      { kind: "closeout", payload: { worker_status: "done" } },
    ]));
    expect(JSON.parse(shown.stdout)).toMatchObject({ id: "checkpoint-1", payload: [{ issue: "abc", digest: "d" }] });
  });

  it("scopes issue list to the main checkout of a linked worktree and fails loudly outside a registered repo", async () => {
    const root = scratchDir("repo");
    const repoRoot = path.join(root, "mandible");
    const worktreeRoot = path.join(root, "worktrees", "feature__demo");
    fs.mkdirSync(repoRoot);
    git(["init", "-q", "-b", "main"], repoRoot);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "base"], repoRoot);
    git(["worktree", "add", "-q", "-b", "feature/demo", worktreeRoot], repoRoot);
    const stub = await daemon(({ url }) => url.startsWith("/api/issues?")
      ? { body: [{ repo_name: "mandible", issues: [{ id: "abc", status: "open", title: "Worktree issue" }] }] }
      : undefined);
    const empty = spool(() => ({ status: 200, body: [] }));

    const [listed, unscoped] = await Promise.all([
      runCli(["issue", "list", "--status", "open"], { cwd: worktreeRoot, env: stub.env }),
      runCli(["issue", "list"], { cwd: root, env: empty.env }),
    ]);

    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("abc\topen\tmandible\tWorktree issue");
    const queries = stub.requests.filter((request) => request.url.startsWith("/api/issues?"))
      .map((request) => new URL(`http://x${request.url}`).searchParams);
    expect(queries.find((query) => query.get("status") === "open")?.get("repo")).toBe(fs.realpathSync(repoRoot));
    expect(unscoped.status).toBe(1);
    expect(unscoped.stderr).toContain("cwd does not resolve to a registered repo; pass --repo <path|id>");
  });

  it("exits 3 on a stale comment-edit base and sends the edit as PATCH through file RPC", async () => {
    const stub = await daemon(({ method }) => method === "PATCH"
      ? { status: 409, body: { error: "body revision conflict: base does not match current" } }
      : undefined);
    const { env, responder } = spool((request) => ({ status: 200, body: { id: "issue-1", display_id: "abc", comments: [request.body] } }));

    const [stale, viaSpool] = await Promise.all([
      runCli(["issue", "comment", "edit", "abc#2", "-m", "Stale", "--base-revision", "rev-old"], { env: stub.env }),
      runCli(["issue", "comment", "edit", "raw-comment-id", "-m", "File RPC edit"], { env }),
    ]);

    expect(stale.status).toBe(3);
    expect(stale.stderr).toContain("stale base conflict");
    expect(stale.stderr).toContain("body revision conflict");
    expect(viaSpool.status, viaSpool.stderr).toBe(0);
    expect(responder.requests).toMatchObject([{ method: "PATCH", path: "/api/ledger/comments/raw-comment-id" }]);
  });

  it("prints a missing project's suggestions to stderr and exits non-zero", async () => {
    const { env } = spool(() => ({ status: 404, body: { error: "project not found", suggestions: ["feedbax"] } }));

    const result = await runCli(["project", "show", "missing"], { env });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("feedbax");
  });
});
