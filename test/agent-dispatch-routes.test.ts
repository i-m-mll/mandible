import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Issue ce83a84 (umbrella 99b74d6): the agent-dispatch HTTP surface. The
// properties under test are the ones that make a one-click agent launch safe:
// human-only credentials, no file-RPC reachability, refusal on a read-only
// instance, a preview that writes nothing, and an honestly recorded spawn
// failure. The spawn itself is exercised end to end through a stub
// `claude-spawn` binary injected on PATH, so the real command line is covered
// without starting a session.

import { ingestBriefingBatch } from "../src/briefing.js";
import { setSetting } from "../src/client-auth/settings-kv.js";
import { BRIEFING_INGEST_SCHEMA, type BriefingIngestRequest } from "../src/contracts.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { registerAgentDispatchRoutes } from "../src/routes/agent-dispatch.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../src/server.js";
import { createUser, OPERATOR_SETTING_KEY } from "../src/users/store.js";

let db: Db;
let router: Router;
let tempDir: string;
let binDir: string;
let operatorId: string;
let previousDbEnv: string | undefined;
let previousPath: string | undefined;

/** Minimal gate: a credential string is a slug that resolves to a live user. */
class SlugGate implements ClientAuthGate {
  constructor(private readonly lookup: () => Db) {}

  authenticate(credential: string | null | undefined): ResolvedClientIdentity | null {
    if (!credential) return null;
    const row = this.lookup()
      .prepare("SELECT id, slug FROM users WHERE slug = ? AND status = 'active'")
      .get(credential) as { id: string; slug: string } | undefined;
    if (!row) return null;
    return {
      user_id: row.id,
      slug: row.slug,
      method: "api_token",
      credential_id: null,
      source: "in_process",
    };
  }

  mode(): "compat" | "strict" {
    return "compat";
  }

  recordUnattributedWrite(): void {
    // No telemetry assertions in this suite.
  }
}

