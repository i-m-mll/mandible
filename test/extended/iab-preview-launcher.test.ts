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
import { retireBriefingV1ToCustody } from "../../src/feedback/migrate-legacy.js";
import { RICH_BRIEFING_DEMO } from "../../src/feedback/rich-briefing-demo.js";
import { recordArtifactVersion } from "../helpers/artifact-http-write-fixtures.js";
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

function parseRetiredV1TestDirectives(source: string) {
  const directives: Array<{
    key: string; required: boolean; body: string; definition_digest: string;
    start_offset: number; end_offset: number; body_start_offset: number; body_end_offset: number;
  }> = [];
  let start = source.indexOf(":::spec-item{");
  while (start >= 0) {
    const openerEnd = source.indexOf("\n", start);
    const closeStart = source.indexOf("\n:::", openerEnd);
    const opener = source.slice(start, openerEnd);
    const key = /key="([^"]+)"/.exec(opener)?.[1];
    if (!key || closeStart < 0) throw new Error("retired v1 test directive is malformed");
    const end = closeStart + 4;
    directives.push({
      key, required: opener.includes('required="true"'), body: source.slice(openerEnd + 1, closeStart),
      definition_digest: createHash("sha256").update(Buffer.from(source.slice(start, end), "utf8")).digest("hex"),
      start_offset: start, end_offset: end, body_start_offset: openerEnd + 1, body_end_offset: closeStart,
    });
    start = source.indexOf(":::spec-item{", end);
  }
  return directives;
}

