// @vitest-environment node

import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import SqliteDatabase from "../../src/sqlite.ts";

import { openDb } from "../../src/db.js";
import { setSetting } from "../../src/client-auth/settings-kv.js";
import { LocalSessionAuthority } from "../../src/client-auth/session-authority.js";
import { localCaPaths } from "../../scripts/local-ca-trust.mjs";
import { RICH_BRIEFING_DEMO } from "../../src/feedback/rich-briefing-demo.js";
import { sealedRetiredDemoPacket } from "../helpers/sealed-retired-demo.js";
import { recordArtifactVersion } from "../helpers/artifact-http-write-fixtures.js";
import { getCanonicalArtifactVersion } from '../../src/provider-artifacts.js';
import { createUser, setupOperator } from "../../src/users/store.js";
import { insertRawLedgerCheckout, insertRawLedgerProject } from "../helpers/ledger-fixtures.js";
import { createOwnedRun, saveOwnedMetadata, finalizeOwnedRun } from "../../scripts/owned-run.mjs";
import { seedPreviewUserPreferences, cleanupPreviewCache, assertPreviewAllocation } from "../../scripts/iab-preview.mjs";

const SCRIPT = path.join(process.cwd(), "scripts", "iab-preview.mjs");
const execFileAsync = promisify(execFile);

let tempRoots: string[] = [];
let previewServer: http.Server | null = null;
const previewServers = new Set<http.Server>();

// Previews are ordinary detached child processes now, so these tests really do
// launch one. Every pid this file is responsible for is tracked here and killed
// between tests: a stand-in daemon that outlived the suite would be the exact
// leak the launcher change exists to stop.
let standInPids: number[] = [];
let standInPidFiles: string[] = [];

// Above macOS's pid ceiling, so `kill(pid, 0)` is guaranteed to report it dead.
// Used wherever a preview pid file must name a process that cannot exist.
const UNREACHABLE_PID = 999_999;

