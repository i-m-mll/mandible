import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");

let tempDir = "";
let tempRoots: string[] = [];

function run(
  args: string[],
  cwd = tempDir,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(CLI, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MANDIBLE_PORT: "9", ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAsync(
  args: string[],
  cwd = tempDir,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd,
      env: { ...process.env, MANDIBLE_PORT: "9", ...extraEnv },
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
      resolve({ status, stdout, stderr });
    });
  });
}

function startFileRpcResponder(
  spoolDir: string,
  handler: (request: Record<string, unknown>) => { status: number; body: unknown },
): NodeJS.Timeout {
  fs.mkdirSync(spoolDir, { recursive: true });
  const timer = setInterval(() => {
    for (const file of fs.readdirSync(spoolDir)) {
      if (!file.endsWith(".request.json")) continue;
      const requestPath = path.join(spoolDir, file);
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as Record<string, unknown>;
      const id = typeof request.id === "string" ? request.id : file.replace(/\.request\.json$/, "");
      const response = handler(request);
      fs.writeFileSync(
        path.join(spoolDir, `${id}.response.json`),
        JSON.stringify({ id, ...response }),
        "utf8",
      );
      fs.rmSync(requestPath, { force: true });
    }
  }, 10);
  return timer;
}

function git(args: string[], cwd = tempDir): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
}

function createCommittedRepo(): void {
  fs.writeFileSync(path.join(tempDir, "report.md"), "# Report\n\nReady.\n", "utf8");
  git(["init"]);
  git(["config", "user.name", "Mandible Test"]);
  git(["config", "user.email", "mandible-test@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "report.md"]);
  git(["commit", "-m", "add report"]);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-cli-"));
  tempRoots = [];
  createCommittedRepo();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("artifact CLI", () => {
  it("documents the artifact command surface", () => {
    const result = run(["artifact", "--help"], process.cwd());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mandible artifact ingest <path...>");
    expect(result.stdout).toContain("mandible artifact snapshot <artifact-ref> --from <path>");
    expect(result.stdout).toContain("mandible artifact bundle create");
    expect(result.stdout).toContain("Recoverability:");
  });

  it("classifies clean tracked files as commit-pinned repo links in dry-run JSON", () => {
    const result = run(["artifact", "ingest", "report.md", "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const planned = payload.registered[0].planned_payload;
    expect(planned.uri).toMatch(/^repo:\/\/mandible-artifact-cli-/);
    expect(planned.uri).toContain("@");
    expect(planned.metadata.recoverability).toBe("repo_commit");
    expect(planned.metadata.git.tracked).toBe(true);
    expect(planned.metadata.git.dirty).toBe(false);
    expect(planned.metadata.warnings).toEqual([]);
  });

  it("redacts copied bytes from snapshot dry-run JSON", () => {
    const result = run(["artifact", "snapshot", "report.md", "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const planned = payload.registered[0].planned_payload;
    expect(planned.custody_mode).toBe("copy");
    expect(planned.metadata.recoverability).toBe("mandible_cas");
    expect(planned.content_base64).toBe("<base64 omitted in dry-run>");
  });

  it("auto-selects copy custody for file RPC path ingest dry-runs", () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);

    const result = run(["artifact", "ingest", "report.md", "--dry-run", "--json"], tempDir, {
      MANDIBLE_BASE: `file://${spoolDir}`,
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const planned = payload.registered[0].planned_payload;
    expect(payload.custody_mode).toBe("copy");
    expect(planned.custody_mode).toBe("copy");
    expect(planned.metadata.recoverability).toBe("mandible_cas");
    expect(planned.content_base64).toBe("<base64 omitted in dry-run>");
  });

  it("rejects explicit link custody in file RPC upload mode", () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);

    const result = run(["artifact", "ingest", "report.md", "--link", "--dry-run", "--json"], tempDir, {
      MANDIBLE_BASE: `file://${spoolDir}`,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("link custody requires daemon-visible host paths");
  });

  it("uploads snapshot bytes through file RPC and links the artifact to the issue", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];
    const timer = startFileRpcResponder(spoolDir, (request) => {
      seen.push(request);
      if (request.method === "GET" && request.path === "/api/ledger/issues/abc") {
        return {
          status: 200,
          body: {
            id: "issue-1",
            display_id: "abc",
            project: { repo_id: "mandible" },
          },
        };
      }
      if (request.method === "POST" && request.path === "/api/artifacts/ingest") {
        const body = request.body as Record<string, unknown>;
        expect(body).toMatchObject({
          custody_mode: "copy",
          filename: "report.md",
          media_type: "text/plain",
        });
        expect(typeof body.content_base64).toBe("string");
        expect(body).not.toHaveProperty("path");
        return {
          status: 200,
          body: {
            artifact: {
              id: `artifact:${body.sha256}`,
              custody_mode: "copy",
              availability: "present",
              metadata: { recoverability: "mandible_cas" },
            },
          },
        };
      }
      throw new Error(`unexpected file RPC request: ${JSON.stringify(request)}`);
    });

    try {
      const result = await runAsync(["artifact", "snapshot", "report.md", "--issue", "abc", "--json"], tempDir, {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).registered[0].artifact).toMatchObject({
        custody_mode: "copy",
        availability: "present",
      });
      expect(seen.map((request) => request.path)).toEqual([
        "/api/ledger/issues/abc",
        "/api/artifacts/ingest",
      ]);
    } finally {
      clearInterval(timer);
    }
  });

  it("reports file RPC issue resolver errors with the response detail", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);
    const timer = startFileRpcResponder(spoolDir, () => ({
      status: 404,
      body: { error: "issue_missing" },
    }));

    try {
      const result = await runAsync(["artifact", "snapshot", "report.md", "--issue", "missing", "--json"], tempDir, {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("HTTP 404: issue_missing");
    } finally {
      clearInterval(timer);
    }
  });

  it("keeps untracked repo-local files local-only instead of minting repo URIs", () => {
    fs.mkdirSync(path.join(tempDir, "_artifacts"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "_artifacts", "checkpoint.bin"), "checkpoint\n", "utf8");

    const result = run(["artifact", "ingest", "_artifacts/checkpoint.bin", "--allow-local-only", "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const planned = payload.registered[0].planned_payload;
    expect(planned.uri).toMatch(/^file:\/\//);
    expect(planned.canonical_ref).toMatch(/^artifact:[a-f0-9]{64}$/);
    expect(planned.metadata.recoverability).toBe("local_only");
    expect(planned.metadata.git.untracked).toBe(true);
    expect(planned.metadata.warnings.map((warning: { code: string }) => warning.code)).toContain("untracked_local_only");
  });

  it("previews bundle identity while preserving member recoverability in dry-run JSON", () => {
    const result = run(["artifact", "bundle", "create", "--name", "smoke", "report.md", "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.planned_payload.role).toBe("run_packet");
    expect(payload.planned_payload.reference.identity_kind).toBe("bundle_manifest");
    expect(payload.members[0].artifact.recoverability).toBe("repo_commit");
    expect(payload.planned_payload.json.members[0].ref).toContain("repo://");
  });
});
