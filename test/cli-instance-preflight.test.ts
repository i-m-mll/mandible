// @vitest-environment node
/**
 * The CLI's instance preflight: before an operational mutation leaves the
 * client it reads the selected daemon's instance metadata and operation
 * catalog, refuses (request not sent) when either is unknown, incompatible or
 * mid-rebuild, retries only transient metadata failures, and otherwise forwards
 * the request, leaving effect denials to the daemon.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli, scratchDir } from "./helpers/cli-process.js";
import { registeredOperationRouter } from "./helpers/registered-operation-router.js";

const operations = registeredOperationRouter().operationCatalog("test-candidate");
function withCatalog(instance: Record<string, unknown>) {
  const bound = { instance_id: operations.runtime.instance_id, backend_generation: operations.runtime.backend_generation, ...instance };
  return { instance: bound, operations };
}

type RecordedRequest = {
  method: string;
  url: string;
  body: string;
};

type StubResponse = {
  status: number;
  body?: unknown;
};

const MAIN_INSTANCE = {
  role: "main",
  operational_mutations: "allow",
  operational_mutations_overridden: false,
  db_path: "/tmp/mandible-main.db",
  db_path_source: "env",
};

const RETRY_ONCE = {
  MANDIBLE_HTTP_RETRIES: "1",
  MANDIBLE_HTTP_RETRY_BASE_MS: "1",
  MANDIBLE_HTTP_RETRY_MAX_MS: "1",
  MANDIBLE_HTTP_RETRY_JITTER_MS: "0",
};

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const lines = (requests: RecordedRequest[]) => requests.map((request) => `${request.method} ${request.url}`);

it("refuses non-scalar metadata and inherited identity fields without evaluating response commands", async () => {
  const marker = path.join(scratchDir("response-eval"), "executed");
  for (const value of [["safe", "touch", marker], { unexpected: "object" }]) {
    for (const field of ["db_path", "source_db_path"]) {
      const target = await listenForInstancePreflight({ instance: { ...MAIN_INSTANCE, [field]: value } });
      const result = await bash(capture("POST", "/api/ledger/issues/abc/comments"), target.port, { MANDIBLE_NO_KEYCHAIN_TOKEN: "1" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("cli_instance_metadata_unknown");
      expect(lines(target.requests)).toEqual(["GET /api/instance"]);
      expect(fs.existsSync(marker)).toBe(false);
    }
    for (const field of ["pid", "conversation_id"]) {
      const target = await listenForInstancePreflight({ routeResponses: [{ method: "GET", url: "/api/sessions/invalid-row", response: {
        status: 200, body: { pid: 123, conversation_id: "caller", [field]: value },
      } }] });
      const result = await bash("set -e; source cli/api.sh; api_scope_inherited_identity; printf reached", target.port, {
        MANDIBLE_SESSION_ID: "invalid-row", CODEX_THREAD_ID: "caller", CODEX_SESSION_ID: "",
        CLAUDE_CODE_SESSION_ID: "", CLAUDE_SESSION_ID: "", GEMINI_SESSION_ID: "", MANDIBLE_NO_KEYCHAIN_TOKEN: "1",
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("reached");
      expect(fs.existsSync(marker)).toBe(false);
    }
  }
});

it("validates a whole assignment record before output and quotes scalar metacharacters literally", async () => {
  const marker = path.join(scratchDir("binding-eval"), "executed");
  const literal = `literal'; touch ${marker}; #`;
  const json = JSON.stringify({ early: literal, later: ["safe", "touch", marker] });
  const target = await listenForInstancePreflight({ instance: { ...MAIN_INSTANCE, role: "dev", db_path: literal, source_db_path: literal } });
  const refusal = await bash(capture("POST", "/api/ledger/issues/abc/comments"), target.port, { MANDIBLE_NO_KEYCHAIN_TOKEN: "1" });
  expect(refusal.stdout).toContain("cli_instance_mutation_forbidden");
  expect(JSON.parse(refusal.stdout.slice(refusal.stdout.indexOf("\n") + 1)).message).toContain(literal);
  const file = path.join(scratchDir("binding-json"), "fields.json"); fs.writeFileSync(file, json);
  const result = await bash(`source cli/api.sh; api_json_bindings '.' '${file}'`, target.port);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(fs.existsSync(marker)).toBe(false);
});

/** A bash script that sends one request through api.sh and prints `<status>\n<body>`. */
function capture(method: string, requestPath: string, body = "{}", strict = true): string {
  return [
    ...(strict ? ["set -euo pipefail"] : []),
    "source cli/api.sh",
    "tmp_response=$(mktemp)",
    `status=$(api_send_capture ${method} '${requestPath}' '${body}' "$tmp_response")`,
    "printf '%s\\n' \"$status\"",
    "cat \"$tmp_response\"",
  ].join("\n");
}