function installRetiredV1Demo(
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
  const roundIds = [randomUUID(), randomUUID()];
  // The historical run-request parser trimmed the template's final newline
  // before artifact storage. These are the exact bytes sealed in the live packet.
  const sources = [RETIRED_V1_ROUND_ONE, RETIRED_V1_ROUND_TWO].map((source) => source.trim());
  expect(sources.map((source) => [Buffer.byteLength(source), fileHashFromText(source)])).toEqual([
    [1167, "62156b992d889cae31607c21cff9c0c51151811caaf634e39327624b1e4c47b8"],
    [1282, "b49e87df635f59d955e819ee22768b374d4b7d37a9cd52de9eb72cdc9d963801"],
  ]);
  const artifacts = sources.map((source, index) => recordArtifactVersion(db, {
    source_kind: "managed", content: source, series_key: `mandible:briefing:${briefingId}`,
    logical_name: `${RICH_BRIEFING_DEMO.briefingKey}.md`, title: RICH_BRIEFING_DEMO.title,
    role: "briefing-document", media_type: "text/markdown",
    metadata: { profile: "mandible-briefing.v1", briefing_id: briefingId },
    parent_version_id: index === 0 ? null : undefined,
  }, index === 0 ? RICH_BRIEFING_DEMO.roundOneTimestamp : RICH_BRIEFING_DEMO.roundTwoTimestamp));
  db.pragma("foreign_keys = OFF");
  for (const table of [
    "briefing_submission_annotations", "briefing_submission_answers", "briefing_submissions",
    "briefing_annotation_events", "briefing_response_events", "briefing_run_occurrences",
    "briefing_runs", "briefing_directive_instances", "briefing_directive_definitions", "briefing_rounds",
    "briefing_legacy_custody",
  ]) db.exec(`DROP TABLE ${table}`);
  db.exec(`
    CREATE TABLE briefing_rounds (
      id TEXT PRIMARY KEY, briefing_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      artifact_version_id TEXT NOT NULL, previous_round_id TEXT,
      profile TEXT NOT NULL CHECK(profile = 'mandible-briefing.v1'),
      binding_digest TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_directive_definitions (
      id TEXT PRIMARY KEY, artifact_version_id TEXT NOT NULL, directive_key TEXT NOT NULL,
      definition_digest TEXT NOT NULL, response_type TEXT NOT NULL, required INTEGER NOT NULL,
      prompt TEXT NOT NULL, options_json TEXT NOT NULL, start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL, body_start_offset INTEGER NOT NULL,
      body_end_offset INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_directive_instances (
      id TEXT PRIMARY KEY, round_id TEXT NOT NULL, definition_id TEXT NOT NULL,
      directive_key TEXT NOT NULL, position INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_runs (
      id TEXT PRIMARY KEY, briefing_id TEXT NOT NULL, round_id TEXT, artifact_version_id TEXT,
      publisher_user_id TEXT NOT NULL, task_identity TEXT NOT NULL, run_id TEXT NOT NULL,
      run_key TEXT NOT NULL, request_digest TEXT NOT NULL, evidence_series_ref TEXT NOT NULL,
      evidence_version INTEGER NOT NULL, evidence_digest TEXT NOT NULL, source_health_json TEXT NOT NULL,
      quiet INTEGER NOT NULL, quiet_reason TEXT, received_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_run_occurrences (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, directive_instance_id TEXT,
      directive_key TEXT NOT NULL, evidence_digest TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE TABLE briefing_response_events (
      id TEXT PRIMARY KEY, round_id TEXT NOT NULL, directive_instance_id TEXT NOT NULL,
      operation TEXT NOT NULL, value_json TEXT, retracts_event_id TEXT,
      actor_user_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_annotation_events (
      id TEXT PRIMARY KEY, round_id TEXT NOT NULL, operation TEXT NOT NULL, annotation_kind TEXT,
      start_offset INTEGER, end_offset INTEGER, quote TEXT, body TEXT, replacement_text TEXT,
      retracts_event_id TEXT, actor_user_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_submissions (
      id TEXT PRIMARY KEY, round_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      supersedes_submission_id TEXT, actor_user_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_submission_answers (
      submission_id TEXT NOT NULL, directive_instance_id TEXT NOT NULL,
      response_event_id TEXT NOT NULL, position INTEGER NOT NULL
    );
    CREATE TABLE briefing_submission_annotations (
      submission_id TEXT NOT NULL, annotation_event_id TEXT NOT NULL, position INTEGER NOT NULL
    );
  `);
  db.pragma("foreign_keys = ON");

  db.prepare(
    `INSERT INTO briefings (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 2, ?, ?)`,
  ).run(briefingId, RICH_BRIEFING_DEMO.briefingKey, RICH_BRIEFING_DEMO.title, roundIds[1],
    RICH_BRIEFING_DEMO.roundOneTimestamp, RICH_BRIEFING_DEMO.roundTwoTimestamp);
  db.prepare("INSERT INTO briefing_members (briefing_id, user_id, created_at) VALUES (?, ?, ?)")
    .run(briefingId, reviewer.id, RICH_BRIEFING_DEMO.roundOneTimestamp);

  const parsedDirectives = sources.map((source) => parseRetiredV1TestDirectives(source));
  parsedDirectives.forEach((directives, roundIndex) => {
    const timestamp = roundIndex === 0 ? RICH_BRIEFING_DEMO.roundOneTimestamp : RICH_BRIEFING_DEMO.roundTwoTimestamp;
    const bindingDigest = createHash("sha256").update(JSON.stringify(
      directives.map((directive) => [directive.key, directive.definition_digest]),
    )).digest("hex");
    db.prepare(
      `INSERT INTO briefing_rounds
        (id, briefing_id, ordinal, artifact_version_id, previous_round_id, profile, binding_digest, created_at)
       VALUES (?, ?, ?, ?, ?, 'mandible-briefing.v1', ?, ?)`,
    ).run(roundIds[roundIndex], briefingId, roundIndex + 1, artifacts[roundIndex].version.id,
      roundIndex === 0 ? null : roundIds[0], bindingDigest, timestamp);
    directives.forEach((directive, position) => {
      const definitionId = `definition-${roundIndex}-${position}`;
      const instanceId = `instance-${roundIndex}-${position}`;
      db.prepare(
        `INSERT INTO briefing_directive_definitions
          (id, artifact_version_id, directive_key, definition_digest, response_type, required, prompt,
           options_json, start_offset, end_offset, body_start_offset, body_end_offset, created_at)
         VALUES (?, ?, ?, ?, 'verdict', ?, ?, '[]', ?, ?, ?, ?, ?)`,
      ).run(definitionId, artifacts[roundIndex].version.id, directive.key, directive.definition_digest,
        directive.required ? 1 : 0, directive.body, directive.start_offset, directive.end_offset,
        directive.body_start_offset, directive.body_end_offset, timestamp);
      db.prepare(
        `INSERT INTO briefing_directive_instances
          (id, round_id, definition_id, directive_key, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(instanceId, roundIds[roundIndex], definitionId, directive.key, position, timestamp);
    });
  });

  const runIds = ["run-1", "run-2"];
  [0, 1].forEach((roundIndex) => {
    const timestamp = roundIndex === 0 ? RICH_BRIEFING_DEMO.roundOneTimestamp : RICH_BRIEFING_DEMO.roundTwoTimestamp;
    db.prepare(
      `INSERT INTO briefing_runs
        (id, briefing_id, round_id, artifact_version_id, publisher_user_id, task_identity, run_id, run_key,
         request_digest, evidence_series_ref, evidence_version, evidence_digest, source_health_json,
         quiet, quiet_reason, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
    ).run(runIds[roundIndex], briefingId, roundIds[roundIndex], artifacts[roundIndex].version.id, publisher.id,
      RICH_BRIEFING_DEMO.taskIdentity, `release-readiness-round-${roundIndex + 1}`,
      `release-readiness-round-${roundIndex + 1}`, "a".repeat(64), RICH_BRIEFING_DEMO.evidenceSeriesRef,
      roundIndex + 1, createHash("sha256").update(
        `mandible-rich-briefing-demo:round-${roundIndex + 1}-evidence`,
      ).digest("hex"), "{}", timestamp);
    parsedDirectives[roundIndex].forEach((directive, position) => db.prepare(
      `INSERT INTO briefing_run_occurrences
        (id, run_id, directive_instance_id, directive_key, evidence_digest, occurred_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(`occurrence-${roundIndex}-${position}`, runIds[roundIndex], `instance-${roundIndex}-${position}`,
      directive.key, "e".repeat(64), timestamp - 30_000,
      JSON.stringify({ fixture: "rich-briefing-demo", round: roundIndex + 1 })));
  });

  const responseValues = new Map([
    ["scope.approval", { verdict: "keep" }], ["rollback.plan", { verdict: "dismiss" }],
    ["operator.runbook", { verdict: "keep" }],
  ]);
  const responseEvents = parsedDirectives[0].filter((directive) => responseValues.has(directive.key)).map((directive) => ({
    id: `response-${directive.key}`, directive_key: directive.key,
    directive_instance_id: `instance-0-${parsedDirectives[0].indexOf(directive)}`,
  }));
  responseEvents.forEach((event) => db.prepare(
    `INSERT INTO briefing_response_events
      (id, round_id, directive_instance_id, operation, value_json, retracts_event_id, actor_user_id, created_at)
     VALUES (?, ?, ?, 'set', ?, NULL, ?, ?)`,
  ).run(event.id, roundIds[0], event.directive_instance_id, JSON.stringify(responseValues.get(event.directive_key)),
    reviewer.id, RICH_BRIEFING_DEMO.answersTimestamp));
  const annotationEvents = [
    { id: "annotation-comment", annotation_kind: "comment", quote: "Staging rehearsal completed",
      body: "Confirm the rehearsal log is attached to the final release record.", replacement_text: null,
    },
    { id: "annotation-suggestion", annotation_kind: "suggest_replacement", quote: "15 minute recovery objective",
      body: "Use the tighter objective demonstrated by the final rehearsal.", replacement_text: "10 minute recovery objective",
    },
  ];
  annotationEvents.forEach((event) => {
    const start = RETIRED_V1_ROUND_ONE.indexOf(event.quote);
    db.prepare(
      `INSERT INTO briefing_annotation_events
        (id, round_id, operation, annotation_kind, start_offset, end_offset, quote, body, replacement_text,
         retracts_event_id, actor_user_id, created_at)
       VALUES (?, ?, 'set', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(event.id, roundIds[0], event.annotation_kind, start, start + event.quote.length, event.quote,
      event.body, event.replacement_text, reviewer.id, RICH_BRIEFING_DEMO.annotationsTimestamp);
  });
  db.prepare(
    `INSERT INTO briefing_submissions
      (id, round_id, ordinal, supersedes_submission_id, actor_user_id, created_at)
     VALUES ('submission-1', ?, 1, NULL, ?, ?)`,
  ).run(roundIds[0], reviewer.id, RICH_BRIEFING_DEMO.submissionTimestamp);
  responseEvents.forEach((event, position) => db.prepare(
    `INSERT INTO briefing_submission_answers
      (submission_id, directive_instance_id, response_event_id, position) VALUES ('submission-1', ?, ?, ?)`,
  ).run(event.directive_instance_id, event.id, position));
  annotationEvents.forEach((event, position) => db.prepare(
    `INSERT INTO briefing_submission_annotations
      (submission_id, annotation_event_id, position) VALUES ('submission-1', ?, ?)`,
  ).run(event.id, position));

  retireBriefingV1ToCustody(db, RICH_BRIEFING_DEMO.roundTwoTimestamp + 1);
  expect(db.prepare("SELECT disposition FROM briefing_legacy_custody WHERE briefing_id = ?").get(briefingId))
    .toEqual({ disposition: "sealed_verified" });
  const sealed = db.prepare(
    "SELECT packet_json FROM briefing_legacy_custody WHERE briefing_id = ?",
  ).get(briefingId) as { packet_json: string };
  const packet = JSON.parse(sealed.packet_json);
  expect(packet.row_counts).toEqual({
    annotation_events: 2, artifact_versions: 2, briefing: 1, definitions: 8, instances: 8,
    membership: 1, occurrences: 8, prior_audit: 0, response_events: 3, rounds: 2, runs: 2,
    submission_annotations: 2, submission_answers: 3, submissions: 1,
  });
  expect(packet.components.artifact_versions.map((version: any) => ({
    byte_length: version.byte_length, content_hash: version.content_hash, source_sha256: version.source_sha256,
  }))).toEqual([
    { byte_length: 1167, content_hash: "62156b992d889cae31607c21cff9c0c51151811caaf634e39327624b1e4c47b8",
      source_sha256: "62156b992d889cae31607c21cff9c0c51151811caaf634e39327624b1e4c47b8" },
    { byte_length: 1282, content_hash: "b49e87df635f59d955e819ee22768b374d4b7d37a9cd52de9eb72cdc9d963801",
      source_sha256: "b49e87df635f59d955e819ee22768b374d4b7d37a9cd52de9eb72cdc9d963801" },
  ]);
  expect(packet.components.rounds.map((round: any) => round.binding_digest)).toEqual([
    "a3880f5738aa35930026b5042b659adfc9a3e8cb9817c9444f2b4103f5f1e123",
    "95c3ff03b0638303f6b5fd108f4204fe33e3a77268fa37132977c6f63ea3cd30",
  ]);
  expect(packet.components.definitions.slice(0, 4).map((definition: any) => ({
    key: definition.directive_key, digest: definition.definition_digest,
    start: definition.start_offset, end: definition.end_offset,
  }))).toEqual([
    { key: "scope.approval", digest: "c9933e0b108f86e23ccccd5c3c40bcbda2a283de8d66bfdd567c3b30cdd43012", start: 734, end: 842 },
    { key: "rollback.plan", digest: "8b8f55ce4eb8bf147d714fb77d8c22bf89c114822bd3e3e52e47aa13b58dda74", start: 844, end: 955 },
    { key: "observability", digest: "88b7f1c0c699f04b215c0944d16bbeeadc5ede03cec790c0c91b2341b4d66a8c", start: 957, end: 1075 },
    { key: "operator.runbook", digest: "115863815aa53028b996cd613bb26ecb62f9b8154b28e33a707638aeb969c94d", start: 1077, end: 1167 },
  ]);
  expect(db.prepare("SELECT latest_round_id, round_count FROM briefings WHERE id = ?").get(briefingId))
    .toEqual({ latest_round_id: null, round_count: 0 });
  db.prepare(
    "INSERT INTO briefings (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, 1, 1)",
  ).run("unrelated-briefing", "demo.unrelated", "Unrelated preview Briefing");
  db.close();
  return { briefingId, artifactVersionIds: artifacts.map((artifact) => artifact.version.id) };
}

function fileHashFromText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
    // `dist` inside a fixture repo is a tree of symlinks into the real build.
    // Recursive removal unlinks symlinks rather than following them, so the
    // real dist is never touched.
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

function listenForDynamicHealth(
  healthPath: string,
  proofPath: string,
  restartHealthPath: string,
  restartMarkerPath: string,
  runScriptPath: string,
): Promise<number> {
  return listenForHealth(JSON.parse(fs.readFileSync(healthPath, "utf8")), proofPath).then((port) => {
    const original = previewServer!.listeners("request")[0] as http.RequestListener;
    previewServer!.removeAllListeners("request");
    let restartStarted = false;
    previewServer!.on("request", (req, res) => {
      if (req.method === "GET" && req.url === "/api/health") {
        restartStarted ||= fs.readFileSync(runScriptPath, "utf8").startsWith("#!/bin/zsh");
        if (restartStarted && !fs.existsSync(restartMarkerPath)) {
          res.writeHead(503);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        const currentPath = restartStarted ? restartHealthPath : healthPath;
        res.end(fs.readFileSync(currentPath, "utf8"));
        return;
      }
      original(req, res);
    });
    return port;
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
 * Give the fixture repo a `dist` the launcher can really execute.
 *
 * The launcher does two different things with `<worktree>/dist`: it imports the
 * genuine `db.js` and `feedback/rich-briefing-demo.js` to materialize the
 * projected briefing demo, and it executes `index.js` as the preview daemon. So
 * every real entry is symlinked through, and only `index.js` is replaced by a
 * stand-in.
 *
 * The health file paths are baked in as literals rather than passed through the
 * environment on purpose: `sanitizedLauncherEnv()` strips every `MANDIBLE_*`
 * variable from the child, so an env-carried path would arrive empty and the
 * test would pass for the wrong reason.
 */
function installStandInDaemonDist(repo: string, details: {
  healthPath: string;
  refreshedHealthPath: string;
  markerPidFile: string;
  proofPath: string;
  startupEpoch: string;
}): void {
  const realDist = path.join(process.cwd(), "dist");
  if (!fs.existsSync(path.join(realDist, "db.js"))) {
    throw new Error(`the refresh fixture needs a built dist; run the pinned Bun build first (looked in ${realDist})`);
  }
  const repoDist = path.join(repo, "dist");
  fs.mkdirSync(repoDist, { recursive: true });
  for (const entry of fs.readdirSync(realDist)) {
    if (entry === "index.js") continue;
    fs.symlinkSync(path.join(realDist, entry), path.join(repoDist, entry));
  }
  // CommonJS: the fixture repo has no package.json, so `require` is available
  // and the real dist's ESM modules still resolve through their own package.
  fs.writeFileSync(path.join(repoDist, "index.js"), [
    `const fs = require("node:fs");`,
    // The pid file is the launcher's stop contract; writing it from the
    // environment proves run.sh actually exported MANDIBLE_PID_FILE.
    `fs.writeFileSync(process.env.MANDIBLE_PID_FILE, process.pid + "\\n");`,
    // A marker only this stand-in writes, so teardown never kills a pid the
    // suite does not own.
    `fs.writeFileSync(${JSON.stringify(details.markerPidFile)}, process.pid + "\\n");`,
    `fs.writeFileSync(${JSON.stringify(details.proofPath)}, JSON.stringify({ version: 1, pid: process.pid, startup_epoch: ${JSON.stringify(details.startupEpoch)}, token: "preview process proof" }), { mode: 0o600 });`,
    `fs.copyFileSync(${JSON.stringify(details.refreshedHealthPath)}, ${JSON.stringify(details.healthPath)});`,
    `setInterval(function () {}, 1000);`,
    ``,
  ].join("\n"), "utf8");
}

async function createRefreshFixture(options: { buildFails?: boolean; legacyUserPreferences?: boolean } = {}) {
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
  openDb(db).close();
  fs.writeFileSync(sourceDb, "source database", "utf8");
  fs.symlinkSync(db, path.join(previewRoot, "current.db"));
  for (const name of ["stdout.log", "stderr.log", "run.sh", "mandible.pid"]) {
    fs.writeFileSync(path.join(previewRoot, name), name === "mandible.pid" ? `${UNREACHABLE_PID}\n` : "", "utf8");
  }
  const pidFile = path.join(previewRoot, "mandible.pid");
  const runScript = path.join(previewRoot, "run.sh");
  const markerPidFile = path.join(previewRoot, "stand-in-daemon.pid");
  standInPidFiles.push(markerPidFile);

  const healthPath = path.join(previewRoot, "health.json");
  const refreshedHealthPath = path.join(previewRoot, "refreshed-health.json");
  const proofPath = path.join(previewRoot, "preview-browser-enrollment.json");
  const startupEpoch = "preview-refresh-fixture";
  const fileRpcDir = path.join(previewRoot, "agent-rpc");
  fs.mkdirSync(path.join(previewRoot, "settings", "users"), { recursive: true });
  const instanceEnv = previewContractEnv({ port: 0, db, sourceDb, previewRoot, pidFile });
  const oldEffects = ["ledger:read", "ledger:write", "files:preview"];
  const newEffects = [...oldEffects, "preferences:instance"];
  const health = {
    ready: true,
    warm: true,
    startup_epoch: startupEpoch,
    startup_commit: { hash: oldHead, summary: "old", date: "" },
    instance: {
      role: "preview",
      instance_id: instanceEnv.MANDIBLE_INSTANCE_ID,
      installation_id: instanceEnv.MANDIBLE_INSTALLATION_ID,
      public_origin: instanceEnv.MANDIBLE_PUBLIC_ORIGIN,
      allowed_effects: options.legacyUserPreferences ? oldEffects : newEffects,
      preview_browser_enrollment: "allow",
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
    instance: { ...health.instance, allowed_effects: newEffects },
  }), "utf8");
  const port = await listenForDynamicHealth(healthPath, proofPath, refreshedHealthPath, markerPidFile, runScript);
  installStandInDaemonDist(repo, {
    healthPath, refreshedHealthPath, markerPidFile, proofPath, startupEpoch,
  });
  Object.assign(instanceEnv, previewContractEnv({ port, db, sourceDb, previewRoot, pidFile }));
  const productionPreferencesRoot = path.join(previewBase, "mandible-home", "settings", "users");
  const localPreferenceFile = path.join(previewRoot, "settings", "users", "user-one.json");
  if (options.legacyUserPreferences) {
    instanceEnv.MANDIBLE_ALLOWED_EFFECTS = JSON.stringify(oldEffects);
    delete instanceEnv.MANDIBLE_USER_PREFERENCES_DIR;
    fs.mkdirSync(productionPreferencesRoot, { recursive: true });
    fs.writeFileSync(path.join(productionPreferencesRoot, "user-one.json"), JSON.stringify({
      version: 1, userId: "user-one", revision: 1,
      settings: { chatShownProjects: [], appTheme: "light" },
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(productionPreferencesRoot, "user-two.json"), JSON.stringify({
      version: 1, userId: "user-two", revision: 1,
      settings: { chatShownProjects: [], appTheme: "system" },
    }), { mode: 0o600 });
    fs.writeFileSync(localPreferenceFile, JSON.stringify({
      version: 1, userId: "user-one", revision: 3,
      settings: { chatShownProjects: [], appTheme: "dark" },
    }), { mode: 0o600 });
  }
  const metadata = {
    ok: true,
    status: "started",
    branch: "integration/test-preview",
    worktree: repo,
    port,
    db,
    sourceDb,
    previewRoot,
    pidFile,
    stdoutLog: path.join(previewRoot, "stdout.log"),
    stderrLog: path.join(previewRoot, "stderr.log"),
    runScript,
    instanceEnv,
    health,
  };
  const metadataPath = path.join(previewRoot, "metadata.json");
  fs.writeFileSync(metadataPath, JSON.stringify(metadata), "utf8");

  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "scripts", "bun-runtime.sh"), path.join(repo, "scripts", "bun-runtime.sh"));
  fs.copyFileSync(path.join(process.cwd(), "scripts", "sqlite-runtime-install.mjs"), path.join(repo, "scripts", "sqlite-runtime-install.mjs"));
  fs.copyFileSync(path.join(process.cwd(), "scripts", "bun-runtime-lock.tsv"), path.join(repo, "scripts", "bun-runtime-lock.tsv"));
  fs.copyFileSync(path.join(process.cwd(), ".bun-version"), path.join(repo, ".bun-version"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ private: true, scripts: { build: options.buildFails ? "exit 23" : "exit 0" } }));

  return {
    repo,
    currentHead,
    oldHead,
    previewBase,
    previewRoot,
    db,
    sourceDb,
    pidFile,
    markerPidFile,
    runScript,
    metadata,
    metadataPath,
    localPreferenceFile,
    productionPreferencesRoot,
    healthPath,
    refreshedHealthPath,
    env: {
      ...previewLauncherEnv(previewBase),
      MANDIBLE_RUNTIME: process.execPath,
      MANDIBLE_PREVIEW_BASE_DIR: previewBase,
    },
  };
}

describe("iab-preview launcher", () => {
  it("creates, uses and finalizes a real disposable preview with only its compact receipt retained", async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-real-lifecycle-"))); tempRoots.push(base);
    const source = path.join(base, "source.db"); openDb(source).close();
    const before = fileHash(source);
    const env = { ...previewLauncherEnv(base), MANDIBLE_RUNTIME: process.execPath };
    const launched = await execFileAsync(process.execPath, [SCRIPT, "--no-build", "--db", source, "--disposable-fixture", "--owner-project", "fixture-project", "--owner-work-unit", "fixture-work-unit", "--json"], { cwd: process.cwd(), env, encoding: "utf8", timeout: 40000 }).catch(error => {
      throw new Error(`Real preview launch failed: ${error.stderr || error.stdout || error.message}`, { cause: error });
    });
    const preview = JSON.parse(launched.stdout);
    standInPidFiles.push(preview.pidFile);
    const health = await fetch(`http://127.0.0.1:${preview.port}/api/health`).then(response => response.json());
    expect(health.ready).toBe(true); expect(health.instance.instance_id).toBe(preview.ownership.instanceId);
    const edited = new SqliteDatabase(preview.db);
    edited.prepare("INSERT INTO settings(key,value,updated_at) VALUES('fixture-edit','unique',1)").run(); edited.close();
    fs.writeFileSync(path.join(preview.previewRoot, "artifacts", "fixture-document"), "disposable managed edits");
    const pid = readPidFile(preview.pidFile); expect(pid).not.toBeNull();
    process.kill(pid!, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (isProcessAlive(pid!) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(isProcessAlive(pid!)).toBe(false);
    const finalized = spawnSync(process.execPath, [SCRIPT, "finalize", "--root", preview.previewRoot, "--revision", String(preview.ownership.revision), "--outcome", "assessed", "--summary", "Disposable real preview interaction completed", "--json"], { cwd: process.cwd(), env, encoding: "utf8", timeout: 15000 });
    expect(finalized.status, `fixture process ${process.pid}: ${finalized.stdout || finalized.stderr}`).toBe(0);
    const result = JSON.parse(finalized.stdout);
    expect(result.status).toBe("cleaned"); expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(fs.existsSync(preview.previewRoot)).toBe(false); expect(fs.existsSync(result.receipt)).toBe(true);
    expect(fileHash(source)).toBe(before);
  }, 45000);

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
    const projectId = insertRawLedgerProject(db, { name: "review-fixture" });
    insertRawLedgerCheckout(db, { projectId, name: "review-fixture", root: fs.realpathSync(repo), conflict: "replace" });
    const operator = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" });
    setSetting(db, "user.operator_id", operator.id);
    const artifact = recordArtifactVersion(db, { source_kind: "tracked_repo", path: reviewPath,
      role: "review-document", media_type: "text/plain" });
    expect(artifact.version).toMatchObject({ source_kind: "tracked_repo", custody_mode: "link" });
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
    installRetiredV1Demo(source, { historicalCompatibleUsers: true });
    const sourceDb = new SqliteDatabase(source.db);
    for (const ordinal of [2, 3]) {
      sourceDb.prepare(
        `INSERT INTO briefings
          (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 0, ?, ?)`,
      ).run(`unrelated-briefing-${ordinal}`, `demo.unrelated.${ordinal}`, `Unrelated preview Briefing ${ordinal}`, ordinal, ordinal);
    }
    expect({
      briefings: sourceDb.prepare("SELECT COUNT(*) AS n FROM briefings").get(),
      rounds: sourceDb.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get(),
      runs: sourceDb.prepare("SELECT COUNT(*) AS n FROM briefing_runs").get(),
      occurrences: sourceDb.prepare("SELECT COUNT(*) AS n FROM briefing_run_occurrences").get(),
      responses: sourceDb.prepare("SELECT COUNT(*) AS n FROM briefing_response_events").get(),
      annotations: sourceDb.prepare("SELECT COUNT(*) AS n FROM briefing_annotation_events").get(),
      submissions: sourceDb.prepare("SELECT COUNT(*) AS n FROM briefing_submissions").get(),
      submissionAnswers: sourceDb.prepare("SELECT COUNT(*) AS n FROM briefing_submission_answers").get(),
      submissionAnnotations: sourceDb.prepare("SELECT COUNT(*) AS n FROM briefing_submission_annotations").get(),
    }).toEqual({
      briefings: { n: 4 }, rounds: { n: 0 }, runs: { n: 0 }, occurrences: { n: 0 },
      responses: { n: 0 }, annotations: { n: 0 }, submissions: { n: 0 },
      submissionAnswers: { n: 0 }, submissionAnnotations: { n: 0 },
    });
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
    const retired = installRetiredV1Demo(source);
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

  it("transactionally replaces the exact migration-143 v1 demo shell and then reseeds as a no-op", () => {
    const fixture = createSeedFixture();
    const retired = installRetiredV1Demo(fixture, { historicalCompatibleUsers: true });
    const sourceHash = fileHash(fixture.sourceDb);
    const sourceInventory = inventory(fixture.sourceRoot);

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
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM artifact_version").get()).toEqual({ n: 4 });
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    upgraded.close();

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
    const retired = installRetiredV1Demo(fixture);
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

    const result = spawnSync(process.execPath, [
      SCRIPT,
      "--dry-run",
      "--json",
    ], {
      cwd: repo,
      encoding: "utf8",
      env: previewLauncherEnv(previewBase),
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("dry-run");
    expect(payload.mode).toBe("current-integration");
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
      const existing = await launcher.healthyExistingPreview("integration/test-preview", { worktree: repo });
      expect(existing?.legacyContractDrift).toBeTruthy();
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
    expect(JSON.parse(result.stdout ?? "{}").error).toContain("Inspect and retire that listener");
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
        allowed_effects: ["ledger:read", "ledger:write", "files:preview"],
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
      env: previewLauncherEnv(previewBase),
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("dry-run");
    expect(payload.mode).toBe("current-integration");
    expect(payload.instanceEnv.MANDIBLE_FILE_RPC_DIR).toBe(path.join(previewRoot, "agent-rpc"));
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
        allowed_effects: ["ledger:read", "ledger:write", "files:preview"],
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
    });
    expect(JSON.parse(reuse.stdout)).toMatchObject({
      status: "dry-run",
      mode: "current-integration",
    });

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
        allowed_effects: ["ledger:read", "ledger:write", "files:preview"],
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

  it("returns clean preview URLs and never places session credentials in a fragment", async () => {
    const repo = createRepo();
    git(["checkout", "-b", "integration/test-preview"], repo);
    const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-cache-"));
    tempRoots.push(previewBase);
    const previewRoot = path.join(previewBase, "integration-test-preview");
    const fileRpcDir = path.join(previewRoot, "agent-rpc");
    fs.mkdirSync(fileRpcDir, { recursive: true });
    const proofPath = path.join(previewRoot, "preview-browser-enrollment.json");
    const pidFile = path.join(previewRoot, "mandible.pid");
    const startupEpoch = "preview-reuse-fixture";
    fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
    fs.writeFileSync(proofPath, JSON.stringify({
      version: 1, pid: process.pid, startup_epoch: startupEpoch, token: "preview process proof",
    }), { mode: 0o600 });
    const currentHead = gitOutput(["rev-parse", "HEAD"], repo);
    const port = await listenForHealth({
      ready: true,
      warm: true,
      startup_epoch: startupEpoch,
      startup_commit: { hash: currentHead, summary: "current", date: "" },
      instance: {
        role: "preview", allowed_effects: ["ledger:read", "ledger:write", "files:preview", "preferences:instance"], preview_browser_enrollment: "allow",
      },
      file_rpc_dir: fileRpcDir,
    }, proofPath);
    const db = path.join(previewRoot, "current.db");
    const sourceDb = path.join(repo, "source.db");
    fs.writeFileSync(sourceDb, "source database", "utf8");
    const metadata = {
      status: "started",
      branch: "integration/test-preview",
      worktree: repo,
      port,
      pidFile,
      db,
      sourceDb,
      previewRoot,
      // A recorded instance that does not carry the full contract is treated as
      // drifted and replaced, so the reuse path under test is only reachable
      // with the complete environment.
      instanceEnv: previewContractEnv({
        port,
        db,
        sourceDb,
        previewRoot,
        pidFile: path.join(previewRoot, "mandible.pid"),
      }),
    };
    fs.writeFileSync(path.join(previewRoot, "metadata.json"), JSON.stringify(metadata), "utf8");
    const result = await execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: repo,
      encoding: "utf8",
      env: previewLauncherEnv(previewBase),
    }).catch((error: { stdout?: string; stderr?: string }) => {
      throw new Error([error.stderr, error.stdout].filter(Boolean).join("\n"));
    });

    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("already-running");
    expect(payload.browserEnrollment).toBe("cookie-or-pairing");
    expect(new URL(payload.freshUrl).hash).not.toContain("mandible_auth");
    expect(payload.pairingUrl).toBeUndefined();
    expect(fs.readFileSync(path.join(previewRoot, "metadata.json"), "utf8"))
      .not.toContain("preview process proof");
    expect(fs.readFileSync(path.join(previewRoot, "metadata.json"), "utf8"))
      .not.toContain("preview dashboard session");

    const reused = await execFileAsync(process.execPath, [SCRIPT, "--json", "--pair-browser"], {
      cwd: repo,
      encoding: "utf8",
      env: previewLauncherEnv(previewBase),
    });
    const reusedPayload = JSON.parse(reused.stdout);
    expect(reusedPayload.status).toBe("already-running");
    expect(reusedPayload.browserEnrollment).toBe("interactive-pairing");
    expect(new URL(reusedPayload.freshUrl).hash).not.toContain("mandible_auth");
    expect(new URL(reusedPayload.pairingUrl).hash).not.toContain("mandible_auth");
    expect(fs.readFileSync(path.join(previewRoot, "metadata.json"), "utf8"))
      .not.toContain("preview dashboard session");
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

  it("refreshes the same preview in place when its startup commit drifts", async () => {
    const fixture = await createRefreshFixture();
    let result;
    try {
      result = await execFileAsync(process.execPath, [SCRIPT, "--json"], {
        cwd: fixture.repo,
        encoding: "utf8",
        env: fixture.env,
      });
    } catch (error) {
      const commandError = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${commandError.message}\nstdout:\n${commandError.stdout ?? ""}\nstderr:\n${commandError.stderr ?? ""}`);
    }

    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("refreshed");
    expect(payload.port).toBe(fixture.metadata.port);
    expect(payload.db).toBe(fixture.db);
    expect(payload.health.startup_commit.hash).toBe(fixture.currentHead);
    expect(payload.health).toMatchObject({ ready: true, warm: true });

    // An unsupervised child, not a launchd job. `launchLabel` is not a field any
    // more, and nothing is left registered that could resurrect the preview.
    expect(payload.launchLabel).toBeUndefined();
    expect(payload.restartLifecycle).toMatchObject({
      mechanism: "detached-child",
      stopped: { pid: UNREACHABLE_PID, outcome: "already-stopped" },
    });
    expect(payload.restartLifecycle.launcherPid).toBeGreaterThan(0);

    // The preview really is being served by a process the launcher started, and
    // that process claimed the pid file the stop path reads.
    const daemonPid = readPidFile(fixture.markerPidFile);
    expect(daemonPid).not.toBeNull();
    expect(readPidFile(fixture.pidFile)).toBe(daemonPid);
    expect(isProcessAlive(daemonPid as number)).toBe(true);

    // run.sh is the single launch contract, so it must pin the whole isolation
    // environment rather than inherit any of it.
    const runScript = fs.readFileSync(fixture.runScript, "utf8");
    const refreshedInstanceEnv = {
      ...fixture.metadata.instanceEnv,
      MANDIBLE_BACKEND_GENERATION: fixture.currentHead,
    };
    for (const [key, value] of Object.entries(refreshedInstanceEnv)) {
      expect(runScript).toContain(`${key}='${value}'`);
    }

    expect(fs.readdirSync(fixture.previewRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
      .map((entry) => entry.name)).toEqual([
      path.basename(fixture.db),
    ]);
    expect(fs.realpathSync(path.join(fixture.previewRoot, "current.db"))).toBe(fs.realpathSync(fixture.db));
  }, 60_000);

  it("upgrades an existing healthy preview without overwriting its local preferences", async () => {
    const fixture = await createRefreshFixture({ legacyUserPreferences: true });
    const localBefore = fs.readFileSync(fixture.localPreferenceFile, "utf8");
    let result;
    try {
      result = await execFileAsync(process.execPath, [SCRIPT, "--json"], {
        cwd: fixture.repo,
        encoding: "utf8",
        env: fixture.env,
      });
    } catch (error) {
      const commandError = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${commandError.message}\nstdout:\n${commandError.stdout ?? ""}\nstderr:\n${commandError.stderr ?? ""}`);
    }

    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("refreshed");
    expect(payload.port).toBe(fixture.metadata.port);
    expect(payload.health.instance.allowed_effects).toEqual([
      "ledger:read", "ledger:write", "files:preview", "preferences:instance",
    ]);
    expect(payload.instanceEnv.MANDIBLE_USER_PREFERENCES_DIR)
      .toBe(path.join(fixture.previewRoot, "settings", "users"));
    expect(payload.userPreferencesSeed).toMatchObject({
      copied: ["user-two.json"],
      preserved: ["user-one.json"],
    });
    expect(fs.readFileSync(fixture.localPreferenceFile, "utf8")).toBe(localBefore);
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(fixture.localPreferenceFile), "user-two.json"), "utf8")))
      .toMatchObject({ userId: "user-two", settings: { appTheme: "system" } });
    expect(JSON.parse(fs.readFileSync(fixture.metadataPath, "utf8"))).not.toHaveProperty("legacyContractDrift");
    expect(fs.readFileSync(path.join(fixture.productionPreferencesRoot, "user-one.json"), "utf8"))
      .toContain('"appTheme":"light"');
  }, 60_000);

  it("terminates the running preview daemon before starting its replacement", async () => {
    const fixture = await createRefreshFixture();
    const running = spawnStandInDaemon(path.join(fixture.previewRoot, "running.pid"));
    fs.writeFileSync(fixture.pidFile, `${running}\n`, "utf8");

    const result = await execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: fixture.env,
    });

    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("refreshed");
    expect(payload.restartLifecycle.stopped).toEqual({ pid: running, outcome: "terminated" });
    expect(isProcessAlive(running)).toBe(false);

    const daemonPid = readPidFile(fixture.markerPidFile);
    expect(daemonPid).not.toBeNull();
    expect(daemonPid).not.toBe(running);
  }, 60_000);

  it("refuses to race an unverified process on an explicitly requested port", async () => {
    const repo = createRepo();
    git(["checkout", "-b", "integration/test-preview"], repo);
    const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-occupied-"));
    tempRoots.push(previewBase, `${previewBase}.authorities`);
    const occupiedPort = await listenForHealth({ unexpected: true });

    await expect(execFileAsync(process.execPath, [
      SCRIPT,
      "--json",
      "--no-build",
      "--db",
      path.join(repo, "missing-source.db"),
      "--port",
      String(occupiedPort),
    ], {
      cwd: repo,
      encoding: "utf8",
      env: previewLauncherEnv(previewBase),
    })).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining(`port ${occupiedPort} is already occupied`),
    });
  });

  it("escalates to SIGKILL and reports it when the preview daemon ignores SIGTERM", async () => {
    const fixture = await createRefreshFixture();
    const wedged = spawnStandInDaemon(path.join(fixture.previewRoot, "wedged.pid"), { ignoresSigterm: true });
    fs.writeFileSync(fixture.pidFile, `${wedged}\n`, "utf8");

    const result = await execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: fixture.env,
    });

    // The escalation is reported honestly rather than being folded into a plain
    // "terminated": a daemon that had to be killed is a different fact.
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("refreshed");
    expect(payload.restartLifecycle.stopped).toEqual({ pid: wedged, outcome: "killed" });
    expect(isProcessAlive(wedged)).toBe(false);
  }, 90_000);

  it("keeps the already-running fast path when the full startup commit matches", async () => {
    const fixture = await createRefreshFixture();
    fs.copyFileSync(fixture.refreshedHealthPath, fixture.healthPath);
    const running = spawnStandInDaemon(path.join(fixture.previewRoot, "already-running.pid"));
    fs.writeFileSync(fixture.pidFile, `${running}\n`, "utf8");
    fs.writeFileSync(path.join(fixture.previewRoot, "preview-browser-enrollment.json"), JSON.stringify({
      version: 1,
      pid: running,
      startup_epoch: "preview-refresh-fixture",
      token: "preview process proof",
    }), { mode: 0o600 });
    const result = await execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: fixture.env,
    });

    expect(JSON.parse(result.stdout).status).toBe("already-running");
    // Nothing was launched and nothing was stopped.
    expect(fs.existsSync(fixture.markerPidFile)).toBe(false);
    expect(readPidFile(fixture.pidFile)).toBe(running);
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
    expect(fs.existsSync(fixture.markerPidFile)).toBe(false);
    expect(readPidFile(fixture.pidFile)).toBe(UNREACHABLE_PID);
    expect(fs.realpathSync(path.join(fixture.previewRoot, "current.db"))).toBe(fs.realpathSync(fixture.db));
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
    expect(fs.existsSync(fixture.markerPidFile)).toBe(false);
  });

  it("refuses log custody drift outside the preview root before build or restart", async () => {
    const fixture = await createRefreshFixture();
    fs.writeFileSync(fixture.metadataPath, JSON.stringify({
      ...fixture.metadata,
      stdoutLog: path.join(os.tmpdir(), "stray-preview-stdout.log"),
    }), "utf8");
    await expect(execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: fixture.env,
    })).rejects.toMatchObject({ code: 1 });
    expect(fs.existsSync(fixture.markerPidFile)).toBe(false);
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
