import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { openDb } from "../src/db.js";
import { setSetting } from "../src/client-auth/settings-kv.js";
import { retireBriefingV1ToCustody } from "../src/feedback/migrate-legacy.js";
import { RICH_BRIEFING_DEMO } from "../src/feedback/rich-briefing-demo.js";
import { recordArtifactVersion } from "../src/provider-artifacts.js";
import { createUser } from "../src/users/store.js";

const SCRIPT = path.join(process.cwd(), "scripts", "iab-preview.mjs");
const execFileAsync = promisify(execFile);

let tempRoots: string[] = [];
let previewServer: http.Server | null = null;

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
}

function gitOutput(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
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

function createSeedFixture() {
  const worktree = fs.realpathSync.native(process.cwd());
  const branch = gitOutput(["branch", "--show-current"], worktree);
  const previewBase = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-seed-cache-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-iab-preview-seed-source-"));
  tempRoots.push(previewBase, sourceRoot);
  const previewRoot = path.join(previewBase, slugify(branch));
  fs.mkdirSync(previewRoot, { recursive: true });
  const db = path.join(previewRoot, "mandible-20260818-120000.db");
  openDb(db).close();
  const sourceDb = path.join(sourceRoot, "source.db");
  fs.writeFileSync(sourceDb, "immutable source fixture\n", "utf8");
  fs.symlinkSync(db, path.join(previewRoot, "current.db"));
  const instanceEnv = {
    MANDIBLE_DB: db,
    MANDIBLE_INSTANCE_ROLE: "preview",
    MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
    MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
    MANDIBLE_INSTANCE_SOURCE_DB: sourceDb,
  };
  const health = {
    instance: {
      role: "preview",
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
    env: { ...process.env, MANDIBLE_PREVIEW_BASE_DIR: previewBase },
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
  return spawnSync(process.execPath, [SCRIPT, "seed-briefing-demo", "--json", ...extraArgs], {
    cwd: fixture.worktree,
    encoding: "utf8",
    env: fixture.env,
  });
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

async function createRefreshFixture(options: {
  buildFails?: boolean;
  primaryRestartFails?: boolean;
  registrationMissing?: boolean;
  restartFails?: boolean;
} = {}) {
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
if [ "$1" = "print" ]; then
  ${options.registrationMissing ? "printf '%s\\n' 'service not found' >&2; exit 26" : "printf '%s\\n' 'registered preview service'; exit 0"}
fi
if [ "$1" = "kickstart" ] && [ "$2" = "-kp" ]; then
  ${options.primaryRestartFails || options.restartFails ? "printf '%s\\n' 'primary kickstart failed' >&2; exit 24" : "cp \"$MANDIBLE_IAB_PREVIEW_TEST_REFRESH_HEALTH\" \"$MANDIBLE_IAB_PREVIEW_TEST_HEALTH\"; printf '%s\\n' '4242'; exit 0"}
fi
if [ "$1" = "kickstart" ] && [ "$2" = "-p" ]; then
  ${options.restartFails ? "printf '%s\\n' 'recovery kickstart failed' >&2; exit 25" : "cp \"$MANDIBLE_IAB_PREVIEW_TEST_REFRESH_HEALTH\" \"$MANDIBLE_IAB_PREVIEW_TEST_HEALTH\"; printf '%s\\n' '4243'; exit 0"}
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

    const upgraded = new Database(fixture.db, { readonly: true });
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

    const afterFirst = fs.readFileSync(fixture.db);
    const second = runSeed(fixture);
    expect(second.status, `${second.stderr}\n${second.stdout}`).toBe(0);
    const secondPayload = JSON.parse(second.stdout);
    expect(secondPayload.status).toBe("already-present");
    expect(secondPayload.briefing).toEqual(firstPayload.briefing);
    expect(secondPayload.rounds).toEqual(firstPayload.rounds);
    expect(fs.readFileSync(fixture.db)).toEqual(afterFirst);
    expect(fileHash(fixture.sourceDb)).toBe(sourceHash);
    expect(inventory(fixture.sourceRoot)).toEqual(sourceInventory);
  }, 30_000);

  it("keeps an unverified zero-round demo shell fail-closed and byte-identical", () => {
    const fixture = createSeedFixture();
    const retired = installRetiredV1Demo(fixture);
    const db = new Database(fixture.db);
    db.prepare("UPDATE briefing_legacy_custody SET disposition = 'sealed_ambiguous' WHERE briefing_id = ?")
      .run(retired.briefingId);
    db.close();
    const before = fs.readFileSync(fixture.db);
    const sourceHash = fileHash(fixture.sourceDb);

    const result = runSeed(fixture);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("partial or conflicting: retired v1 custody integrity");
    expect(fs.readFileSync(fixture.db)).toEqual(before);
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
    const dbAfterFirst = fs.readFileSync(fixture.db);
    const countsAfterFirst = new Database(fixture.db, { readonly: true });
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
    expect(fs.readFileSync(fixture.db)).toEqual(dbAfterFirst);
    const dbAfterSecond = new Database(fixture.db, { readonly: true });
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

    const conflicting = new Database(fixture.db);
    conflicting.prepare("UPDATE users SET status = 'retired' WHERE slug = 'briefing-demo-reviewer'").run();
    conflicting.close();
    const beforeConflictCheck = fs.readFileSync(fixture.db);
    const conflictResult = runSeed(fixture);
    expect(conflictResult.status).toBe(1);
    expect(conflictResult.stdout).toContain("partial or conflicting");
    expect(fs.readFileSync(fixture.db)).toEqual(beforeConflictCheck);
    expect(fileHash(fixture.sourceDb)).toBe(sourceHash);
    expect(inventory(fixture.sourceRoot)).toEqual(sourceInventory);
  }, 30_000);

  it.each([
    ["branch drift", (fixture: ReturnType<typeof createSeedFixture>) => ({ ...fixture.metadata, branch: "integration/unrelated" })],
    ["worktree drift", (fixture: ReturnType<typeof createSeedFixture>) => ({ ...fixture.metadata, worktree: path.dirname(fixture.worktree) })],
    ["previewRoot drift", (fixture: ReturnType<typeof createSeedFixture>) => ({ ...fixture.metadata, previewRoot: fixture.sourceRoot })],
    ["preview policy drift", (fixture: ReturnType<typeof createSeedFixture>) => ({
      ...fixture.metadata,
      instanceEnv: { ...fixture.metadata.instanceEnv, MANDIBLE_OPERATIONAL_MUTATIONS: "allow" },
    })],
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
    const before = fs.readFileSync(fixture.db);
    const result = runSeed(fixture);
    expect(result.status).toBe(1);
    expect(fs.readFileSync(fixture.db)).toEqual(before);
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
      const before = fs.readFileSync(fixture.db);
      const result = runSeed(fixture, arrangedArgs);
      expect(result.status).toBe(1);
      expect(fs.readFileSync(fixture.db)).toEqual(before);
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
      conversationTitleConvergence: expect.stringContaining("before daemon start"),
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
    const launchLog = fs.readFileSync(fixture.launchLog, "utf8");
    expect(launchLog).toContain(`print gui/${process.getuid()}/${fixture.metadata.launchLabel}`);
    expect(launchLog).toContain(`kickstart -kp gui/${process.getuid()}/${fixture.metadata.launchLabel}`);
    expect(launchLog).not.toContain(`remove ${fixture.metadata.launchLabel}`);
    expect(launchLog).not.toContain(`submit -l ${fixture.metadata.launchLabel}`);
    expect(payload.restartLifecycle).toMatchObject({
      mechanism: "launchctl-kickstart",
      recovery: "not-needed",
      replacementPid: 4242,
    });
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
    let failure: unknown;
    try {
      await execFileAsync(process.execPath, [SCRIPT, "--json"], {
        cwd: fixture.repo,
        encoding: "utf8",
        env: fixture.env,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 1,
      stdout: expect.stringContaining("primary kickstart failed"),
    });
    expect((failure as { stdout: string }).stdout).toContain("recovery kickstart failed");
    expect((failure as { stdout: string }).stdout).toContain("Recovery command:");

    expect(fs.readFileSync(fixture.metadataPath, "utf8")).toBe(before);
    expect(fs.readdirSync(fixture.previewRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
      .map((entry) => entry.name)).toEqual([
      path.basename(fixture.db),
    ]);
    const launchLog = fs.readFileSync(fixture.launchLog, "utf8");
    expect(launchLog).toContain("kickstart -kp");
    expect(launchLog).toContain("kickstart -p");
    expect(launchLog).not.toContain("remove");
  });

  it("recovers a failed replacement kickstart without unregistering the preview", async () => {
    const fixture = await createRefreshFixture({ primaryRestartFails: true });
    const result = await execFileAsync(process.execPath, [SCRIPT, "--json"], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: fixture.env,
    });

    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("refreshed");
    expect(payload.restartLifecycle).toMatchObject({
      mechanism: "launchctl-kickstart",
      recovery: "kickstart-registered-service",
      replacementPid: 4243,
      initialFailure: {
        reason: "replacement kickstart failed",
        evidence: expect.stringContaining("primary kickstart failed"),
      },
    });
    const launchLog = fs.readFileSync(fixture.launchLog, "utf8");
    expect(launchLog).toContain("kickstart -kp");
    expect(launchLog).toContain("kickstart -p");
    expect(launchLog).not.toContain("remove");
  });

  it("refuses to restart an unregistered label without removing or submitting anything", async () => {
    const fixture = await createRefreshFixture({ registrationMissing: true });
    let failure: unknown;
    try {
      await execFileAsync(process.execPath, [SCRIPT, "--json"], {
        cwd: fixture.repo,
        encoding: "utf8",
        env: fixture.env,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 1,
      stdout: expect.stringContaining("is not registered"),
    });
    expect((failure as { stdout: string }).stdout).toContain("service not found");
    const launchLog = fs.readFileSync(fixture.launchLog, "utf8");
    expect(launchLog).toContain("print gui/");
    expect(launchLog).not.toContain("kickstart");
    expect(launchLog).not.toContain("remove");
    expect(launchLog).not.toContain("submit");
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
