import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startFileRpcResponder,
  type FileRpcHandler,
  type FileRpcRequest,
} from "../helpers/file-rpc-responder.js";

const CLI = path.join(process.cwd(), "bin", "mandible");

let spoolDir = "";

interface RpcResult {
  status: number | null;
  stdout: string;
  stderr: string;
  seen: FileRpcRequest[];
}

/**
 * Run the CLI against an in-process file-RPC responder. `handler` receives each
 * request and returns the `{status, body}` the daemon would. The CLI never
 * touches a live daemon — `MANDIBLE_BASE=file://<spool>` routes through the
 * file-RPC transport in cli/api.sh.
 */
function runWithResponder(
  args: string[],
  handler: FileRpcHandler,
): Promise<RpcResult> {
  const responder = startFileRpcResponder(spoolDir, handler);
  const seen = responder.requests;

  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      env: {
        ...process.env,
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
        MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      responder.stop();
      resolve({ status, stdout, stderr, seen });
    });
  });
}

function runOffline(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(CLI, args, {
    encoding: "utf8",
    env: { ...process.env, MANDIBLE_PORT: "9" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
  spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-project-cli-"));
});

afterEach(() => {
  fs.rmSync(spoolDir, { recursive: true, force: true });
});

describe("project CLI surface", () => {
  it("is wired into the top-level mandible dispatch", () => {
    const help = runOffline(["help"]);
    expect(help.stdout).toContain("mandible project list");
  });

  it("documents the project command surface", () => {
    const result = runOffline(["project", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mandible project list");
    expect(result.stdout).toContain("mandible project show");
    expect(result.stdout).toContain("mandible project add");
    expect(result.stdout).toContain("mandible project audit");
    expect(result.stdout).toContain("mandible project repair");
  });

  it("rejects an unknown project subcommand", () => {
    const result = runOffline(["project", "bogus-sub"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown project subcommand");
  });
});

describe("project CLI read round-trips", () => {
  it("lists projects via GET /api/projects and prints a row per project", async () => {
    const result = await runWithResponder(
      ["project", "list"],
      (req) => {
        expect(req.method).toBe("GET");
        expect(req.path).toBe("/api/projects");
        return {
          status: 200,
          body: {
            projects: [
              {
                project_key: "feedbax",
                display_name: "Feedbax",
                remote_identity: "git@github.com:mll/feedbax.git",
                open_issue_count: 3,
                closed_issue_count: 2,
                issue_count: 5,
                checkouts: [],
              },
            ],
          },
        };
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("feedbax");
    expect(result.stdout).toContain("5 issues");
  });

  it("shows a project via GET /api/projects/:ref and prints key and display name", async () => {
    const result = await runWithResponder(
      ["project", "show", "feedbax"],
      (req) => {
        expect(req.method).toBe("GET");
        expect(req.path).toBe("/api/projects/feedbax");
        return {
          status: 200,
          body: {
            project: {
              project_key: "feedbax",
              display_name: "Feedbax",
              remote_identity: "git@github.com:mll/feedbax.git",
              namespace_policy: "remote",
              open_issue_count: 3,
              closed_issue_count: 2,
              issue_count: 5,
              checkouts: [{ id: "co-1", root: "/home/mll/feedbax", work_repo_id: "repo-1" }],
            },
            matched_by: "project_key",
          },
        };
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("feedbax");
    expect(result.stdout).toContain("Feedbax");
  });

  it("prints suggestions from a 404 response to stderr and exits non-zero", async () => {
    const result = await runWithResponder(
      ["project", "show", "missing"],
      (req) => {
        expect(req.path).toBe("/api/projects/missing");
        return {
          status: 404,
          body: { error: "project not found", suggestions: ["feedbax"] },
        };
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("feedbax");
    expect(result.seen).toHaveLength(1);
  });
});

describe("project CLI write round-trips", () => {
  it("creates a project via POST /api/projects with key, display, and remote", async () => {
    const result = await runWithResponder(
      [
        "project",
        "add",
        "--key",
        "feedbax",
        "--display",
        "Feedbax",
        "--remote",
        "git@github.com:mll/feedbax.git",
      ],
      (req) => {
        expect(req.method).toBe("POST");
        expect(req.path).toBe("/api/projects");
        expect(req.body).toMatchObject({ key: "feedbax" });
        return {
          status: 201,
          body: {
            project: {
              project_key: "feedbax",
              display_name: "Feedbax",
              remote_identity: "git@github.com:mll/feedbax.git",
            },
          },
        };
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("feedbax");
  });

  it("creates a project and registers first checkout when --root is given", async () => {
    const result = await runWithResponder(
      ["project", "add", "--key", "x", "--root", "/tmp/x"],
      (req) => {
        if (req.path === "/api/projects") {
          expect(req.method).toBe("POST");
          expect(req.body).toMatchObject({ key: "x" });
          return { status: 201, body: { project: { project_key: "x" } } };
        }
        if (req.path === "/api/projects/x/checkouts") {
          expect(req.method).toBe("POST");
          expect(req.body).toMatchObject({ root: "/tmp/x" });
          return {
            status: 201,
            body: { project: { project_key: "x" }, checkout: { root: "/tmp/x" } },
          };
        }
        return { status: 500, body: { error: "unexpected request" } };
      },
    );
    expect(result.status).toBe(0);
    expect(result.seen).toHaveLength(2);
    expect(result.seen[0].path).toBe("/api/projects");
    expect(result.seen[1].path).toBe("/api/projects/x/checkouts");
  });

  it("updates a project via PATCH /api/projects/:ref", async () => {
    const result = await runWithResponder(
      ["project", "update", "feedbax", "--display", "Feedbax Lab", "--namespace", "upstream"],
      (req) => {
        expect(req.method).toBe("PATCH");
        expect(req.path).toBe("/api/projects/feedbax");
        expect(req.body).toMatchObject({ display: "Feedbax Lab", namespace: "upstream" });
        return {
          status: 200,
          body: { project: { project_key: "feedbax", display_name: "Feedbax Lab" } },
        };
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("updated feedbax");
  });

  it("adds a checkout via POST /api/projects/:ref/checkouts", async () => {
    const result = await runWithResponder(
      [
        "project",
        "add-checkout",
        "feedbax",
        "--root",
        "/tmp/feedbax",
        "--work-repo-id",
        "feedbax",
        "--default-branch",
        "main",
      ],
      (req) => {
        expect(req.method).toBe("POST");
        expect(req.path).toBe("/api/projects/feedbax/checkouts");
        expect(req.body).toMatchObject({
          root: "/tmp/feedbax",
          work_repo_id: "feedbax",
          default_branch: "main",
        });
        return {
          status: 201,
          body: {
            project: { project_key: "feedbax" },
            checkout: { root: "/tmp/feedbax" },
          },
        };
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("added checkout /tmp/feedbax to feedbax");
  });

  it("updates a checkout via POST /api/projects/checkouts", async () => {
    const result = await runWithResponder(
      [
        "project",
        "update-checkout",
        "--root",
        "/tmp/feedbax",
        "--project",
        "feedbax",
        "--work-repo-id",
        "feedbax",
      ],
      (req) => {
        expect(req.method).toBe("POST");
        expect(req.path).toBe("/api/projects/checkouts");
        expect(req.body).toMatchObject({
          root: "/tmp/feedbax",
          project: "feedbax",
          work_repo_id: "feedbax",
        });
        return {
          status: 200,
          body: {
            project: { project_key: "feedbax" },
            checkout: { root: "/tmp/feedbax" },
          },
        };
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("updated checkout /tmp/feedbax in feedbax");
  });

  it("fetches the audit report via GET /api/projects/audit", async () => {
    const result = await runWithResponder(
      ["project", "audit"],
      (req) => {
        expect(req.method).toBe("GET");
        expect(req.path).toBe("/api/projects/audit");
        return {
          status: 200,
          body: {
            audit: {
              duplicate_display_names: [],
              local_projects: [],
              numbered_repo_ids: [
                { project_key: "widgets", work_repo_id: "20-widgets-widgets", root: "/x" },
              ],
              ambiguous_roots: [],
              missing_keys: [],
              mergeable_local_projects: [],
              unmergeable_local_projects: [],
            },
          },
        };
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("numbered_repo_ids: 1");
  });

  it("repair --merge sends POST /api/projects/repair with merge object and apply false", async () => {
    const result = await runWithResponder(
      ["project", "repair", "--merge", "a", "b"],
      (req) => {
        expect(req.method).toBe("POST");
        expect(req.path).toBe("/api/projects/repair");
        expect(req.body).toMatchObject({ apply: false, merge: { source: "a", target: "b" } });
        return {
          status: 200,
          body: { report: { keys_backfilled: 0, applied: false } },
        };
      },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry run");
  });

  it("repair --apply sends POST /api/projects/repair with apply true", async () => {
    const result = await runWithResponder(
      ["project", "repair", "--apply"],
      (req) => {
        expect(req.method).toBe("POST");
        expect(req.path).toBe("/api/projects/repair");
        expect(req.body).toMatchObject({ apply: true });
        return {
          status: 200,
          body: { report: { keys_backfilled: 1, applied: true } },
        };
      },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("applied: yes");
  });
});

describe("issue new --project integration", () => {
  it("routes issue creation to /api/issues/<project-ref> and includes project in body", async () => {
    const result = await runWithResponder(
      ["issue", "new", "-t", "Test title", "-m", "Test body", "--kind", "feature", "--project", "feedbax"],
      (req) => {
        expect(req.method).toBe("POST");
        expect(req.path).toBe("/api/issues/feedbax");
        expect(req.body).toMatchObject({ project: "feedbax", kind: "feature" });
        return { status: 201, body: { id: "abc123", display_id: "abc123" } };
      },
    );
    expect(result.status).toBe(0);
    expect(result.seen).toHaveLength(1);
    expect(result.seen[0].path).toBe("/api/issues/feedbax");
  });
});