function previewLauncherEnv(previewBase: string): NodeJS.ProcessEnv {
  const mandibleHome = path.join(previewBase, "mandible-home");
  const clientAuthDir = path.join(mandibleHome, "config", "client-auth");
  const authorityDir = path.join(mandibleHome, "config", "local-sessions");
  fs.mkdirSync(clientAuthDir, { recursive: true });
  fs.mkdirSync(path.join(mandibleHome, "artifacts"), { recursive: true });
  const authorityFile = path.join(clientAuthDir, "authority-id");
  if (!fs.existsSync(authorityFile)) fs.writeFileSync(authorityFile, "authority_iab_test\n", { mode: 0o600 });
  const authority = new LocalSessionAuthority(authorityDir, "authority_iab_test", { initialize: true });
  authority.registerInstance({
    instance_id: "production",
    installation_id: "authority_iab_test",
    role: "main",
    public_origin: "https://app.mandible.localhost:19420",
    backend_origin: "http://127.0.0.1:29420",
    backend_generation: "test-production",
    effect_ceiling: ["ledger:read", "ledger:write", "maintenance:shared"],
    writable_roots: [],
  });
  authority.close();
  const ca = localCaPaths(mandibleHome);
  fs.mkdirSync(path.dirname(ca.rootCert), { recursive: true });
  fs.writeFileSync(ca.rootCert, "-----BEGIN CERTIFICATE-----\ntest-root\n-----END CERTIFICATE-----\n");
  fs.writeFileSync(ca.rootKey, "test-key");
  const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(ca.receipt, JSON.stringify({
    schema: "mandible-local-ca-trust@1",
    state: "trusted",
    caddy_version: "2.11.3",
    storage_root: ca.storageRoot,
    installation_digest: digest(ca.installationAuthority),
    root_digest: digest(ca.rootCert),
    key_digest: digest(ca.rootKey),
  }));
  const caddy = path.join(mandibleHome, "runtime", "caddy", "2.11.3", "caddy");
  fs.mkdirSync(path.dirname(caddy), { recursive: true });
  if (!fs.existsSync(caddy)) fs.writeFileSync(caddy, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return {
    ...process.env,
    MANDIBLE_PREVIEW_BASE_DIR: previewBase,
    MANDIBLE_HOME: mandibleHome,
    MANDIBLE_ARTIFACT_DIR: path.join(mandibleHome, "artifacts"),
  };
}

function readPidFile(filePath: string): number | null {
  try {
    const value = Number.parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
    return Number.isInteger(value) && value > 1 ? value : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function findUnusedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not allocate a port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function requestPreviewWhoami(port: number, token: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/api/client-auth/whoami",
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: raw ? JSON.parse(raw) : null,
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Kill only processes this file started.
 *
 * Pids come from `standInPids` (started here directly) and from the marker file
 * that only the stand-in daemon writes — never from the launcher's own
 * `mandible.pid`, which a fixture may deliberately seed with a pid this suite
 * does not own.
 */
function killStandInProcesses(): void {
  const pids = new Set<number>(standInPids);
  for (const pidFile of standInPidFiles) {
    const pid = readPidFile(pidFile);
    if (pid !== null) pids.add(pid);
  }
  for (const pid of pids) {
    if (pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone: the launcher stopped it, or the test did.
    }
  }
  standInPids = [];
  standInPidFiles = [];
}

/**
 * Start a detached, reparented stand-in for a running preview daemon.
 *
 * The direct child exits immediately so the background process reparents to
 * init, which reaps it the moment it dies. That matters: a zombie still answers
 * `kill(pid, 0)`, which would make the launcher's own "did it stop?" poll
 * observe a process that has actually exited.
 */
function spawnStandInDaemon(pidPath: string, options: { ignoresSigterm?: boolean } = {}): number {
  // `trap "" TERM` is what forces the launcher's bounded SIGKILL escalation.
  const body = options.ignoresSigterm
    ? `trap "" TERM; while :; do sleep 1; done`
    : `while :; do sleep 1; done`;
  const result = spawnSync("/bin/sh", [
    "-c",
    `sh -c '${body}' >/dev/null 2>&1 & printf '%s' "$!" > '${pidPath}'`,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`could not start a stand-in preview daemon:\n${result.stderr}`);
  }
  const pid = readPidFile(pidPath);
  if (pid === null) {
    throw new Error("stand-in preview daemon did not report a pid");
  }
  standInPids.push(pid);
  return pid;
}

function fixtureGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", env: fixtureGitEnv() });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
}

function gitOutput(args: string[], cwd: string): string {
  const result = spawnSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", env: fixtureGitEnv() });
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

function slugify(value: string): string {
  return value.replace(/^refs\/heads\//, "").replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 120);
}

function fileHash(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function inventory(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .map((entry) => `${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"}:${entry.name}`)
    .sort();
}

function byteInventory(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const entries: string[] = [];
  const visit = (current: string, relative: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const entryRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        entries.push(`d:${entryRelative}`);
        visit(entryPath, entryRelative);
      } else if (entry.isSymbolicLink()) {
        entries.push(`l:${entryRelative}:${fs.readlinkSync(entryPath)}`);
      } else {
        entries.push(`f:${entryRelative}:${fileHash(entryPath)}`);
      }
    }
  };
  visit(root, "");
  return entries.sort();
}

async function runLauncherExport(name: "createProjectedSnapshot" | "materializeProjectedBriefingDemo" | "materializeProjectedAgentsReview" | "seedProjectedConversationStructureCache", details: object) {
  try {
    const launcher = await import("../../scripts/iab-preview.mjs");
    const result = await launcher[name](details as never);
    return { status: 0, stdout: JSON.stringify(result), stderr: "" };
  } catch (error) {
    return { status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

function createSeedFixture() {
  const worktree = fs.realpathSync.native(process.cwd());
  const branchRepo = createRepo();
  git(["checkout", "-b", "integration/test-preview"], branchRepo);
  const branch = gitOutput(["branch", "--show-current"], branchRepo);
  const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-seed-cache-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-seed-source-"));
  tempRoots.push(previewBase, sourceRoot);
  const previewRoot = path.join(previewBase, slugify(branch));
  fs.mkdirSync(previewRoot, { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(previewRoot, "settings", "users"), { recursive: true });
  const db = path.join(previewRoot, "mandible-20260818-120000.db");
  openDb(db).close();
  const sourceDb = path.join(sourceRoot, "source.db");
  fs.writeFileSync(sourceDb, "immutable source fixture\n", "utf8");
  fs.symlinkSync(db, path.join(previewRoot, "current.db"));
  const instanceEnv = {
    MANDIBLE_DB: db,
    MANDIBLE_INSTANCE_ROLE: "preview",
    MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(["ledger:read", "ledger:write", "files:preview", "preferences:instance"]),
    MANDIBLE_WRITABLE_ROOTS: JSON.stringify([previewRoot]),
    MANDIBLE_ARTIFACT_DIR: path.join(previewRoot, "artifacts"),
    MANDIBLE_INSTANCE_SOURCE_ARTIFACT_DIR: path.join(sourceRoot, "artifacts"),
    MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
    MANDIBLE_INSTANCE_SOURCE_DB: sourceDb,
  };
  const health = {
    instance: {
      role: "preview",
      allowed_effects: ["ledger:read", "ledger:write", "files:preview", "preferences:instance"],
      operational_mutations: "reject",
      db_path_source: "iab-preview-copy",
      db_path: db,
      source_db_path: sourceDb,
    },
  };
  const metadata = { branch, worktree, previewRoot, db, sourceDb, instanceEnv, health };
  const metadataPath = path.join(previewRoot, "metadata.json");
  fs.writeFileSync(metadataPath, JSON.stringify(metadata), "utf8");
  return {
    worktree, branch, previewBase, previewRoot, db, sourceRoot, sourceDb, metadata, metadataPath,
    env: {
      ...previewLauncherEnv(previewBase),
      GIT_DIR: path.join(branchRepo, ".git"),
      GIT_WORK_TREE: worktree,
      MANDIBLE_PREVIEW_BASE_DIR: previewBase,
    },
  };
}

const RETIRED_V1_ROUND_ONE = `# Release candidate readiness review

The candidate is feature-complete; this review confirms bounded release readiness with \`release.freeze=true\`.

> Staging rehearsal completed with the candidate artifact and the documented rollback path.

## Bounded scope

- Approve only the signed candidate artifact.
- Keep rollback within the 15 minute recovery objective.
- Confirm dashboards before opening the release window.

| Risk | Evidence | Residual |
| --- | --- | --- |
| Schema drift | Migration replay passed | Low |
| Alert gaps | Synthetic checks passed | Medium |

\`\`\`ini
release.freeze=true
rollback.window=15m
\`\`\`

See the [release evidence packet](https://example.com/releases/rc-readiness) for the immutable source record.

:::spec-item{key="scope.approval" required="true"}
Keep the candidate within the reviewed release scope?
:::

:::spec-item{key="rollback.plan" required="true"}
Keep the rehearsed rollback plan as the release fallback?
:::

:::spec-item{key="observability" required="false"}
Keep the current observability coverage for the release window?
:::

:::spec-item{key="operator.runbook"}
Keep the operator runbook as the execution guide?
:::
`;

const RETIRED_V1_ROUND_TWO = `# Release candidate readiness review

The candidate now includes the final migration rehearsal; this review confirms the revised boundary with \`release.freeze=true\`.

> Production-shaped validation completed after the alert thresholds and rollback owner were clarified.

## Bounded scope

- Approve only the newly signed candidate artifact.
- Require rollback inside the 10 minute recovery objective.
- Confirm dashboards and the named incident lead before opening the release window.

| Risk | Evidence | Residual |
| --- | --- | --- |
| Schema drift | Clean replay plus downgrade rehearsal | Low |
| Alert gaps | Thresholds exercised end to end | Low |

\`\`\`ini
release.freeze=true
rollback.window=10m
\`\`\`

See the [revised release evidence packet](https://example.com/releases/rc-readiness-v2) for the exact follow-up record.

:::spec-item{key="scope.approval" required="true"}
Keep the revised candidate inside the final reviewed release scope?
:::

:::spec-item{key="rollback.plan" required="true"}
Keep the tightened rollback plan as the release fallback?
:::

:::spec-item{key="observability" required="false"}
Keep the exercised alert thresholds for the release window?
:::

:::spec-item{key="operator.runbook"}
Keep the clarified operator runbook as the execution guide?
:::
`;

function seedSealedRetiredDemo(
  fixture: ReturnType<typeof createSeedFixture>,
  options: { historicalCompatibleUsers?: boolean } = {},
) {
  const db = openDb(fixture.db);
  const artifactRoot = path.join(fs.realpathSync.native(fixture.previewRoot), "rich-briefing-demo-artifacts");
  setSetting(db, "artifact_root", artifactRoot);
  const userTimestamp = RICH_BRIEFING_DEMO.roundOneTimestamp - 1_000;
  const publisher = createUser(db, {
    slug: RICH_BRIEFING_DEMO.publisherSlug, kind: "agent",
    display_name: options.historicalCompatibleUsers ? "Existing Preview Publisher" : "Briefing Demo Publisher",
    metadata: options.historicalCompatibleUsers ? { owner: "pre-existing-preview-state" }
      : { fixture: "rich-briefing-demo", deterministic: true },
  }, userTimestamp);
  const reviewer = createUser(db, {
    slug: RICH_BRIEFING_DEMO.reviewerSlug, kind: "human",
    display_name: options.historicalCompatibleUsers ? "Existing Preview Reviewer" : "Briefing Demo Reviewer",
    metadata: options.historicalCompatibleUsers ? { owner: "pre-existing-preview-state" }
      : { fixture: "rich-briefing-demo", deterministic: true },
  }, userTimestamp);
  const briefingId = randomUUID();
  const sources = [RETIRED_V1_ROUND_ONE, RETIRED_V1_ROUND_TWO].map(source => source.trim());
  const artifacts = sources.map((source, index) => recordArtifactVersion(db, {
    source_kind: "managed", content: source, series_key: `mandible:briefing:${briefingId}`,
    logical_name: `${RICH_BRIEFING_DEMO.briefingKey}.md`, title: RICH_BRIEFING_DEMO.title,
    role: "briefing-document", media_type: "text/markdown",
    metadata: { profile: "mandible-briefing.v1", briefing_id: briefingId },
    parent_version_id: index === 0 ? null : undefined,
  }, index === 0 ? RICH_BRIEFING_DEMO.roundOneTimestamp : RICH_BRIEFING_DEMO.roundTwoTimestamp));
  db.prepare(
    `INSERT INTO briefings (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 0, ?, ?)`,
  ).run(briefingId, RICH_BRIEFING_DEMO.briefingKey, RICH_BRIEFING_DEMO.title,
    RICH_BRIEFING_DEMO.roundOneTimestamp, RICH_BRIEFING_DEMO.roundTwoTimestamp);
  db.prepare("INSERT INTO briefing_members (briefing_id, user_id, created_at) VALUES (?, ?, ?)")
    .run(briefingId, reviewer.id, RICH_BRIEFING_DEMO.roundOneTimestamp);
  const packet = sealedRetiredDemoPacket({ briefingId, publisherId: publisher.id, reviewerId: reviewer.id,
    versions: artifacts.map(artifact => getCanonicalArtifactVersion(db, artifact.version.id)!), sources });
  db.prepare(
    `INSERT INTO briefing_legacy_custody
      (id, briefing_id, source_profile, disposition, reason, packet_json, packet_digest, created_at)
     VALUES (?, ?, 'mandible-briefing.v1', 'sealed_verified', ?, ?, ?, ?)`,
  ).run(`sealed-demo:${briefingId}`, briefingId, "Retired release-readiness review in verified custody",
    packet.json, packet.digest, RICH_BRIEFING_DEMO.roundTwoTimestamp + 1);
  db.prepare(
    "INSERT INTO briefings (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, 1, 1)",
  ).run("unrelated-briefing", "demo.unrelated", "Unrelated preview Briefing");
  db.close();
  return { briefingId, artifactRoot, artifactVersionIds: artifacts.map(artifact => artifact.version.id) };
}

function runSeed(fixture: ReturnType<typeof createSeedFixture>, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, "seed-briefing-demo", "--json", "--no-build", ...extraArgs], {
    cwd: fixture.worktree,
    encoding: "utf8",
    env: fixture.env,
  });
}

afterEach(async () => {
  // Stop the daemons before removing the directories they are running out of.
  killStandInProcesses();
  for (const server of previewServers) {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  previewServers.clear();
  previewServer = null;
  for (const root of tempRoots) {
    // `src` inside a fixture repo is a tree of symlinks into the real source.
    // Recursive removal unlinks symlinks rather than following them, so the
    // real source is never touched.
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

afterAll(() => {
  killStandInProcesses();
});

function listenForHealth(
  health: unknown,
  proofPath?: string,
  options: { verifiedHuman?: boolean; applicationShell?: boolean } = {},
): Promise<number> {
  let dashboardSequence = 0;
  const dashboardTokens = new Set<string>();
  previewServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health));
      return;
    }
    if (options.applicationShell !== false && req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><link rel="stylesheet" href="./dist/app.css"></head><body><div id="app"></div><script id="mandible-bootstrap" type="application/json"></script><script type="module" src="./dist/app.js"></script></body></html>`);
      return;
    }
    if (options.applicationShell !== false && req.method === "GET" && req.url === "/dist/app.css") {
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      res.end("#app { display: block; }");
      return;
    }
    if (options.applicationShell !== false && req.method === "GET" && req.url === "/dist/app.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end("export {};");
      return;
    }
    if (req.method === "POST" && req.url === "/api/client-auth/handshake" && proofPath) {
      const proof = JSON.parse(fs.readFileSync(proofPath, "utf8")) as { token: string };
      if (req.headers.authorization !== `Bearer ${proof.token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "authentication_required" }));
        return;
      }
      const dashboardToken = `preview dashboard session ${++dashboardSequence}`;
      dashboardTokens.add(dashboardToken);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: dashboardToken, user: { id: "human-browser" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/client-auth/whoami" && proofPath) {
      const authenticated = typeof req.headers.authorization === "string"
        && dashboardTokens.has(req.headers.authorization.slice("Bearer ".length));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(authenticated ? {
        authenticated: true,
        user: { id: "human-browser", kind: options.verifiedHuman === false ? "agent" : "human" },
        ephemeral_purpose: "dashboard_handshake",
      } : { authenticated: false, user: null }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  previewServers.add(previewServer);

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

/**
 * The environment the launcher is required to pin for an isolated preview.
 *
 * Mirrors `previewInstanceEnv` in scripts/iab-preview.mjs, including the three
 * keys derived from the preview root. A recorded instance missing any of them
 * is treated as drifted and replaced rather than refreshed, so a fixture that
 * omits them silently stops testing the refresh path at all.
 */
function previewContractEnv(details: {
  port: number;
  db: string;
  sourceDb: string;
  previewRoot: string;
  pidFile: string;
}): Record<string, string> {
  const conversations = path.join(details.previewRoot, "conversations");
  const instanceId = `preview-${createHash("sha256").update(details.previewRoot).digest("hex").slice(0, 16)}`;
  const mandibleHome = path.join(path.dirname(details.previewRoot), "mandible-home");
  return {
    MANDIBLE_PORT: String(details.port),
    MANDIBLE_DB: details.db,
    MANDIBLE_PID_FILE: details.pidFile,
    MANDIBLE_INSTANCE_ROLE: "preview",
    MANDIBLE_INSTANCE_ID: instanceId,
    MANDIBLE_INSTALLATION_ID: "authority_iab_test",
    MANDIBLE_PUBLIC_ORIGIN: `https://${instanceId}.mandible.localhost:19421`,
    MANDIBLE_BACKEND_GENERATION: "preview-generation",
    MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR: path.join(mandibleHome, "config", "local-sessions"),
    MANDIBLE_CONTEXT_VERIFICATION_KEY: path.join(mandibleHome, "config", "local-sessions", "context-verification-key.pem"),
    MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
    MANDIBLE_INSTANCE_SOURCE_DB: details.sourceDb,
    MANDIBLE_ARTIFACT_DIR: path.join(details.previewRoot, "artifacts"),
    MANDIBLE_USER_PREFERENCES_DIR: path.join(details.previewRoot, "settings", "users"),
    MANDIBLE_INSTANCE_SOURCE_ARTIFACT_DIR: path.join(mandibleHome, "artifacts"),
    MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(["ledger:read", "ledger:write", "files:preview", "preferences:instance"]),
    MANDIBLE_WRITABLE_ROOTS: JSON.stringify([details.previewRoot]),
    MANDIBLE_FILE_RPC_DIR: path.join(details.previewRoot, "agent-rpc"),
    MANDIBLE_CONFIG_DIR: path.join(details.previewRoot, "config"),
    MANDIBLE_CLIENT_AUTH_DIR: path.join(
      mandibleHome,
      "preview-authorities",
      path.basename(details.previewRoot),
      "client-auth",
    ),
    MANDIBLE_PREVIEW_ROOT: details.previewRoot,
    MANDIBLE_CONVERSATION_STRUCTURE_DB: path.join(conversations, "structure.db"),
    MANDIBLE_CONVERSATION_CACHE_DB: path.join(conversations, "search-cache.db"),
    MANDIBLE_STDERR_LOG_PATH: path.join(details.previewRoot, "stderr.log"),
    MANDIBLE_STDOUT_LOG_PATH: path.join(details.previewRoot, "stdout.log"),
    MANDIBLE_CLI_CACHE_DIR: path.join(details.previewRoot, "cli"),
  };
}

/**
 * Give the fixture repo a `src` the launcher can really execute.
 *
 * The launcher does two different things with `<worktree>/src`: it imports the
 * genuine `db.ts` and `feedback/rich-briefing-demo.ts` to materialize the
 * projected briefing demo, and it runs `index.ts` as the preview daemon. So
 * every real entry is symlinked through, and only `index.ts` is replaced by a
 * stand-in.
 *
 * The health file paths are baked in as literals rather than passed through the
 * environment on purpose: `sanitizedLauncherEnv()` strips every `MANDIBLE_*`
 * variable from the child, so an env-carried path would arrive empty and the
 * test would pass for the wrong reason.
 */
describe("iab-preview launcher", () => {
  it("preserves stopped interactive ledger and managed bytes including older snapshots", async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-cleanup-"))); tempRoots.push(base);
    const root = path.join(base, "edited"); fs.mkdirSync(root);
    const db = path.join(root, "mandible-20261004-100000.db");
    const older = path.join(root, "mandible-20261003-100000.db");
    fs.writeFileSync(db, "unique ledger edit"); fs.writeFileSync(`${db}-wal`, "uncheckpointed edit"); fs.writeFileSync(older, "older writable edits");
    fs.mkdirSync(path.join(root, "artifacts")); fs.writeFileSync(path.join(root, "artifacts", "document"), "managed edits");
    fs.writeFileSync(path.join(root, "metadata.json"), JSON.stringify({ db, previewRoot: root }));
    fs.symlinkSync(db, path.join(root, "current.db"));
    const report = await cleanupPreviewCache({ apply: true, previewBaseDir: base });
    expect(report.reclaimedBytes).toBe(0);
    expect(fs.readFileSync(`${db}-wal`, "utf8")).toBe("uncheckpointed edit");
    expect(fs.readFileSync(older, "utf8")).toBe("older writable edits");
    expect(fs.readFileSync(path.join(root, "artifacts", "document"), "utf8")).toBe("managed edits");
  });

  it("cleans a disposed fixture after its report while preserving unknown entries", async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-cleanup-"))); tempRoots.push(base);
    const root = path.join(base, "fixture"); fs.mkdirSync(root);
    const file = path.join(root, "metadata.json");
    const ownership = createOwnedRun({ root, instanceId: "preview-fixture", project: "fixture-project", workUnit: "fixture-work-unit", disposable: true, outputs: [{ path: "db", kind: "interactive" }] });
    Object.assign(ownership, { lifecycle: { phase: "retired" } });
    saveOwnedMetadata(file, { ownership }); fs.writeFileSync(path.join(root, "db"), "fixture bytes");
    const finalized = finalizeOwnedRun(file, { expectedRevision: 1, outcome: "assessed", summary: "Disposable fixture succeeded" });
    fs.writeFileSync(path.join(root, "unknown"), "unclassified bytes");
    const report = await cleanupPreviewCache({ apply: true, previewBaseDir: base });
    expect(report.reclaimedBytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, "db"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "unknown"), "utf8")).toBe("unclassified bytes");
    expect(fs.existsSync(finalized.ownership.receipt)).toBe(true);
  });

  it("refuses low headroom without changing the existing preview", () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-budget-"))); tempRoots.push(base);
    const root = path.join(base, "preview"); fs.mkdirSync(root);
    const db = path.join(base, "source.db"); fs.writeFileSync(db, "source bytes");
    fs.writeFileSync(path.join(root, "user-edit"), "keep this");
    expect(() => assertPreviewAllocation(root, db, { volume: { bavail: 1, bsize: 4096 } })).toThrow(/allocation refused/);
    expect(fs.readFileSync(path.join(root, "user-edit"), "utf8")).toBe("keep this");
  });

  it("seeds only exact projected conversation versions into the isolated structure cache", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-structure-cache-"));
    tempRoots.push(root);
    const projectedDb = path.join(root, "preview.db");
    const sourceCache = path.join(root, "source-structure.db");
    const targetCache = path.join(root, "preview", "conversations", "structure.db");

    const projected = new SqliteDatabase(projectedDb);
    projected.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY);
      CREATE TABLE conversation_sources (
        conversation_id TEXT NOT NULL,
        current_version_id TEXT
      );
      INSERT INTO conversations VALUES ('kept');
      INSERT INTO conversation_sources VALUES ('kept', 'version-current');
    `);
    projected.close();

    const source = new SqliteDatabase(sourceCache);
    source.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE cache_conversations (
        cache_id INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL UNIQUE,
        source_version_id TEXT NOT NULL
      );
      CREATE TABLE cache_blocks (
        cache_conversation_id INTEGER NOT NULL REFERENCES cache_conversations(cache_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (cache_conversation_id, position)
      );
      INSERT INTO cache_conversations VALUES (1, 'kept', 'version-current');
      INSERT INTO cache_conversations VALUES (2, 'stale', 'version-old');
      INSERT INTO cache_blocks VALUES (1, 0);
      INSERT INTO cache_blocks VALUES (2, 0);
    `);
    source.close();

    const result = await runLauncherExport("seedProjectedConversationStructureCache", {
      sourceCache,
      targetCache,
      projectedDb,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "seeded",
      source: sourceCache,
      target: targetCache,
      conversations: 1,
      blocks: 1,
    });
    const seeded = new SqliteDatabase(targetCache, { readonly: true });
    expect(seeded.prepare("SELECT conversation_id, source_version_id FROM cache_conversations").all())
      .toEqual([{ conversation_id: "kept", source_version_id: "version-current" }]);
    expect(seeded.prepare("SELECT cache_conversation_id, position FROM cache_blocks").all())
      .toEqual([{ cache_conversation_id: 1, position: 0 }]);
    seeded.close();

    const previewDb = new SqliteDatabase(projectedDb);
    previewDb.prepare("UPDATE conversation_sources SET current_version_id = 'version-preview' WHERE conversation_id = 'kept'").run();
    previewDb.close();
    const privateCache = new SqliteDatabase(targetCache);
    privateCache.prepare("UPDATE cache_conversations SET source_version_id = 'version-preview' WHERE conversation_id = 'kept'").run();
    privateCache.prepare("UPDATE cache_blocks SET position = 17 WHERE cache_conversation_id = 1").run();
    privateCache.close();

    const refreshed = await runLauncherExport("seedProjectedConversationStructureCache", {
      sourceCache,
      targetCache,
      projectedDb,
      preserveExisting: true,
    });
    expect(refreshed.status, refreshed.stderr).toBe(0);
    expect(JSON.parse(refreshed.stdout)).toMatchObject({ status: "preserved", conversations: 1, blocks: 1 });
    const retained = new SqliteDatabase(targetCache, { readonly: true });
    expect(retained.prepare("SELECT conversation_id, source_version_id FROM cache_conversations").all())
      .toEqual([{ conversation_id: "kept", source_version_id: "version-preview" }]);
    expect(retained.prepare("SELECT cache_conversation_id, position FROM cache_blocks").all())
      .toEqual([{ cache_conversation_id: 1, position: 17 }]);
    retained.close();
  });

  it("rejects malformed agents-review refs before touching the launcher-owned copy", async () => {
    const fixture = createSeedFixture();
    const before = fileHash(fixture.db);
    const result = await runLauncherExport("materializeProjectedAgentsReview", {
      worktree: fixture.worktree, previewRoot: fixture.previewRoot, db: fixture.db,
      sourceDb: fixture.sourceDb, artifactVersionRef: "artifact-version:bad!",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("artifact version ref is missing or malformed");
    expect(fileHash(fixture.db)).toBe(before);
  });

  it("seeds one committed link-custody v3 artifact idempotently without touching source bytes", async () => {
    const fixture = createSeedFixture();
    const repo = createRepo();
    const reviewPath = path.join(repo, "AGENTS.review.md");
    const review = `# Policy\n\n:::spec-item{key="wording" type="text_variant" required="true"}\n::alternative[One]{key="one"}\nOne.\n::alternative[Two]{key="two"}\nTwo.\n:::`;
    fs.writeFileSync(reviewPath, review); git(["add", "AGENTS.review.md"], repo); git(["commit", "-m", "review"], repo);
    const db = openDb(fixture.db);
    const projectId = insertRawLedgerProject(db, { name: "review-fixture", projectKey: "review-fixture" });
    insertRawLedgerCheckout(db, { projectId, name: "review-fixture", root: fs.realpathSync(repo), conflict: "replace" });
    const operator = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" });
    setSetting(db, "user.operator_id", operator.id);
    const artifact = recordArtifactVersion(db, { source_kind: "tracked_repo", path: reviewPath,
      role: "review-document", media_type: "text/plain" });
    expect(artifact.version).toMatchObject({ source_kind: "tracked_repo", custody_mode: "git" });
    expect(db.prepare("SELECT media_type FROM artifact_blob WHERE content_hash = ?").get(artifact.artifact.content_hash))
      .toEqual({ media_type: "text/plain" });
    db.close();
    const sourceHash = fileHash(reviewPath);
    const details = { worktree: fixture.worktree, previewRoot: fixture.previewRoot, db: fixture.db,
      sourceDb: fixture.sourceDb, artifactVersionRef: artifact.version.id };
    const first = await runLauncherExport("materializeProjectedAgentsReview", details);
    expect(first.status, first.stderr).toBe(0);
    const second = await runLauncherExport("materializeProjectedAgentsReview", details);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).round_id).toBe(JSON.parse(first.stdout).round_id);
    const seeded = new SqliteDatabase(fixture.db, { readonly: true });
    expect(seeded.prepare("SELECT profile, artifact_version_id FROM briefing_rounds").all()).toEqual([
      { profile: "mandible-briefing.v3", artifact_version_id: artifact.version.id },
    ]);
    seeded.close();
    expect(fileHash(reviewPath)).toBe(sourceHash);
  }, 30_000);
  it("materializes the exact retired copied-preview shape before startup preparation completes", async () => {
    const source = createSeedFixture();
    seedSealedRetiredDemo(source, { historicalCompatibleUsers: true });
    const sourceDb = new SqliteDatabase(source.db);
    for (const ordinal of [2, 3]) {
      sourceDb.prepare(
        `INSERT INTO briefings
          (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 0, ?, ?)`,
      ).run(`unrelated-briefing-${ordinal}`, `demo.unrelated.${ordinal}`, `Unrelated preview Briefing ${ordinal}`, ordinal, ordinal);
    }
    sourceDb.pragma("wal_checkpoint(TRUNCATE)");
    sourceDb.close();

    const sourceHash = fileHash(source.db);
    const sourceArtifactRoot = path.join(source.previewRoot, "rich-briefing-demo-artifacts");
    const sourceArtifactInventory = byteInventory(sourceArtifactRoot);
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-projected-"));
    tempRoots.push(targetRoot);
    const targetDb = path.join(targetRoot, "mandible-20260819-120000.db");

    const projectionResult = await runLauncherExport("createProjectedSnapshot", {
      sourceDb: source.db,
      dbCopy: targetDb,
      worktree: source.worktree,
    });
    expect(projectionResult.status, projectionResult.stderr).toBe(0);
    const projection = JSON.parse(projectionResult.stdout);
    expect(projection.briefingDemo).toMatchObject({
      result: "upgraded",
      schema: "mandible-rich-briefing-demo@2",
      artifact_root: path.join(fs.realpathSync.native(targetRoot), "rich-briefing-demo-artifacts"),
      semantic_state: {
        round_one_frozen_answer_count: 6,
        round_one_frozen_annotation_count: 2,
        round_two_answers: 0,
        round_two_annotations: 0,
        round_two_submission: null,
      },
    });
    expect(projection.briefingDemo.rounds).toHaveLength(2);

    const projected = new SqliteDatabase(targetDb, { readonly: true });
    expect(projected.prepare(
      "SELECT ordinal, profile FROM briefing_rounds WHERE briefing_id = ? ORDER BY ordinal",
    ).all(projection.briefingDemo.briefing.id)).toEqual([
      { ordinal: 1, profile: "mandible-briefing.v2" },
      { ordinal: 2, profile: "mandible-briefing.v2" },
    ]);
    expect(projected.prepare("SELECT COUNT(*) AS n FROM briefing_runs WHERE briefing_id = ?")
      .get(projection.briefingDemo.briefing.id)).toEqual({ n: 2 });
    expect(projected.prepare("SELECT title FROM briefings WHERE briefing_key LIKE 'demo.unrelated%' ORDER BY briefing_key").all())
      .toEqual([{ title: 'Unrelated preview Briefing' }, { title: 'Unrelated preview Briefing 2' }, { title: 'Unrelated preview Briefing 3' }]);
    projected.close();

    const afterFirst = fileHash(targetDb);
    const secondResult = await runLauncherExport("materializeProjectedBriefingDemo", {
      worktree: source.worktree,
      previewRoot: targetRoot,
      db: targetDb,
      sourceDb: source.db,
    });
    expect(secondResult.status, secondResult.stderr).toBe(0);
    const second = JSON.parse(secondResult.stdout);
    expect(second.result).toBe("already-present");
    expect(second.briefing).toEqual(projection.briefingDemo.briefing);
    expect(second.rounds).toEqual(projection.briefingDemo.rounds);
    expect(fileHash(targetDb)).toBe(afterFirst);
    expect(fileHash(source.db)).toBe(sourceHash);
    expect(byteInventory(sourceArtifactRoot)).toEqual(sourceArtifactInventory);
  }, 30_000);

  it("fails closed during copied-preview preparation when retired custody is not verified", async () => {
    const source = createSeedFixture();
    const retired = seedSealedRetiredDemo(source);
    const sourceDb = new SqliteDatabase(source.db);
    sourceDb.prepare("UPDATE briefing_legacy_custody SET disposition = 'sealed_ambiguous' WHERE briefing_id = ?")
      .run(retired.briefingId);
    sourceDb.pragma("wal_checkpoint(TRUNCATE)");
    sourceDb.close();
    const sourceHash = fileHash(source.db);
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-rejected-"));
    tempRoots.push(targetRoot);
    const targetDb = path.join(targetRoot, "mandible-20260819-120000.db");

    const result = await runLauncherExport("createProjectedSnapshot", {
      sourceDb: source.db,
      dbCopy: targetDb,
      worktree: source.worktree,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("partial or conflicting: retired v1 custody integrity");
    expect(fileHash(source.db)).toBe(sourceHash);
    expect(fs.existsSync(path.join(targetRoot, "rich-briefing-demo-artifacts"))).toBe(false);
    const rejectedCopy = new SqliteDatabase(targetDb, { readonly: true });
    expect(rejectedCopy.prepare("SELECT value FROM settings WHERE key = 'artifact_root'").get())
      .toEqual({ value: path.join(fs.realpathSync.native(source.previewRoot), "rich-briefing-demo-artifacts") });
    expect(rejectedCopy.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get()).toEqual({ n: 0 });
    expect(rejectedCopy.prepare("SELECT COUNT(*) AS n FROM briefing_runs").get()).toEqual({ n: 0 });
    rejectedCopy.close();
  }, 30_000);

  it("imports a sealed retired demo and then reseeds as an exact no-op", () => {
    const fixture = createSeedFixture();
    const retired = seedSealedRetiredDemo(fixture, { historicalCompatibleUsers: true });
    const sourceHash = fileHash(fixture.sourceDb);
    const sourceInventory = inventory(fixture.sourceRoot);
    const sealedArtifactInventory = byteInventory(retired.artifactRoot);
    const original = new SqliteDatabase(fixture.db, { readonly: true });
    const sealedVersions = original.prepare("SELECT id, content_hash FROM artifact_version WHERE id IN (?, ?) ORDER BY id")
      .all(...retired.artifactVersionIds);
    original.close();

    const first = runSeed(fixture);
    expect(first.status, `${first.stderr}\n${first.stdout}`).toBe(0);
    const firstPayload = JSON.parse(first.stdout);
    expect(firstPayload).toMatchObject({
      ok: true,
      status: "upgraded",
      result: "upgraded",
      schema: "mandible-rich-briefing-demo@2",
      briefing: { key: RICH_BRIEFING_DEMO.briefingKey, title: RICH_BRIEFING_DEMO.title },
      semantic_state: { round_one_frozen_answer_count: 6, round_two_answers: 0, material_revision: true },
    });
    expect(firstPayload.briefing.id).not.toBe(retired.briefingId);
    expect(firstPayload.rounds).toHaveLength(2);

    const upgraded = new SqliteDatabase(fixture.db, { readonly: true });
    expect(upgraded.prepare("SELECT title, round_count FROM briefings WHERE briefing_key = ?")
      .get(RICH_BRIEFING_DEMO.briefingKey)).toEqual({ title: RICH_BRIEFING_DEMO.title, round_count: 2 });
    expect(upgraded.prepare("SELECT title, round_count FROM briefings WHERE id = 'unrelated-briefing'").get())
      .toEqual({ title: "Unrelated preview Briefing", round_count: 0 });
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM briefing_legacy_custody WHERE briefing_id = ?")
      .get(retired.briefingId)).toEqual({ n: 0 });
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM artifact_version WHERE id IN (?, ?)")
      .get(...retired.artifactVersionIds)).toEqual({ n: 2 });
    expect(upgraded.prepare("SELECT id, content_hash FROM artifact_version WHERE id IN (?, ?) ORDER BY id")
      .all(...retired.artifactVersionIds)).toEqual(sealedVersions);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM artifact_version").get()).toEqual({ n: 4 });
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    upgraded.close();
    expect(byteInventory(retired.artifactRoot)).toEqual(expect.arrayContaining(sealedArtifactInventory));

    const afterFirst = fileHash(fixture.db);
    const second = runSeed(fixture);
    expect(second.status, `${second.stderr}\n${second.stdout}`).toBe(0);
    const secondPayload = JSON.parse(second.stdout);
    expect(secondPayload.status).toBe("already-present");
    expect(secondPayload.briefing).toEqual(firstPayload.briefing);
    expect(secondPayload.rounds).toEqual(firstPayload.rounds);
    expect(fileHash(fixture.db)).toBe(afterFirst);
    expect(fileHash(fixture.sourceDb)).toBe(sourceHash);
    expect(inventory(fixture.sourceRoot)).toEqual(sourceInventory);
  }, 30_000);

  it("keeps an unverified zero-round demo shell fail-closed and byte-identical", () => {
    const fixture = createSeedFixture();
    const retired = seedSealedRetiredDemo(fixture);
    const db = new SqliteDatabase(fixture.db);
    db.prepare("UPDATE briefing_legacy_custody SET disposition = 'sealed_ambiguous' WHERE briefing_id = ?")
      .run(retired.briefingId);
    db.close();
    const before = fileHash(fixture.db);
    const sourceHash = fileHash(fixture.sourceDb);

    const result = runSeed(fixture);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("partial or conflicting: retired v1 custody integrity");
    expect(fileHash(fixture.db)).toBe(before);
    expect(fileHash(fixture.sourceDb)).toBe(sourceHash);
  }, 30_000);

  it("seeds only the metadata-owned preview copy and repeats as an exact no-op without port access", () => {
    const fixture = createSeedFixture();
    const sourceHash = fileHash(fixture.sourceDb);
    const sourceInventory = inventory(fixture.sourceRoot);

    const first = runSeed(fixture);
    expect(first.status, first.stderr).toBe(0);
    const firstPayload = JSON.parse(first.stdout);
    expect(firstPayload).toMatchObject({
      ok: true,
      status: "seeded",
      result: "seeded",
      db: fs.realpathSync.native(fixture.db),
      sourceDb: fs.realpathSync.native(fixture.sourceDb),
      artifactRoot: path.join(fs.realpathSync.native(fixture.previewRoot), "rich-briefing-demo-artifacts"),
      briefing: { title: "Release candidate readiness review" },
      schema: "mandible-rich-briefing-demo@2",
      semantic_state: {
        round_one_frozen_answer_count: 6,
        round_one_frozen_annotation_count: 2,
        round_two_answers: 0,
        round_two_annotations: 0,
        round_two_submission: null,
        material_revision: true,
      },
    });
    expect(firstPayload.rounds).toHaveLength(2);
    const dbAfterFirst = fileHash(fixture.db);
    const countsAfterFirst = new SqliteDatabase(fixture.db, { readonly: true });
    const firstCounts = {
      briefings: countsAfterFirst.prepare("SELECT COUNT(*) AS n FROM briefings").get(),
      rounds: countsAfterFirst.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get(),
      answers: countsAfterFirst.prepare("SELECT COUNT(*) AS n FROM briefing_response_events").get(),
      annotations: countsAfterFirst.prepare("SELECT COUNT(*) AS n FROM briefing_annotation_events").get(),
      submissions: countsAfterFirst.prepare("SELECT COUNT(*) AS n FROM briefing_submissions").get(),
      versions: countsAfterFirst.prepare("SELECT COUNT(*) AS n FROM artifact_version").get(),
    };
    countsAfterFirst.close();

    const second = runSeed(fixture);
    expect(second.status, `${second.stderr}\n${second.stdout}`).toBe(0);
    const secondPayload = JSON.parse(second.stdout);
    expect(secondPayload.status).toBe("already-present");
    expect(secondPayload.briefing.id).toBe(firstPayload.briefing.id);
    expect(secondPayload.rounds).toEqual(firstPayload.rounds);
    expect(fileHash(fixture.db)).toBe(dbAfterFirst);
    const dbAfterSecond = new SqliteDatabase(fixture.db, { readonly: true });
    expect({
      briefings: dbAfterSecond.prepare("SELECT COUNT(*) AS n FROM briefings").get(),
      rounds: dbAfterSecond.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get(),
      answers: dbAfterSecond.prepare("SELECT COUNT(*) AS n FROM briefing_response_events").get(),
      annotations: dbAfterSecond.prepare("SELECT COUNT(*) AS n FROM briefing_annotation_events").get(),
      submissions: dbAfterSecond.prepare("SELECT COUNT(*) AS n FROM briefing_submissions").get(),
      versions: dbAfterSecond.prepare("SELECT COUNT(*) AS n FROM artifact_version").get(),
    }).toEqual(firstCounts);
    dbAfterSecond.close();
    expect(firstCounts).toEqual({
      briefings: { n: 1 }, rounds: { n: 2 }, answers: { n: 6 }, annotations: { n: 2 },
      submissions: { n: 1 }, versions: { n: 2 },
    });
    expect(fileHash(fixture.sourceDb)).toBe(sourceHash);
    expect(inventory(fixture.sourceRoot)).toEqual(sourceInventory);

    const conflicting = new SqliteDatabase(fixture.db);
    conflicting.prepare("UPDATE users SET status = 'retired' WHERE slug = 'briefing-demo-reviewer'").run();
    conflicting.close();
    const beforeConflictCheck = fileHash(fixture.db);
    const conflictResult = runSeed(fixture);
    expect(conflictResult.status).toBe(1);
    expect(conflictResult.stdout).toContain("partial or conflicting");
    expect(fileHash(fixture.db)).toBe(beforeConflictCheck);
    expect(fileHash(fixture.sourceDb)).toBe(sourceHash);
    expect(inventory(fixture.sourceRoot)).toEqual(sourceInventory);
  }, 30_000);

  it.each([
    ["branch drift", (fixture: ReturnType<typeof createSeedFixture>) => ({ ...fixture.metadata, branch: "integration/unrelated" })],
    ["worktree drift", (fixture: ReturnType<typeof createSeedFixture>) => ({ ...fixture.metadata, worktree: path.dirname(fixture.worktree) })],
    ["previewRoot drift", (fixture: ReturnType<typeof createSeedFixture>) => ({ ...fixture.metadata, previewRoot: fixture.sourceRoot })],
    ["metadata policy drift", (fixture: ReturnType<typeof createSeedFixture>) => ({
      ...fixture.metadata,
      health: { instance: { ...fixture.metadata.health.instance, role: "main" } },
    })],
    ["database env drift", (fixture: ReturnType<typeof createSeedFixture>) => ({
      ...fixture.metadata,
      instanceEnv: { ...fixture.metadata.instanceEnv, MANDIBLE_DB: fixture.sourceDb },
    })],
    ["source env drift", (fixture: ReturnType<typeof createSeedFixture>) => ({
      ...fixture.metadata,
      instanceEnv: { ...fixture.metadata.instanceEnv, MANDIBLE_INSTANCE_SOURCE_DB: fixture.db },
    })],
  ])("refuses %s before demo seed side effects", (_name, mutate) => {
    const fixture = createSeedFixture();
    const sourceHash = fileHash(fixture.sourceDb);
    const sourceInventory = inventory(fixture.sourceRoot);
    fs.writeFileSync(fixture.metadataPath, JSON.stringify(mutate(fixture)), "utf8");
    const before = fileHash(fixture.db);
    const result = runSeed(fixture);
    expect(result.status).toBe(1);
    expect(fileHash(fixture.db)).toBe(before);
    expect(fs.existsSync(path.join(fixture.previewRoot, "rich-briefing-demo-artifacts"))).toBe(false);
    expect(fileHash(fixture.sourceDb)).toBe(sourceHash);
    expect(inventory(fixture.sourceRoot)).toEqual(sourceInventory);
  }, 30_000);

  it("refuses missing metadata, current.db drift, targets outside custody, source aliases, and arbitrary --db", () => {
    const cases: Array<(fixture: ReturnType<typeof createSeedFixture>) => string[]> = [
      (fixture) => { fs.rmSync(fixture.metadataPath); return []; },
      (fixture) => {
        fs.unlinkSync(path.join(fixture.previewRoot, "current.db"));
        const other = path.join(fixture.previewRoot, "other.db");
        fs.writeFileSync(other, "other", "utf8");
        fs.symlinkSync(other, path.join(fixture.previewRoot, "current.db"));
        return [];
      },
      (fixture) => {
        const metadata = { ...fixture.metadata, db: fixture.sourceDb,
          instanceEnv: { ...fixture.metadata.instanceEnv, MANDIBLE_DB: fixture.sourceDb } };
        fs.writeFileSync(fixture.metadataPath, JSON.stringify(metadata), "utf8");
        fs.unlinkSync(path.join(fixture.previewRoot, "current.db"));
        fs.symlinkSync(fixture.sourceDb, path.join(fixture.previewRoot, "current.db"));
        return [];
      },
      (fixture) => {
        const alias = path.join(fixture.sourceRoot, "target-alias.db");
        fs.symlinkSync(fixture.db, alias);
        const metadata = { ...fixture.metadata, sourceDb: alias,
          instanceEnv: { ...fixture.metadata.instanceEnv, MANDIBLE_INSTANCE_SOURCE_DB: alias } };
        fs.writeFileSync(fixture.metadataPath, JSON.stringify(metadata), "utf8");
        return [];
      },
      () => ["--db", "/tmp/not-allowed.db"],
    ];
    for (const arrange of cases) {
      const fixture = createSeedFixture();
      const arrangedArgs = arrange(fixture);
      const sourceHash = fileHash(fixture.sourceDb);
      const sourceInventory = inventory(fixture.sourceRoot);
      const before = fileHash(fixture.db);
      const result = runSeed(fixture, arrangedArgs);
      expect(result.status).toBe(1);
      expect(fileHash(fixture.db)).toBe(before);
      expect(fs.existsSync(path.join(fixture.previewRoot, "rich-briefing-demo-artifacts"))).toBe(false);
      expect(fileHash(fixture.sourceDb)).toBe(sourceHash);
      expect(inventory(fixture.sourceRoot)).toEqual(sourceInventory);
    }
  }, 30_000);

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
      env: previewLauncherEnv(previewBase),
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const previewConversations = path.join(previewRoot, "conversations");
    expect(payload.instanceEnv).toMatchObject({
      MANDIBLE_INSTANCE_ROLE: "preview",
      MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
      MANDIBLE_INSTANCE_SOURCE_DB: sourceDb,
      MANDIBLE_ARTIFACT_DIR: path.join(previewRoot, "artifacts"),
      MANDIBLE_USER_PREFERENCES_DIR: path.join(previewRoot, "settings", "users"),
      MANDIBLE_FILE_RPC_DIR: path.join(previewRoot, "agent-rpc"),
      MANDIBLE_CONFIG_DIR: path.join(previewRoot, "config"),
      MANDIBLE_CONVERSATION_STRUCTURE_DB: path.join(previewConversations, "structure.db"),
      MANDIBLE_CONVERSATION_CACHE_DB: path.join(previewConversations, "search-cache.db"),
      MANDIBLE_STDERR_LOG_PATH: path.join(previewRoot, "stderr.log"),
      MANDIBLE_CLI_CACHE_DIR: path.join(previewRoot, "cli"),
    });
    // Preview writable state stays under this instance's root.
    // preview used to open the live conversations index read-write on the same
    // inode as the live daemon, rotate the live daemon's log file on its own
    // timer, and overwrite every file in the shared CLI cache. Every writable
    // path must sit under the preview root.
    const sharedCache = path.join(os.homedir(), ".cache", "mandible");
    expect(payload.instanceEnv.MANDIBLE_CONVERSATION_STRUCTURE_DB)
      .not.toBe(path.join(sharedCache, "conversations", "structure.db"));
    expect(payload.instanceEnv.MANDIBLE_CONVERSATION_CACHE_DB)
      .not.toBe(path.join(sharedCache, "conversations", "search-cache.db"));
    expect(payload.instanceEnv.MANDIBLE_STDERR_LOG_PATH)
      .not.toBe(path.join(sharedCache, "launchd-stderr.log"));
    expect(payload.instanceEnv.MANDIBLE_CLI_CACHE_DIR)
      .not.toBe(path.join(sharedCache, "cli"));
    for (const key of [
      "MANDIBLE_CONVERSATION_STRUCTURE_DB",
      "MANDIBLE_CONVERSATION_CACHE_DB",
      "MANDIBLE_STDERR_LOG_PATH",
      "MANDIBLE_CLI_CACHE_DIR",
      "MANDIBLE_ARTIFACT_DIR",
      "MANDIBLE_USER_PREFERENCES_DIR",
    ]) {
      expect(String(payload.instanceEnv[key]).startsWith(`${previewRoot}${path.sep}`)).toBe(true);
    }

    expect(payload.wouldCopyDb).toBe(false);
    expect(payload.wouldProjectDb).toBe(true);
    expect(payload.projection).toMatchObject({
      logs: expect.stringContaining("24h"),
      conversations: expect.stringContaining("whole"),
      conversationTitleConvergence: expect.stringContaining("before daemon start"),
    });
  });

  it("seeds user preferences once, preserves preview edits, and rejects an unsafe target", () => {
    const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-preferences-"));
    tempRoots.push(previewBase);
    const sourceRoot = path.join(previewBase, "production", "settings", "users");
    const previewRoot = path.join(previewBase, "integration-preview");
    fs.mkdirSync(sourceRoot, { recursive: true });
    const originalTheme = JSON.stringify({
      version: 1, userId: "user-one", revision: 1,
      settings: { chatShownProjects: [], appTheme: "light" },
    });
    const originalOrder = JSON.stringify({
      version: 1, userId: "user-one", revision: 1,
      value: { pinnedConversationIds: ["conversation-production"], briefingTopLevelIds: null },
    });
    fs.writeFileSync(path.join(sourceRoot, "user-one.json"), originalTheme, { mode: 0o600 });
    fs.writeFileSync(path.join(sourceRoot, "user-one.sidebar-order.json"), originalOrder, { mode: 0o600 });

    expect(seedPreviewUserPreferences({ previewRoot, sourceRoot })).toMatchObject({
      sourceMissing: false,
      copied: ["user-one.json", "user-one.sidebar-order.json"],
      preserved: [],
    });
    const targetRoot = path.join(previewRoot, "settings", "users");
    const previewTheme = JSON.stringify({
      version: 1, userId: "user-one", revision: 2,
      settings: { chatShownProjects: [], appTheme: "dark" },
    });
    fs.writeFileSync(path.join(targetRoot, "user-one.json"), previewTheme, { mode: 0o600 });
    const previewOrder = JSON.stringify({
      version: 1, userId: "user-one", revision: 2,
      value: { pinnedConversationIds: ["conversation-preview"], briefingTopLevelIds: null },
    });
    fs.writeFileSync(path.join(targetRoot, "user-one.sidebar-order.json"), previewOrder, { mode: 0o600 });
    const changedProductionTheme = JSON.stringify({
      version: 1, userId: "user-one", revision: 2,
      settings: { chatShownProjects: [], appTheme: "system" },
    });
    fs.writeFileSync(path.join(sourceRoot, "user-one.json"), changedProductionTheme, { mode: 0o600 });
    fs.writeFileSync(path.join(sourceRoot, "user-two.json"), JSON.stringify({
      version: 1, userId: "user-two", revision: 1,
      settings: { chatShownProjects: [], appTheme: "dark" },
    }), { mode: 0o600 });

    expect(seedPreviewUserPreferences({ previewRoot, sourceRoot })).toMatchObject({
      copied: ["user-two.json"],
      preserved: ["user-one.json", "user-one.sidebar-order.json"],
    });
    expect(fs.readFileSync(path.join(targetRoot, "user-one.json"), "utf8")).toBe(previewTheme);
    expect(fs.readFileSync(path.join(sourceRoot, "user-one.json"), "utf8")).toBe(changedProductionTheme);
    expect(fs.readFileSync(path.join(targetRoot, "user-one.sidebar-order.json"), "utf8")).toBe(previewOrder);

    const unsafeRoot = path.join(previewBase, "unsafe-preview");
    fs.mkdirSync(path.join(unsafeRoot, "settings"), { recursive: true });
    fs.symlinkSync(sourceRoot, path.join(unsafeRoot, "settings", "users"), "dir");
    expect(() => seedPreviewUserPreferences({ previewRoot: unsafeRoot, sourceRoot }))
      .toThrow("preview user-preferences directory is a symlink");
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

    await expect(execFileAsync(process.execPath, [
      SCRIPT,
      "--dry-run",
      "--json",
    ], {
      cwd: repo,
      encoding: "utf8",
      env: previewLauncherEnv(previewBase),
    })).rejects.toMatchObject({ code: 1 });
  });

  it("requires explicit retirement of the exact legacy preview instead of allocating another origin", async () => {
    const repo = createRepo();
    git(["checkout", "-b", "integration/test-preview"], repo);
    const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-cache-"));
    tempRoots.push(previewBase);
    const previewRoot = path.join(previewBase, "integration-test-preview");
    const fileRpcDir = path.join(previewRoot, "agent-rpc");
    const credentialDir = path.join(previewBase, "mandible-home", "preview-authorities", "integration-test-preview", "client-auth");
    fs.mkdirSync(fileRpcDir, { recursive: true });
    fs.mkdirSync(credentialDir, { recursive: true });
    const db = path.join(previewRoot, "mandible-legacy.db");
    const sourceDb = path.join(repo, "source.db");
    const pidFile = path.join(previewRoot, "mandible.pid");
    fs.writeFileSync(db, "legacy copy");
    fs.writeFileSync(sourceDb, "source");
    fs.writeFileSync(pidFile, `${process.pid}\n`);
    fs.symlinkSync(db, path.join(previewRoot, "current.db"));
    const port = await listenForHealth({
      ready: true,
      warm: true,
      startup_epoch: "legacy-preview",
      startup_commit: { hash: gitOutput(["rev-parse", "HEAD"], repo), summary: "legacy", date: "" },
      instance: {
        role: "preview",
        operational_mutations: "reject",
        db_path: db,
        db_path_source: "iab-preview-copy",
        source_db_path: sourceDb,
      },
      file_rpc_dir: fileRpcDir,
    });
    const instanceEnv = previewContractEnv({ port, db, sourceDb, previewRoot, pidFile });
    for (const key of [
      "MANDIBLE_INSTANCE_ID",
      "MANDIBLE_INSTALLATION_ID",
      "MANDIBLE_PUBLIC_ORIGIN",
      "MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR",
      "MANDIBLE_CONTEXT_VERIFICATION_KEY",
      "MANDIBLE_ARTIFACT_DIR",
      "MANDIBLE_INSTANCE_SOURCE_ARTIFACT_DIR",
      "MANDIBLE_ALLOWED_EFFECTS",
      "MANDIBLE_WRITABLE_ROOTS",
    ]) delete instanceEnv[key];
    fs.writeFileSync(path.join(previewRoot, "metadata.json"), JSON.stringify({
      branch: "integration/test-preview",
      worktree: repo,
      port,
      db,
      sourceDb,
      previewRoot,
      instanceEnv,
    }));

    const launcherEnv = previewLauncherEnv(previewBase);
    const previousBase = process.env.MANDIBLE_PREVIEW_BASE_DIR;
    const previousHome = process.env.MANDIBLE_HOME;
    process.env.MANDIBLE_PREVIEW_BASE_DIR = previewBase;
    process.env.MANDIBLE_HOME = path.join(previewBase, "mandible-home");
    try {
      const launcher = await import(`${pathToFileURL(SCRIPT).href}?legacy-cutover=${Date.now()}`);
      await expect(launcher.healthyExistingPreview("integration/test-preview", { worktree: repo })).rejects.toThrow();
    } finally {
      if (previousBase === undefined) delete process.env.MANDIBLE_PREVIEW_BASE_DIR;
      else process.env.MANDIBLE_PREVIEW_BASE_DIR = previousBase;
      if (previousHome === undefined) delete process.env.MANDIBLE_HOME;
      else process.env.MANDIBLE_HOME = previousHome;
    }

    const result = await execFileAsync(process.execPath, [SCRIPT, "--json", "--no-build"], {
      cwd: repo,
      encoding: "utf8",
      env: launcherEnv,
    }).then(
      () => { throw new Error("legacy preview launch unexpectedly succeeded"); },
      (error: { stdout?: string }) => error,
    );
    expect(JSON.parse(result.stdout ?? "{}").error).toContain("owned run lifecycle");
    expect(fs.readdirSync(previewRoot).filter((entry) => entry.startsWith("mandible-"))).toEqual(["mandible-legacy.db"]);
  });

  it("checks the cutover journal before launchd cleanup or existing-preview refresh", () => {
    const repo = createRepo();
    git(["checkout", "-b", "integration/test-preview"], repo);
    const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-cache-"));
    tempRoots.push(previewBase);
    const env = previewLauncherEnv(previewBase);
    const authorityDir = path.join(env.MANDIBLE_HOME, "config", "local-sessions");
    fs.mkdirSync(authorityDir, { recursive: true });
    fs.writeFileSync(path.join(authorityDir, "cutover.json"), JSON.stringify({ schema: "mandible-local-session-cutover@1", state: "activating" }));
    const commandLog = path.join(previewBase, "launchctl.log");
    const launchctlShim = path.join(previewBase, "launchctl");
    fs.writeFileSync(launchctlShim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(commandLog)}\n`);
    fs.chmodSync(launchctlShim, 0o755);

    const result = spawnSync(process.execPath, [SCRIPT, "--json", "--dry-run"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...env, MANDIBLE_IAB_PREVIEW_LAUNCHCTL: launchctlShim },
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain("cutover is activating");
    expect(fs.existsSync(commandLog)).toBe(false);
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
        allowed_effects: ["ledger:read", "ledger:write", "files:preview", "preferences:instance"],
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

    await expect(execFileAsync(process.execPath, [
      SCRIPT,
      "--dry-run",
      "--json",
    ], {
      cwd: repo,
      encoding: "utf8",
      env: previewLauncherEnv(previewBase),
    })).rejects.toMatchObject({ code: 1 });
  });

  it("rejects health-200/root-404 listeners for reuse and cleanup readiness", async () => {
    const repo = createRepo();
    git(["checkout", "-b", "integration/test-preview"], repo);
    const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-cache-"));
    tempRoots.push(previewBase);
    const previewRoot = path.join(previewBase, "integration-test-preview");
    const fileRpcDir = path.join(previewRoot, "agent-rpc");
    fs.mkdirSync(fileRpcDir, { recursive: true });
    const db = path.join(previewRoot, "mandible-20260818-100000.db");
    const sourceDb = path.join(repo, "source.db");
    const pidFile = path.join(previewRoot, "mandible.pid");
    fs.writeFileSync(db, "preview database", "utf8");
    fs.writeFileSync(sourceDb, "source database", "utf8");
    fs.writeFileSync(pidFile, `${UNREACHABLE_PID}\n`, "utf8");
    fs.symlinkSync(db, path.join(previewRoot, "current.db"));
    const currentHead = gitOutput(["rev-parse", "HEAD"], repo);
    const port = await listenForHealth({
      ready: true,
      warm: true,
      startup_commit: { hash: currentHead, summary: "current", date: "" },
      instance: {
        role: "preview",
        allowed_effects: ["ledger:read", "ledger:write", "files:preview", "preferences:instance"],
        operational_mutations: "reject",
        preview_browser_enrollment: "allow",
        db_path: db,
        db_path_source: "iab-preview-copy",
        source_db_path: sourceDb,
      },
      file_rpc_dir: fileRpcDir,
    }, undefined, { applicationShell: false });
    fs.writeFileSync(path.join(previewRoot, "metadata.json"), JSON.stringify({
      status: "started",
      branch: "integration/test-preview",
      worktree: repo,
      port,
      db,
      sourceDb,
      previewRoot,
      pidFile,
      instanceEnv: previewContractEnv({ port, db, sourceDb, previewRoot, pidFile }),
    }), "utf8");

    const reuse = await execFileAsync(process.execPath, [SCRIPT, "--dry-run", "--json"], {
      cwd: repo,
      encoding: "utf8",
      env: previewLauncherEnv(previewBase),
    }).then(() => { throw new Error("Unverified live preview was accepted"); }, error => error);
    expect(JSON.parse(reuse.stdout)).toMatchObject({
      ok: false,
      error: expect.stringContaining("application root returned HTTP 404"),
    });
    expect(reuse.stdout).not.toContain("Stopped preview material");

    const cleanup = await execFileAsync(process.execPath, [
      SCRIPT, "cleanup", "--preview-base-dir", previewBase, "--json",
    ], { cwd: repo, encoding: "utf8", env: process.env });
    const entry = JSON.parse(cleanup.stdout).entries.find((candidate: { path: string }) => {
      return candidate.path === previewRoot;
    });
    expect(entry).toMatchObject({
      action: "skip-active",
    });
    expect(entry.reason).toContain("recorded port has a consumer");
    expect(entry.reason).not.toContain("passed health and application shell readiness");
  });

  it("keeps fresh-start readiness pending until the exact isolated preview is warm", async () => {
    const previewRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-start-readiness-"));
    tempRoots.push(previewRoot);
    const db = path.join(previewRoot, "current.db");
    const sourceDb = path.join(previewRoot, "source.db");
    const head = "b".repeat(40);
    const health = {
      ready: true,
      warm: false,
      startup_commit: { hash: head, summary: "current", date: "" },
      instance: {
        role: "preview",
        allowed_effects: ["ledger:read", "ledger:write", "files:preview", "preferences:instance"],
        operational_mutations: "reject",
        preview_browser_enrollment: "allow",
        db_path: db,
        db_path_source: "iab-preview-copy",
        source_db_path: sourceDb,
      },
      file_rpc_dir: path.join(previewRoot, "agent-rpc"),
    };
    const port = await listenForHealth(health);
    const source = `
      const launcher = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});
      const health = await launcher.waitForPreviewReadiness(
        ${port},
        ${JSON.stringify({ head, dbCopy: db, sourceDb, previewRoot })},
        5_000,
        ${JSON.stringify(path.join(previewRoot, "stderr.log"))},
      );
      process.stdout.write(JSON.stringify(health));
    `;
    const readiness = execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: process.cwd(), encoding: "utf8",
    });

    let settled = false;
    void readiness.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(settled).toBe(false);
    health.warm = true;

    const result = await readiness;
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: true, warm: true });
  });

  it("emits no browser URL when preview metadata has no registered public origin", async () => {
    const previewRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-enrollment-"));
    tempRoots.push(previewRoot);
    const proofPath = path.join(previewRoot, "preview-browser-enrollment.json");
    const pidFile = path.join(previewRoot, "mandible.pid");
    const startupEpoch = "preview-fail-closed-fixture";
    fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
    fs.writeFileSync(proofPath, JSON.stringify({
      version: 1, pid: process.pid, startup_epoch: startupEpoch, token: "preview process proof",
    }), { mode: 0o600 });
    const health = {
      startup_epoch: startupEpoch,
      instance: {
        role: "preview", allowed_effects: ["ledger:read", "ledger:write", "files:preview", "preferences:instance"], preview_browser_enrollment: "allow",
      },
    };
    const port = await listenForHealth(health, proofPath, { verifiedHuman: false });
    const source = `
      const launcher = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});
      try {
        const result = await launcher.withBrowserReadyUrl(${JSON.stringify({
          port, pidFile, previewRoot, health,
        })}, { pairBrowser: true });
        process.stdout.write(JSON.stringify({ ok: true, result }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
      }
    `;
    const result = await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: process.cwd(), encoding: "utf8",
    });
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: false, error: expect.stringContaining("no registered public origin") });
    expect(payload.freshUrl).toBeUndefined();
  });

  it("refuses to race an unverified process on an explicitly requested port", async () => {
    const repo = createRepo();
    git(["checkout", "-b", "integration/test-preview"], repo);
    const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-occupied-"));
    tempRoots.push(previewBase, `${previewBase}.authorities`);
    const occupiedPort = await listenForHealth({ unexpected: true });
    const source = path.join(repo, "source.db"); fs.writeFileSync(source, "source bytes");
    const env = previewLauncherEnv(previewBase);
    fs.writeFileSync(path.join(env.MANDIBLE_HOME!, "config/local-sessions/Caddyfile"), "fixture");

    await expect(execFileAsync(process.execPath, [
      SCRIPT,
      "--json",
      "--no-build", "--owner-project", "fixture", "--owner-work-unit", "fixture-unit",
      "--db",
      source,
      "--port",
      String(occupiedPort),
    ], {
      cwd: repo,
      encoding: "utf8",
      env,
    })).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining(`port ${occupiedPort} is already occupied`),
    });
  });

  it("reports registered preview services without stopping them or the live daemon", () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-launchctl-"));
    const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-cache-"));
    tempRoots.push(shimDir, previewBase);
    const commandLog = path.join(shimDir, "launchctl.log");
    const launchctlShim = path.join(shimDir, "launchctl");
    fs.writeFileSync(launchctlShim, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${commandLog}'`,
      'if [ "$1" = "list" ]; then',
      "  printf '%s\\t%s\\t%s\\n' 'PID' 'Status' 'Label'",
      "  printf '%s\\t%s\\t%s\\n' '4242' '0' 'bio.mll.mandible.preview.19421.foo'",
      "  printf '%s\\t%s\\t%s\\n' '45805' '0' 'com.mll.mandible'",
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"), { mode: 0o755 });

    const result = spawnSync(process.execPath, [
      SCRIPT, "cleanup", "--apply", "--json", "--preview-base-dir", previewBase,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, MANDIBLE_IAB_PREVIEW_LAUNCHCTL: launchctlShim },
    });

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.legacyLaunchdCleanup).toMatchObject({
      supported: true,
      labels: ["bio.mll.mandible.preview.19421.foo"],
      booted: [],
    });

    const log = fs.readFileSync(commandLog, "utf8");
    expect(log).toBe("list\n");
    // Safety-critical: com.mll.mandible supervises the live Mandible daemon.
    // Booting it out would stop the user's daemon, so no launchctl subcommand
    // may ever name a label outside the preview namespace.
    expect(log).not.toContain("com.mll.mandible");
  });
});