function baseEnv(port: number, extra: Record<string, string> = {}) {
  return { MANDIBLE_BASE: `http://127.0.0.1:${port}`, TMPDIR: scratchDir("tmp"), ...extra };
}

function bash(script: string, port: number, extra: Record<string, string> = {}) {
  return runCli(["-c", script], { command: "bash", env: baseEnv(port, extra) });
}

function mandible(args: string[], port: number, extra: Record<string, string> = {}) {
  return runCli(args, { env: baseEnv(port, extra) });
}

function writeRestartAvailability(port: number, payload: Record<string, unknown>): string {
  const file = path.join(scratchDir("restart-receipt"), "restart-availability.json");
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    instance_key: `http://127.0.0.1:${port}`,
    updated_at_ms: 1_000_000,
    active: {
      generation_id: "self-merge-generation",
      reason: "self_merge",
      phase: "rebuilding",
      rebuild_started_at_ms: 990_000,
      expected_ready_at_ms: 1_012_000,
    },
    last_completion: null,
    blocked_window: { samples_ms: [18_000, 18_800], average_ms: 18_400, sample_count: 2 },
    shutdown_to_ready: { samples_ms: [2_400, 2_500], average_ms: 2_450, sample_count: 2 },
    ready_to_warm: { samples_ms: [1_000], average_ms: 1_000, sample_count: 1 },
    ...payload,
  })}\n`, "utf8");
  return file;
}

const receiptEnv = (file: string, nowMs = "1000000") => ({ MANDIBLE_RESTART_AVAILABILITY_FILE: file, MANDIBLE_RESTART_AVAILABILITY_NOW_MS: nowMs });

function listenForInstancePreflight(options: {
  instance?: Record<string, unknown> | null;
  healthInstance?: Record<string, unknown> | null;
  instanceResponses?: StubResponse[];
  healthResponses?: StubResponse[];
  routeResponses?: Array<{ method: string; url: string; response: StubResponse }>;
} = {}) {
  const instance = options.instance === undefined ? {
    role: "preview",
    operational_mutations: "reject",
    operational_mutations_overridden: true,
    db_path: "/tmp/mandible-preview.db",
    db_path_source: "iab-preview-copy",
    source_db_path: "/tmp/mandible-main.db",
    source_db_path_source: "env",
  } : options.instance;
  const healthInstance = options.healthInstance ?? null;
  let instanceRequestIndex = 0;
  let healthRequestIndex = 0;
  const requests: RecordedRequest[] = [];
  const sendResponse = (res: http.ServerResponse, response: StubResponse) => {
    res.writeHead(response.status, { "Content-Type": "application/json" });
    if (Object.hasOwn(response, "body")) {
      res.end(JSON.stringify(response.body));
    } else {
      res.end();
    }
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({ method: req.method ?? "GET", url: req.url ?? "/", body: raw });
      const routeResponse = options.routeResponses?.find((candidate) =>
        candidate.method === (req.method ?? "GET") && candidate.url === (req.url ?? "/"));
      if (routeResponse) {
        sendResponse(res, routeResponse.response);
        return;
      }
      if (req.method === "GET" && req.url === "/api/instance") {
        const response = options.instanceResponses?.[instanceRequestIndex++];
        if (response) {
          sendResponse(res, response);
          return;
        }
        if (!instance) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(withCatalog(instance)));
        return;
      }
      if (req.method === "GET" && req.url === "/api/health") {
        const response = options.healthResponses?.[healthRequestIndex++];
        if (response) {
          sendResponse(res, response);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(healthInstance ? { ready: true, ...withCatalog(healthInstance) } : { ready: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/auth/check") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ check: { status: "clean" } }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/ledger/issues/abc/comments") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "comment-1" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/work-units/claim") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "work-unit-1", state: "open" }));
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/api/issues/")) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ display_id: "reminder-1" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/inbox/auth_result/item-1/ack") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/projects") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ project: { project_key: "demo" } }));
        return;
      }
      if (req.method === "PUT" && req.url === "/api/settings/app_theme") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/sessions/by-pid/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "session-1" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/sessions/register") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/sessions/session-1/issues") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "PATCH" && req.url === "/api/sessions/session-1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "PATCH" && req.url === "/api/sessions/session-1/end") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  return new Promise<{ port: number; requests: RecordedRequest[] }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
      cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
      resolve({ port: address.port, requests });
    });
  });
}

describe("CLI instance mutation preflight", () => {
  it("fails fast from a fresh rebuild receipt with deliberate human and structured output", async () => {
    const receipt = writeRestartAvailability(19420, {
      blocked_window: { samples_ms: Array(7).fill(18_400), average_ms: 18_400, sample_count: 7 },
    });

    const result = await bash(capture("POST", "/api/ledger/issues/abc/comments", '{"message":"Not sent"}'), 19420, {
      ...receiptEnv(receipt),
      MANDIBLE_HTTP_RETRY_BASE_MS: "2000",
      MANDIBLE_HTTP_RETRIES: "5",
    });

    expect(result.status).toBe(0);
    const [status, ...json] = result.stdout.trim().split("\n");
    expect(status).toBe("503");
    expect(JSON.parse(json.join("\n"))).toMatchObject({
      error: "mandible_restarting", retryable: true, request_sent: false,
      phase: "rebuilding", reason: "self_merge", sample_count: 7,
      average_seconds: 18.4, retry_after_seconds: 12, category: "operation",
    });
  });

  it("reports first-sample and overdue states without claiming availability", async () => {
    const first = writeRestartAvailability(19422, {
      active: { generation_id: "first", reason: "self_merge", phase: "rebuilding", rebuild_started_at_ms: 1_000_000 },
      blocked_window: { samples_ms: [], average_ms: null, sample_count: 0 },
    });
    const overdue = writeRestartAvailability(19422, {
      active: {
        generation_id: "overdue", reason: "self_merge", phase: "shutdown",
        rebuild_started_at_ms: 990_000, shutdown_started_at_ms: 997_000, expected_ready_at_ms: 999_000,
      },
    });
    const preflight = "source cli/api.sh\napi_preflight_operational_mutation POST /api/projects";

    const [firstResult, overdueResult] = await Promise.all([
      bash(preflight, 19422, receiptEnv(first)),
      bash(preflight, 19422, receiptEnv(overdue)),
    ]);

    expect(firstResult.status).toBe(75);
    expect(overdueResult.status).toBe(75);
  });

  it("ignores restart state that is stale, foreign, unversioned, inconsistent, or malformed", async () => {
    const receipts = [
      writeRestartAvailability(19423, { active: { generation_id: "old", reason: "self_merge", phase: "rebuilding", rebuild_started_at_ms: 1 } }),
      writeRestartAvailability(19423, { instance_key: "http://127.0.0.1:19999" }),
      writeRestartAvailability(19423, { version: 2 }),
      writeRestartAvailability(19423, { version: 0, blocked_window: undefined }),
      writeRestartAvailability(19423, { blocked_window: { samples_ms: [18_000, 18_800], average_ms: 1, sample_count: 2 } }),
    ];
    const malformed = path.join(scratchDir("restart-malformed"), "restart-availability.json");
    fs.writeFileSync(malformed, "{not-json\n");

    const results = await Promise.all([...receipts, malformed].map((receipt) => bash(
      "source cli/api.sh\nif api_restart_availability_preflight projects; then printf classified; else printf ignored; fi",
      19423,
      receiptEnv(receipt),
    )));

    for (const result of results) expect({ stdout: result.stdout, stderr: result.stderr }).toEqual({ stdout: "ignored", stderr: "" });
  });

  it("allows mutation immediately after ready while warm completion is still pending", async () => {
    const target = await listenForInstancePreflight({ instance: MAIN_INSTANCE });
    const receipt = writeRestartAvailability(target.port, {
      active: null,
      last_completion: { generation_id: "ready-not-warm", rebuild_started_at_ms: 980_000, shutdown_started_at_ms: 997_000, ready_at_ms: 1_000_000 },
      ready_to_warm: { samples_ms: [], average_ms: null, sample_count: 0 },
    });

    const result = await bash(capture("POST", "/api/ledger/issues/abc/comments", '{"message":"Ready"}'), target.port, receiptEnv(receipt, "1000001"));

    expect(result.stdout).toBe("200\n{\"id\":\"comment-1\"}");
    expect(result.stderr).toBe("");
    expect(lines(target.requests)).toEqual(["GET /api/instance", "POST /api/ledger/issues/abc/comments"]);
  });

  it("does not send a mutation the selected runtime catalog cannot classify", async () => {
    const main = withCatalog(MAIN_INSTANCE);
    const cases: Array<[string, unknown, string, string]> = [
      ["missing catalog", { instance: main.instance }, "/api/projects", "cli_operation_metadata_incompatible"],
      ["malformed catalog", { ...main, operations: { schema: "wrong" } }, "/api/projects", "cli_operation_metadata_incompatible"],
      ["different instance", { ...main, instance: { ...main.instance, instance_id: "other" } }, "/api/projects", "cli_operation_metadata_incompatible"],
      ["different generation", { ...main, instance: { ...main.instance, backend_generation: "next" } }, "/api/projects", "cli_operation_metadata_incompatible"],
      ["unknown child path", main, "/api/projects/not-a-registered-operation/extra", "cli_operation_unknown"],
    ];
    await Promise.all(cases.map(async ([label, payload, requestPath, error]) => {
      const target = await listenForInstancePreflight({ instanceResponses: [{ status: 200, body: payload }] });

      const result = await bash(capture("POST", requestPath, "{}", false), target.port, { MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1" });

      expect(result.status, `${label}: ${result.stderr}`).toBe(0);
      expect(result.stdout.startsWith("403\n"), label).toBe(true);
      expect(JSON.parse(result.stdout.slice(result.stdout.indexOf("\n") + 1)), label).toMatchObject({ error, request_sent: false });
      expect(lines(target.requests), label).toEqual(["GET /api/instance"]);
    }));
  });

  it("classifies exact path segments in catalog order and validates every route before sending", async () => {
    const main = withCatalog({ ...MAIN_INSTANCE, role: "dev", operational_mutations: "reject" });
    const route = { ...operations.routes[0], method: "POST", path: "/api/custom/:id", operationalMutationCategory: null };
    const cases: Array<[string, typeof operations.routes, string | null]> = [
      ["/api/custom/item?mode=1", [route, { ...route, operationalMutationCategory: "shared" }], null],
      ["/api/custom/", [route], "cli_operation_unknown"],
      ["/api/custom/item/extra", [route], "cli_operation_unknown"],
      ["/api/custom/item", [{ ...route, method: "PUT" }], "cli_operation_unknown"],
      ["/api/custom/a.b", [{ ...route, path: "/api/custom/a.b" }], null],
      ["/api/custom/axb", [{ ...route, path: "/api/custom/a.b" }], "cli_operation_unknown"],
      ["/api/custom/item", [route, { ...route, operationId: "" }], "cli_operation_metadata_incompatible"],
    ];
    await Promise.all(cases.map(async ([requestPath, routes, error]) => {
      const target = await listenForInstancePreflight({
        instanceResponses: [{ status: 200, body: { ...main, operations: { ...operations, routes } } }],
        routeResponses: [{ method: "POST", url: requestPath, response: { status: 200, body: { ok: true } } }],
      });
      const result = await bash(capture("POST", requestPath), target.port);
      expect(result.status, result.stderr).toBe(0);
      if (error) {
        expect(JSON.parse(result.stdout.slice(result.stdout.indexOf("\n") + 1))).toMatchObject({ error, request_sent: false });
        expect(lines(target.requests)).toEqual(["GET /api/instance"]);
      } else {
        expect(result.stdout).toBe('200\n{"ok":true}');
        expect(lines(target.requests)).toEqual(["GET /api/instance", `POST ${requestPath}`]);
      }
    }));
  });

  it("fetches current instance policy again for each mutation in the same shell", async () => {
    const target = await listenForInstancePreflight({ instanceResponses: [
      { status: 200, body: withCatalog(MAIN_INSTANCE) },
      { status: 200, body: withCatalog({ ...MAIN_INSTANCE, role: "dev", operational_mutations: "reject" }) },
    ] });
    const send = capture("POST", "/api/ledger/issues/abc/comments");
    const script = `${send}\n${send.replace("source cli/api.sh\n", "")}`;
    const result = await bash(script, target.port);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('200\n{"id":"comment-1"}');
    expect(result.stdout).toContain("cli_instance_mutation_forbidden");
    expect(lines(target.requests)).toEqual(["GET /api/instance", "POST /api/ledger/issues/abc/comments", "GET /api/instance"]);
  });

  it("forwards writes on copied data to a preview daemon after validating its metadata", async () => {
    const sends: Array<[string, (port: number) => Promise<{ status: number | null; stdout: string; stderr: string }>, string]> = [
      ["comment", (port) => bash(capture("POST", "/api/ledger/issues/abc/comments", '{"message":"New comment"}'), port), "POST /api/ledger/issues/abc/comments"],
      ["settings", (port) => bash(capture("PUT", "/api/settings/app_theme"), port), "PUT /api/settings/app_theme"],
      ["auth check", (port) => bash(capture("POST", "/api/auth/check", '{"repo":"mandible"}'), port), "POST /api/auth/check"],
      ["project", (port) => mandible(["project", "add", "--key", "demo"], port), "POST /api/projects"],
      ["inbox ack", (port) => mandible(["inbox", "ack", "auth_result", "item-1"], port), "POST /api/inbox/auth_result/item-1/ack"],
    ];
    await Promise.all(sends.map(async ([label, send, sent]) => {
      const target = await listenForInstancePreflight();

      const result = await send(target.port);

      expect(result.status, `${label}: ${result.stderr}`).toBe(0);
      expect(lines(target.requests), label).toEqual(["GET /api/instance", sent]);
    }));
  });

  it("leaves effect denials to the daemon and surfaces them", async () => {
    const denied = { error: "effect_forbidden", missing_effects: ["process:external"] };
    const deny = (method: string, url: string) => listenForInstancePreflight({ routeResponses: [{ method, url, response: { status: 403, body: denied } }] });
    const [scan, link, task] = await Promise.all([
      deny("POST", "/api/work/scan"),
      deny("POST", "/api/sessions/session-1/issues"),
      deny("PATCH", "/api/sessions/session-1"),
    ]);

    const [scanned, linked, tasked] = await Promise.all([
      bash(capture("POST", "/api/work/scan"), scan.port, { MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1" }),
      mandible(["session", "link-issue", "session-1", "--issue", "abc123", "--repo", "mandible"], link.port),
      mandible(["task", "Fixing preview guard"], task.port),
    ]);

    expect(scanned.status, scanned.stderr).toBe(0);
    expect(scanned.stdout).toBe(`403\n${JSON.stringify(denied)}`);
    expect(lines(scan.requests)).toEqual(["GET /api/instance", "POST /api/work/scan"]);
    expect(linked.status).not.toBe(0);
    expect(lines(link.requests)).toEqual(["GET /api/instance", "POST /api/sessions/session-1/issues"]);
    expect(tasked.status).not.toBe(0);
    expect(lines(task.requests)).toEqual([expect.stringMatching(/^GET \/api\/sessions\/by-pid\/\d+$/), "GET /api/instance", "PATCH /api/sessions/session-1"]);
  });

  it("retries transient metadata failures before work-unit, session-link, and comment mutations", async () => {
    const mainPayload = withCatalog(MAIN_INSTANCE);
    const target = await listenForInstancePreflight({
      instance: MAIN_INSTANCE,
      instanceResponses: [
        { status: 503, body: { error: "busy" } },
        { status: 200, body: mainPayload },
        { status: 200 },
        { status: 200, body: mainPayload },
        { status: 503, body: { error: "restarting" } },
        { status: 200, body: mainPayload },
      ],
    });

    const claim = await mandible(["work-unit", "claim", "--issue", "abc123", "--repo", "mandible", "--branch", "feature/abc123"], target.port, RETRY_ONCE);
    const sessionLink = await mandible(["session", "link-issue", "session-1", "--issue", "abc123", "--repo", "mandible"], target.port, RETRY_ONCE);
    const comment = await bash(capture("POST", "/api/ledger/issues/abc/comments", '{"message":"Recovered"}'), target.port, RETRY_ONCE);

    for (const result of [claim, sessionLink, comment]) {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Mandible request transient failure; retrying");
    }
    expect(comment.stdout).toBe("200\n{\"id\":\"comment-1\"}");
    expect(lines(target.requests)).toEqual([
      "GET /api/instance",
      "GET /api/instance",
      "POST /api/work-units/claim",
      "GET /api/instance",
      "GET /api/instance",
      "POST /api/sessions/session-1/issues",
      "GET /api/instance",
      "GET /api/instance",
      "POST /api/ledger/issues/abc/comments",
    ]);
  });

  it("uses health instance metadata as a compatibility fallback", async () => {
    const target = await listenForInstancePreflight({ instance: null, healthInstance: MAIN_INSTANCE });

    const result = await bash(capture("POST", "/api/ledger/issues/abc/comments", '{"message":"Fallback"}'), target.port);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("200\n{\"id\":\"comment-1\"}");
    expect(lines(target.requests)).toEqual(["GET /api/instance", "GET /api/health", "POST /api/ledger/issues/abc/comments"]);
  });

  it("reports exhausted transient metadata unavailability as retryable without sending the mutation", async () => {
    const target = await listenForInstancePreflight({
      instance: MAIN_INSTANCE,
      instanceResponses: [{ status: 503, body: { error: "busy" } }, { status: 503, body: { error: "busy" } }],
    });

    const result = await bash(capture("POST", "/api/ledger/issues/abc/comments", '{"message":"Not sent"}'), target.port, RETRY_ONCE);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("503\n");
    expect(result.stdout).toContain("cli_instance_metadata_unavailable");
    expect(result.stdout).toContain('"retryable": true');
    expect(result.stdout).not.toContain("cli_instance_metadata_unknown");
    expect(result.stderr).toContain("temporarily unavailable after bounded retries");
    expect(target.requests.some((request) => request.method === "POST")).toBe(false);
    expect(target.requests.filter((request) => request.url === "/api/instance")).toHaveLength(2);
    // Health is never retried: one preflight read, one final-failure diagnostic probe.
    expect(target.requests.filter((request) => request.url === "/api/health")).toHaveLength(2);
    expect(result.stderr).not.toContain("unbound variable");
  });

  it("fails closed when target metadata is unavailable or malformed, even with the test override", async () => {
    const cases: Array<[string, Record<string, unknown> | null, string[]]> = [
      ["unavailable", null, ["GET /api/instance", "GET /api/health"]],
      ["missing fields", {}, ["GET /api/instance"]],
      ["missing policy", { role: "main" }, ["GET /api/instance"]],
      ["invalid role", { role: "copy", operational_mutations: "allow" }, ["GET /api/instance"]],
      ["invalid policy", { role: "main", operational_mutations: "sometimes" }, ["GET /api/instance"]],
    ];
    await Promise.all(cases.map(async ([label, instance, requests]) => {
      const target = await listenForInstancePreflight({ instance });

      const result = await bash(capture("POST", "/api/ledger/issues/abc/comments", '{"message":"New comment"}'), target.port, {
        MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: instance === null ? "1" : "",
      });

      expect(result.status, label).toBe(0);
      expect(result.stdout, label).toContain("403\n");
      expect(result.stdout, label).toContain("cli_instance_metadata_unknown");
      expect(result.stderr, label).toContain("instance metadata is unavailable");
      expect(lines(target.requests), label).toEqual(requests);
    }));
  });
});
