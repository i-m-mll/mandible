// @vitest-environment node
/**
 * The read-side auth commands and staged-action guards, as only a spawn shows
 * them: `auth list` matches a repo by any registered alias and prints short
 * ids only; `auth check` frames a stale queue entry as remediation; and every
 * staged-action mutation carries integer CAS guards or never leaves the client.
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

import { fileRpc, runCli, scratchDir, startStubDaemon, type StubHandler } from "./helpers/cli-process.js";

const syntax = createRequire(import.meta.url)("../cli/command-syntax.cjs");

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function daemon(handler: StubHandler) {
  const stub = await startStubDaemon(handler);
  cleanups.push(() => stub.close());
  return stub;
}

describe("auth list", () => {
  it("matches a repo by name or registered path and prints only short request ids", async () => {
    const requests = [
      { id: "11111111-1111-4111-8111-111111111111", status: "pending", repo: "mandible", head_branch: "feature/a", base_branch: "main", title: "A" },
      { id: "22222222-2222-4222-8222-222222222222", status: "pending", repo: "dotfiles", head_branch: "feature/b", base_branch: "main", title: "B" },
    ];
    const stub = await daemon(({ url }) => {
      if (url.startsWith("/api/auth/queue")) return { body: { requests } };
      if (url.startsWith("/api/issues?")) return { body: [{ repo_id: "mandible", repo_name: "mandible", repo_root: "/tmp/registered/mandible", issues: [] }] };
      return undefined;
    });

    const [byPath, human] = await Promise.all([
      runCli(["auth", "list", "--repo", "/tmp/registered/mandible", "--json"], { env: stub.env }),
      runCli(["auth", "list"], { env: stub.env }),
    ]);

    expect(byPath.status, byPath.stderr).toBe(0);
    expect(JSON.parse(byPath.stdout).requests.map((request: { repo: string }) => request.repo)).toEqual(["mandible"]);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain("[11111111] pending mandible feature/a -> main");
    for (const request of requests) expect(human.stdout).not.toContain(request.id);
  });
});

describe("auth check", () => {
  it("keeps a publication-blocked candidate mergeable and names the blocker", async () => {
    const stub = await daemon(({ method, url }) => method === "POST" && url === "/api/auth/check"
      ? {
        body: {
          check: {
            status: "clean", repo: "repo", base_branch: "main", head_branch: "feature/live", checked_requests: 0, conflicts: [],
            publication_blocker: { code: "runtime_handoff_lock", message: "Runtime handoff lock abc is not acknowledged." },
          },
        },
      }
      : undefined);

    const result = await runCli(["auth", "check", "--repo", "repo", "--branch", "feature/live"], { cwd: scratchDir("auth-check-blocked"), env: stub.env });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Auth check: clean");
    expect(result.stdout).toContain("Publication blocked: Runtime handoff lock abc is not acknowledged.");
  });

  it("renders a stale queue request as remediation, not a conflict (fbf2a58)", async () => {
    const stub = await daemon(({ method, url }) => method === "POST" && url === "/api/auth/check"
      ? {
        body: {
          check: {
            status: "stale_request", repo: "repo", base_branch: "main", head_branch: "feature/live", checked_requests: 0, conflicts: [],
            stale_requests: [{
              request_id: "1504906a-dead-beef",
              head_branch: "feature/gone",
              message: "Queued auth request 1504906a-dead-beef references head branch 'feature/gone', which no longer exists.",
            }],
            reason: "1 queued request(s) reference a head branch that no longer exists.",
          },
        },
      }
      : undefined);

    const result = await runCli(["auth", "check", "--repo", "repo", "--branch", "feature/live"], { cwd: scratchDir("auth-check"), env: stub.env });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stale queue request");
    expect(result.stderr).toContain("1504906a-dead-beef");
    expect(result.stderr).toContain("Remediation");
    expect(result.stderr).not.toContain("Auth check: conflict");
    expect(result.stderr.toLowerCase()).not.toContain("dirty");
  });
});

describe("auth action", () => {
  const forms: Record<string, string[]> = {
    add: ["req1", "--kind", "comment_add", "--issue", "abc", "--body", "Hello"],
    edit: ["req1", "act1", "--kind", "label_add", "--issue", "abc", "--label", "ready"],
    rm: ["req1", "act1"],
  };

  it("sends the CAS guards as integers and refuses a missing or invalid guard before transport", async () => {
    const { env, responder } = fileRpc(() => ({ status: 200, body: { action: { id: "act1" }, action_id: "act1", deleted: true } }));
    cleanups.push(() => responder.stop());

    for (const [subcommand, args] of Object.entries(forms)) {
      for (const flag of ["--expected-revision", "--expected-custody-generation"]) {
        const other = flag === "--expected-revision" ? "--expected-custody-generation" : "--expected-revision";
        for (const invalid of [undefined, "-1", "1.5", "wrong", "9007199254740992"]) {
          const argv = ["auth", "action", subcommand, ...args, other, "2", ...(invalid === undefined ? [] : [flag, invalid])];
          expect(() => syntax.parse(argv), argv.join(" ")).toThrow();
        }
      }
    }
    const refused = await Promise.all(Object.entries(forms).map(([subcommand, args]) =>
      runCli(["auth", "action", subcommand, ...args, "--expected-custody-generation", "2"], { env })));
    for (const result of refused) {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain("--expected-revision");
    }
    expect(responder.requests).toEqual([]);

    const sent = await Promise.all(Object.entries(forms).map(([subcommand, args]) =>
      runCli(["auth", "action", subcommand, ...args, "--expected-revision", "4", "--expected-custody-generation", "3"], { env })));

    for (const result of sent) expect(result.status, result.stderr).toBe(0);
    expect(responder.requests.map((request) => request.body)).toEqual(Object.keys(forms).map(() =>
      expect.objectContaining({ expected_revision: 4, expected_custody_generation: 3 })));
  });
});
