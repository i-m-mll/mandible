import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "iab-preview.mjs");
const execFileAsync = promisify(execFile);

let tempRoots: string[] = [];
let previewServer: http.Server | null = null;

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
}

function gitOutput(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
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

function listenForDynamicHealth(healthPath: string): Promise<number> {
  previewServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(fs.readFileSync(healthPath, "utf8"));
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

async function createRefreshFixture(options: { buildFails?: boolean; restartFails?: boolean } = {}) {
  const repo = createRepo();
  git(["checkout", "-b", "integration/test-preview"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "new head\n", "utf8");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "new head"], repo);
  const currentHead = gitOutput(["rev-parse", "HEAD"], repo);
  const oldHead = "a".repeat(40);
  const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-cache-"));
  tempRoots.push(previewBase);
  const previewRoot = path.join(previewBase, "integration-test-preview");
  fs.mkdirSync(path.join(previewRoot, "agent-rpc"), { recursive: true });
  const db = path.join(previewRoot, "mandible-20260818-100000.db");
  const sourceDb = path.join(repo, "source.db");
  fs.writeFileSync(db, "projected database", "utf8");
  fs.writeFileSync(sourceDb, "source database", "utf8");
  fs.symlinkSync(db, path.join(previewRoot, "current.db"));
  for (const name of ["stdout.log", "stderr.log", "run.sh", "mandible.pid"]) {
    fs.writeFileSync(path.join(previewRoot, name), name === "mandible.pid" ? "999999\n" : "", "utf8");
  }

  const healthPath = path.join(previewRoot, "health.json");
  const refreshedHealthPath = path.join(previewRoot, "refreshed-health.json");
  const fileRpcDir = path.join(previewRoot, "agent-rpc");
  const health = {
    ready: true,
    warm: true,
    startup_commit: { hash: oldHead, summary: "old", date: "" },
    instance: {
      role: "preview",
      operational_mutations: "reject",
      db_path: db,
      db_path_source: "iab-preview-copy",
      source_db_path: sourceDb,
    },
    file_rpc_dir: fileRpcDir,
  };
  fs.writeFileSync(healthPath, JSON.stringify(health), "utf8");
  fs.writeFileSync(refreshedHealthPath, JSON.stringify({
    ...health,
    startup_commit: { hash: currentHead, summary: "new", date: "" },
  }), "utf8");
  const port = await listenForDynamicHealth(healthPath);
  const launchLabel = `bio.mll.mandible.preview.${port}.integration-test-preview`;
  const metadata = {
    ok: true,
    status: "started",
    branch: "integration/test-preview",
    worktree: repo,
    port,
    db,
    sourceDb,
    previewRoot,
    launchLabel,
    pidFile: path.join(previewRoot, "mandible.pid"),
    stdoutLog: path.join(previewRoot, "stdout.log"),
    stderrLog: path.join(previewRoot, "stderr.log"),
    runScript: path.join(previewRoot, "run.sh"),
    instanceEnv: {
      MANDIBLE_PORT: String(port),
      MANDIBLE_DB: db,
      MANDIBLE_PID_FILE: path.join(previewRoot, "mandible.pid"),
      MANDIBLE_INSTANCE_ROLE: "preview",
      MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
      MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
      MANDIBLE_INSTANCE_SOURCE_DB: sourceDb,
      MANDIBLE_FILE_RPC_DIR: fileRpcDir,
      MANDIBLE_CONFIG_DIR: path.join(previewRoot, "config"),
    },
    health,
  };
  const metadataPath = path.join(previewRoot, "metadata.json");
  fs.writeFileSync(metadataPath, JSON.stringify(metadata), "utf8");

  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-shims-"));
  tempRoots.push(shimDir);
  const npmShim = path.join(shimDir, "npm");
  const launchctlShim = path.join(shimDir, "launchctl");
  const launchLog = path.join(previewRoot, "launch.log");
  fs.writeFileSync(npmShim, `#!/bin/sh\n${options.buildFails ? "exit 23" : "exit 0"}\n`, { mode: 0o755 });
  fs.writeFileSync(launchctlShim, `#!/bin/sh
printf '%s\\n' "$*" >> "$MANDIBLE_IAB_PREVIEW_TEST_LAUNCH_LOG"
if [ "$1" = "submit" ]; then
  ${options.restartFails ? "exit 24" : "cp \"$MANDIBLE_IAB_PREVIEW_TEST_REFRESH_HEALTH\" \"$MANDIBLE_IAB_PREVIEW_TEST_HEALTH\""}
fi
exit 0
`, { mode: 0o755 });

  return {
    repo,
    currentHead,
    oldHead,
    previewBase,
    previewRoot,
    db,
    metadata,
    metadataPath,
    healthPath,
    refreshedHealthPath,
    launchctlShim,
    launchLog,
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      MANDIBLE_PREVIEW_BASE_DIR: previewBase,
      MANDIBLE_IAB_PREVIEW_LAUNCHCTL: launchctlShim,
      MANDIBLE_IAB_PREVIEW_TEST_LAUNCH_LOG: launchLog,
      MANDIBLE_IAB_PREVIEW_TEST_HEALTH: healthPath,
      MANDIBLE_IAB_PREVIEW_TEST_REFRESH_HEALTH: refreshedHealthPath,
    },
  };
}