/** Install a stub `claude-spawn` on PATH. `script` is the body after the shebang. */
function installSpawnStub(script: string): void {
  fs.writeFileSync(path.join(binDir, "claude-spawn"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

function batch(): BriefingIngestRequest {
  return {
    schema: BRIEFING_INGEST_SCHEMA,
    task_identity: "agent-schedule/daily-digest",
    run_id: "run-1",
    digest: { series_ref: "artifact-series:abc123", version: 1 },
    batch_key: "batch-1",
    items: [
      {
        candidate_key: "key-1",
        source: "arxiv-scan",
        ref: "paper-1",
        title: "A notable finding",
        why_notable: "It moves the pilot forward",
        refs: [],
        evidence_hash: "evidence-a",
        evidence_kind: "snapshot-item",
        captured_at: "2026-08-11T09:00:00Z",
        rank: 1,
      },
    ],
  };
}

function makeRouter(options: { readOnly?: boolean } = {}): Router {
  return new Router({
    clientAuth: new SlugGate(() => db),
    instance: resolveInstanceInfo({
      env: {
        MANDIBLE_OPERATIONAL_MUTATIONS: options.readOnly ? "reject" : "allow",
      } as NodeJS.ProcessEnv,
    }),
  });
}

function onlyCandidateId(): string {
  return (db.prepare("SELECT id FROM review_candidates LIMIT 1").get() as { id: string }).id;
}

function countRows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-dispatch-routes-"));
  binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  previousDbEnv = process.env.MANDIBLE_DB;
  previousPath = process.env.PATH;
  process.env.MANDIBLE_DB = path.join(tempDir, "mandible.db");
  // PATH is REPLACED, not prepended: a real claude-spawn on the developer's
  // PATH must never be reachable from this suite, or a failing assertion would
  // start an actual interactive session.
  process.env.PATH = binDir;

  db = new Database(":memory:");
  migrate(db);
  setDb(db);
  operatorId = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" }).id;
  setSetting(db, OPERATOR_SETTING_KEY, operatorId);
  createUser(db, { slug: "agent-schedule", kind: "agent", display_name: "Agent Schedule" });
  ingestBriefingBatch(db, batch(), 1_000);
  router = makeRouter();
  registerAgentDispatchRoutes(router, db);
});

afterEach(() => {
  db.close();
  if (previousDbEnv === undefined) delete process.env.MANDIBLE_DB;
  else process.env.MANDIBLE_DB = previousDbEnv;
  process.env.PATH = previousPath;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("agent dispatch authorization", () => {
  it("rejects agent and publisher credentials on preview and dispatch", async () => {
    for (const url of ["/api/agent-dispatch/preview", "/api/agent-dispatch/dispatch"]) {
      const response = await router.invoke({
        method: "POST",
        url,
        body: {
          subject: { kind: "finding", candidate_id: onlyCandidateId() },
          instruction: "agents may not start agents",
        },
        credential: "agent-schedule",
      });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "human_dispatcher_required" });
    }
    expect(countRows("agent_dispatch_events")).toBe(0);
    expect(countRows("candidate_comments")).toBe(0);
  });

  it("rejects an unauthenticated caller", async () => {
    const response = await router.invoke({
      method: "POST",
      url: "/api/agent-dispatch/dispatch",
      body: {
        subject: { kind: "finding", candidate_id: onlyCandidateId() },
        instruction: "anonymous",
      },
    });
    expect(response.status).toBe(401);
    expect(countRows("agent_dispatch_events")).toBe(0);
  });

  it("denies file-RPC for preview and dispatch, and allows it for the event read", () => {
    expect(router.resolveFileRpcPolicy("POST", "/api/agent-dispatch/preview")).toBe(false);
    expect(router.resolveFileRpcPolicy("POST", "/api/agent-dispatch/dispatch")).toBe(false);
    expect(router.resolveFileRpcPolicy("GET", "/api/agent-dispatch/events")).toBe(true);
  });

  it("refuses dispatch while the instance is read-only", async () => {
    const readOnlyRouter = makeRouter({ readOnly: true });
    registerAgentDispatchRoutes(readOnlyRouter, db);

    for (const url of ["/api/agent-dispatch/preview", "/api/agent-dispatch/dispatch"]) {
      const response = await readOnlyRouter.invoke({
        method: "POST",
        url,
        body: {
          subject: { kind: "finding", candidate_id: onlyCandidateId() },
          instruction: "not here",
        },
        credential: "operator",
      });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        error: "instance_mutation_forbidden",
        category: "agent_dispatch",
      });
    }
    expect(countRows("agent_dispatch_events")).toBe(0);

    // The audit read stays available on a read-only instance.
    const events = await readOnlyRouter.invoke({
      method: "GET",
      url: "/api/agent-dispatch/events",
    });
    expect(events.status).toBe(200);
  });

  it("rejects a malformed subject and a blank instruction without writing", async () => {
    const badSubject = await router.invoke({
      method: "POST",
      url: "/api/agent-dispatch/dispatch",
      body: { subject: { kind: "session", id: "x" }, instruction: "go" },
      credential: "operator",
    });
    expect(badSubject.status).toBe(400);

    const blank = await router.invoke({
      method: "POST",
      url: "/api/agent-dispatch/dispatch",
      body: { subject: { kind: "finding", candidate_id: onlyCandidateId() }, instruction: "  " },
      credential: "operator",
    });
    expect(blank.status).toBe(400);
    expect(countRows("agent_dispatch_events")).toBe(0);
    expect(countRows("candidate_comments")).toBe(0);
  });
});

