import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "iab-preview.mjs");

let tempRoots: string[] = [];
let previewServer: http.Server | null = null;

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
}

function createRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-test-"));
  tempRoots.push(repo);
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "Mandible Test"], repo);
  git(["config", "user.email", "mandible-test@example.invalid"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "test\n", "utf8");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "base"], repo);
  return repo;
}

afterEach(() => {
  if (previewServer) {
    previewServer.close();
    previewServer = null;
  }
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

function listenForHealth(health: unknown): Promise<number> {
  previewServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  return new Promise((resolve) => {
    previewServer!.listen(0, "127.0.0.1", () => {
      const address = previewServer!.address();
      if (!address || typeof address === "string") {
        throw new Error("preview test server did not bind a TCP port");
      }
      resolve(address.port);
    });
  });
}

describe("iab-preview launcher", () => {
  it("reports explicit preview instance environment in dry-run output", () => {
    const repo = createRepo();
    const sourceDb = path.join(repo, "source.db");
    const result = spawnSync(process.execPath, [
      SCRIPT,
      "--dry-run",
      "--json",
      "--branch",
      "integration/test-preview",
      "--db",
      sourceDb,
    ], {
      cwd: repo,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.instanceEnv).toMatchObject({
      MANDIBLE_INSTANCE_ROLE: "preview",
      MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
      MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
      MANDIBLE_INSTANCE_SOURCE_DB: sourceDb,
    });
  });

  it("does not reuse a healthy daemon without preview reject policy metadata", async () => {
    const repo = createRepo();
    git(["checkout", "-b", "integration/test-preview"], repo);
    const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-cache-"));
    tempRoots.push(previewBase);
    const previewRoot = path.join(previewBase, "integration-test-preview");
    fs.mkdirSync(previewRoot, { recursive: true });
    const port = await listenForHealth({
      ready: true,
      instance: {
        role: "main",
        operational_mutations: "allow",
      },
    });
    fs.writeFileSync(
      path.join(previewRoot, "metadata.json"),
      JSON.stringify({ branch: "integration/test-preview", worktree: repo, port }),
      "utf8",
    );

    const result = spawnSync(process.execPath, [
      SCRIPT,
      "--dry-run",
      "--json",
    ], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        MANDIBLE_PREVIEW_BASE_DIR: previewBase,
      },
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("dry-run");
    expect(payload.mode).toBe("current-integration");
  });
});