describe("iab-preview launcher", () => {
  it("reports explicit preview instance environment in dry-run output", () => {
    const repo = createRepo();
    const sourceDb = path.join(repo, "source.db");
    const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-cache-"));
    tempRoots.push(previewBase);
    const previewRoot = path.join(previewBase, "integration-test-preview");
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
      env: {
        ...process.env,
        MANDIBLE_PREVIEW_BASE_DIR: previewBase,
      },
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.instanceEnv).toMatchObject({
      MANDIBLE_INSTANCE_ROLE: "preview",
      MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
      MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
      MANDIBLE_INSTANCE_SOURCE_DB: sourceDb,
      MANDIBLE_FILE_RPC_DIR: path.join(previewRoot, "agent-rpc"),
      MANDIBLE_CONFIG_DIR: path.join(previewRoot, "config"),
    });
    expect(payload.wouldCopyDb).toBe(false);
    expect(payload.wouldProjectDb).toBe(true);
    expect(payload.projection).toMatchObject({
      logs: expect.stringContaining("24h"),
      conversations: expect.stringContaining("whole"),
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

  it("does not reuse a preview daemon that owns the shared file-RPC spool", async () => {
    const repo = createRepo();
    git(["checkout", "-b", "integration/test-preview"], repo);
    const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-cache-"));
    tempRoots.push(previewBase);
    const previewRoot = path.join(previewBase, "integration-test-preview");
    fs.mkdirSync(previewRoot, { recursive: true });
    const sharedFileRpcDir = path.join(os.homedir(), ".cache", "mandible", "agent-rpc");
    const port = await listenForHealth({
      ready: true,
      instance: {
        role: "preview",
        operational_mutations: "reject",
      },
      file_rpc_dir: sharedFileRpcDir,
    });
    fs.writeFileSync(
      path.join(previewRoot, "metadata.json"),
      JSON.stringify({
        branch: "integration/test-preview",
        worktree: repo,
        port,
        instanceEnv: {
          MANDIBLE_INSTANCE_ROLE: "preview",
          MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
          MANDIBLE_FILE_RPC_DIR: sharedFileRpcDir,
        },
      }),
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
    expect(payload.instanceEnv.MANDIBLE_FILE_RPC_DIR).toBe(path.join(previewRoot, "agent-rpc"));
  });

  it("returns a one-time enrollment fragment without persisting the credential", async () => {
    const repo = createRepo();
    git(["checkout", "-b", "integration/test-preview"], repo);
    const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-cache-"));
    tempRoots.push(previewBase);
    const previewRoot = path.join(previewBase, "integration-test-preview");
    const fileRpcDir = path.join(previewRoot, "agent-rpc");
    const authDir = path.join(previewRoot, "config", "client-auth");
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(authDir, "bootstrap-token"), "preview bootstrap proof", { mode: 0o600 });
    const currentHead = gitOutput(["rev-parse", "HEAD"], repo);
    const port = await listenForHealth({
      ready: true,
      warm: true,
      startup_commit: { hash: currentHead, summary: "current", date: "" },
      instance: { role: "preview", operational_mutations: "reject" },
      file_rpc_dir: fileRpcDir,
    });
    const metadata = {
      status: "started",
      branch: "integration/test-preview",
      worktree: repo,
      port,
      db: path.join(previewRoot, "current.db"),
      previewRoot,
      instanceEnv: {
        MANDIBLE_INSTANCE_ROLE: "preview",
        MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
        MANDIBLE_FILE_RPC_DIR: fileRpcDir,
        MANDIBLE_CONFIG_DIR: path.join(previewRoot, "config"),
      },
    };
    fs.writeFileSync(path.join(previewRoot, "metadata.json"), JSON.stringify(metadata), "utf8");

    const result = await execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, MANDIBLE_PREVIEW_BASE_DIR: previewBase },
    });

    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("already-running");
    expect(payload.browserEnrollment).toBe("one-time-fragment");
    expect(new URL(payload.freshUrl).hash).toContain("mandible_auth=preview+bootstrap+proof");
    expect(fs.readFileSync(path.join(previewRoot, "metadata.json"), "utf8"))
      .not.toContain("preview bootstrap proof");
  });

  it("refreshes the same preview in place when its startup commit drifts", async () => {
    const fixture = await createRefreshFixture();
    const result = await execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: fixture.env,
    });

    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("refreshed");
    expect(payload.port).toBe(fixture.metadata.port);
    expect(payload.launchLabel).toBe(fixture.metadata.launchLabel);
    expect(payload.db).toBe(fixture.db);
    expect(payload.health.startup_commit.hash).toBe(fixture.currentHead);
    expect(payload.health).toMatchObject({ ready: true, warm: true });
    expect(fs.readFileSync(fixture.launchLog, "utf8")).toContain(`remove ${fixture.metadata.launchLabel}`);
    expect(fs.readFileSync(fixture.launchLog, "utf8")).toContain(`submit -l ${fixture.metadata.launchLabel}`);
    expect(fs.readdirSync(fixture.previewRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
      .map((entry) => entry.name)).toEqual([
      path.basename(fixture.db),
    ]);
    expect(fs.realpathSync(path.join(fixture.previewRoot, "current.db"))).toBe(fs.realpathSync(fixture.db));
  });

  it("keeps the already-running fast path when the full startup commit matches", async () => {
    const fixture = await createRefreshFixture();
    fs.copyFileSync(fixture.refreshedHealthPath, fixture.healthPath);
    const result = await execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: fixture.env,
    });

    expect(JSON.parse(result.stdout).status).toBe("already-running");
    expect(fs.existsSync(fixture.launchLog)).toBe(false);
  });

  it("leaves the existing preview metadata and projection untouched when the build fails", async () => {
    const fixture = await createRefreshFixture({ buildFails: true });
    const before = fs.readFileSync(fixture.metadataPath, "utf8");
    await expect(execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: fixture.env,
    })).rejects.toMatchObject({ code: 1 });

    expect(fs.readFileSync(fixture.metadataPath, "utf8")).toBe(before);
    expect(fs.existsSync(fixture.launchLog)).toBe(false);
    expect(fs.realpathSync(path.join(fixture.previewRoot, "current.db"))).toBe(fs.realpathSync(fixture.db));
  });

  it("reports restart failure without rewriting metadata or creating a projection", async () => {
    const fixture = await createRefreshFixture({ restartFails: true });
    const before = fs.readFileSync(fixture.metadataPath, "utf8");
    await expect(execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: fixture.env,
    })).rejects.toMatchObject({ code: 1 });

    expect(fs.readFileSync(fixture.metadataPath, "utf8")).toBe(before);
    expect(fs.readdirSync(fixture.previewRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
      .map((entry) => entry.name)).toEqual([
      path.basename(fixture.db),
    ]);
  });

  it("refuses branch custody drift before build or restart", async () => {
    const fixture = await createRefreshFixture();
    fs.writeFileSync(fixture.metadataPath, JSON.stringify({
      ...fixture.metadata,
      branch: "integration/unrelated-preview",
    }), "utf8");
    await expect(execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: fixture.env,
    })).rejects.toMatchObject({ code: 1 });
    expect(fs.existsSync(fixture.launchLog)).toBe(false);
  });

  it("refuses port and launch-label custody drift before build or restart", async () => {
    const fixture = await createRefreshFixture();
    fs.writeFileSync(fixture.metadataPath, JSON.stringify({
      ...fixture.metadata,
      launchLabel: `bio.mll.mandible.preview.${fixture.metadata.port + 1}.integration-test-preview`,
    }), "utf8");
    await expect(execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: fixture.env,
    })).rejects.toMatchObject({ code: 1 });
    expect(fs.existsSync(fixture.launchLog)).toBe(false);
  });
});