describe("agent dispatch execution", () => {
  it("previews without any side effect, then dispatches the previewed prompt", async () => {
    const candidateId = onlyCandidateId();
    const argsLog = path.join(tempDir, "args.log");
    installSpawnStub([
      `printf '%s\\n' "$@" > ${JSON.stringify(argsLog)}`,
      'printf "cc-20260812-finding-arxiv-ab12\\n"',
      'printf "session_id: \\$5\\n"',
      'printf "state: alive (pane_pid 4242)\\n"',
      'printf "attach: tmux -L claude-spawn attach -t cc-20260812-finding-arxiv-ab12\\n"',
    ].join("\n"));

    const preview = await router.invoke({
      method: "POST",
      url: "/api/agent-dispatch/preview",
      body: {
        subject: { kind: "finding", candidate_id: candidateId },
        instruction: "Reproduce this result.",
      },
      credential: "operator",
    });
    expect(preview.status).toBe(200);
    const plan = (preview.body as { plan: Record<string, unknown> }).plan;
    expect(plan.prompt).toContain("Reproduce this result.");
    expect(Array.isArray(plan.capability_surface)).toBe(true);

    // Declining here would end the story: the preview wrote nothing.
    expect(countRows("candidate_comments")).toBe(0);
    expect(countRows("agent_dispatch_events")).toBe(0);
    expect(fs.existsSync(argsLog)).toBe(false);

    const dispatched = await router.invoke({
      method: "POST",
      url: "/api/agent-dispatch/dispatch",
      body: {
        subject: { kind: "finding", candidate_id: candidateId },
        instruction: "Reproduce this result.",
      },
      credential: "operator",
    });
    expect(dispatched.status).toBe(200);
    const payload = dispatched.body as { ok: boolean; event: Record<string, string | null> };
    expect(payload.ok).toBe(true);
    expect(payload.event).toMatchObject({
      status: "dispatched",
      subject_kind: "finding",
      candidate_id: candidateId,
      actor_user_id: operatorId,
      session_handle: "cc-20260812-finding-arxiv-ab12",
      attach_command: "tmux -L claude-spawn attach -t cc-20260812-finding-arxiv-ab12",
      error: null,
    });
    expect(payload.event.comment_id).toBeTruthy();

    // The stub saw the real command line, and the prompt file it was handed
    // carries the exact text the operator approved.
    const args = fs.readFileSync(argsLog, "utf8").trim().split("\n");
    expect(args[0]).toBe("create");
    expect(args).toContain("--surface");
    expect(args).toContain("none");
    const promptPath = args[args.indexOf("--prompt-file") + 1];
    expect(promptPath).toBe(payload.event.prompt_path);
    expect(fs.readFileSync(promptPath, "utf8")).toBe(plan.prompt);

    const events = await router.invoke({
      method: "GET",
      url: `/api/agent-dispatch/events?candidate_id=${candidateId}`,
      credential: "operator",
    });
    expect((events.body as { events: unknown[] }).events).toHaveLength(1);
  });

  it("records a failed spawn on the handling event and still answers 200", async () => {
    installSpawnStub([
      'printf "claude-spawn: dedicated tmux server is not running\\n" >&2',
      "exit 1",
    ].join("\n"));

    const response = await router.invoke({
      method: "POST",
      url: "/api/agent-dispatch/dispatch",
      body: {
        subject: { kind: "finding", candidate_id: onlyCandidateId() },
        instruction: "Start a worker while tmux is down.",
      },
      credential: "operator",
    });

    expect(response.status).toBe(200);
    const payload = response.body as { ok: boolean; event: Record<string, string | null> };
    expect(payload.ok).toBe(false);
    expect(payload.event.status).toBe("failed");
    expect(payload.event.session_handle).toBeNull();
    expect(payload.event.error).toContain("dedicated tmux server is not running");
    // The instruction survives the failure as an immutable candidate comment.
    expect(countRows("candidate_comments")).toBe(1);
  });

  it("reports a missing claude-spawn binary as a recorded failure, not a crash", async () => {
    // No stub installed: the binary cannot be resolved on PATH.
    const response = await router.invoke({
      method: "POST",
      url: "/api/agent-dispatch/dispatch",
      body: {
        subject: { kind: "finding", candidate_id: onlyCandidateId() },
        instruction: "Dispatch without the tool installed.",
      },
      credential: "operator",
    });

    expect(response.status).toBe(200);
    const payload = response.body as { ok: boolean; event: Record<string, string | null> };
    expect(payload.ok).toBe(false);
    expect(payload.event.status).toBe("failed");
    expect(payload.event.error).toBeTruthy();
  });
});
