import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { evaluateInstanceMutation } from "../src/instance-policy.js";
import type { InstanceInfo } from "../src/types.js";

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

let server: http.Server | null = null;
let tempRoots: string[] = [];

function runBash(script: string, port: number, extraEnv: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("bash", ["-c", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MANDIBLE_BASE: `http://127.0.0.1:${port}`,
        ...extraEnv,
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
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function runMandible(args: string[], port: number, extraEnv: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("bin/mandible", args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MANDIBLE_BASE: `http://127.0.0.1:${port}`,
        ...extraEnv,
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
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function listenForInstancePreflight(options: {
  instance?: Record<string, unknown> | null;
  healthInstance?: Record<string, unknown> | null;
  instanceResponses?: StubResponse[];
  healthResponses?: StubResponse[];
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
  server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({ method: req.method ?? "GET", url: req.url ?? "/", body: raw });
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
        res.end(JSON.stringify({ instance }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/health") {
        const response = options.healthResponses?.[healthRequestIndex++];
        if (response) {
          sendResponse(res, response);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(healthInstance ? { ready: true, instance: healthInstance } : { ready: true }));
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

  return new Promise<{ port: number; requests: RecordedRequest[]; close: () => Promise<void> }>((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      resolve({
        port: address.port,
        requests,
        close: () => new Promise<void>((done, reject) => {
          server!.close((error) => {
            server = null;
            error ? reject(error) : done();
          });
        }),
      });
    });
  });
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

function writeRouteMutationCategories(payload: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-route-categories-"));
  tempRoots.push(root);
  const file = path.join(root, "route-mutation-categories.json");
  fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
  return file;
}

// --- Route mutation-category drift check (issue c81e101) ---

// Any instance that refuses operational mutations makes evaluateInstanceMutation
// report the category it derived, which is the authoritative answer cli/api.sh
// has to reproduce. It keeps the private categorizer private.
const CATEGORY_PROBE_INSTANCE: InstanceInfo = {
  role: "preview",
  operational_mutations: "reject",
  operational_mutations_overridden: false,
  db_path: null,
  db_path_source: "default",
};

function authoritativeCategory(method: string, pathname: string): string | null {
  const decision = evaluateInstanceMutation(CATEGORY_PROBE_INSTANCE, method, pathname);
  if (decision.allowed) {
    return null;
  }
  const category = decision.body.category;
  return typeof category === "string" ? category : null;
}

function readInstancePolicySource(): string {
  return fs.readFileSync(path.join(process.cwd(), "src", "instance-policy.ts"), "utf8");
}

function parseOperationalPrefixes(source: string): string[] {
  const block = source.match(/OPERATIONAL_ROUTE_CATEGORIES[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!block) {
    return [];
  }
  return [...block[1].matchAll(/prefix:\s*"([^"]+)"/g)].map((match) => match[1]);
}

function parseSafeUnsafeExceptions(source: string): Array<{ method: string; path: string }> {
  const block = source.match(/SAFE_UNSAFE_ROUTE_EXCEPTIONS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!block) {
    return [];
  }
  return [...block[1].matchAll(/"([A-Z]+) (\/[^"]+)"/g)]
    .map((match) => ({ method: match[1], path: match[2] }));
}

function buildCategoryProbes(
  prefixes: string[],
  exceptions: Array<{ method: string; path: string }>,
): Array<{ method: string; path: string }> {
  const unsafeMethods = ["POST", "PUT", "PATCH", "DELETE"];
  const paths: string[] = [];
  for (const prefix of prefixes) {
    paths.push(prefix, `${prefix}/child`, `${prefix}/child/grandchild`);
  }
  for (const exception of exceptions) {
    paths.push(exception.path, `${exception.path}/child`);
  }
  // Prefix-table misses, the /api catch-all, and non-API paths.
  paths.push("/api", "/api/unregistered-surface", "/api/work", "/api/work-units", "/health");
  // Query strings must be stripped before matching.
  paths.push("/api/projects?scope=all");

  const probes: Array<{ method: string; path: string }> = [];
  const seen = new Set<string>();
  for (const path of paths) {
    for (const method of [...unsafeMethods, "GET", "HEAD", "OPTIONS"]) {
      const key = `${method}|${path}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      probes.push({ method, path });
    }
  }
  return probes;
}

function writeRestartAvailability(port: number, payload: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-restart-receipt-"));
  tempRoots.push(root);
  const file = path.join(root, "restart-availability.json");
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

describe("CLI instance mutation preflight", () => {
  it("fails fast from a fresh rebuild receipt with deliberate human and structured output", async () => {
    const port = 19420;
    const receipt = writeRestartAvailability(port, {
      blocked_window: {
        samples_ms: [18_400, 18_400, 18_400, 18_400, 18_400, 18_400, 18_400],
        average_ms: 18_400,
        sample_count: 7,
      },
    });
    const started = Date.now();
    const result = await runBash([
      "set -euo pipefail",
      "source cli/api.sh",
      "tmp_response=$(mktemp)",
      "status=$(api_send_capture POST /api/ledger/issues/abc/comments '{\"message\":\"Not sent\"}' \"$tmp_response\")",
      "printf '%s\\n' \"$status\"",
      "cat \"$tmp_response\"",
    ].join("\n"), port, {
      MANDIBLE_RESTART_AVAILABILITY_FILE: receipt,
      MANDIBLE_RESTART_AVAILABILITY_NOW_MS: "1000000",
      MANDIBLE_HTTP_RETRY_BASE_MS: "2000",
      MANDIBLE_HTTP_RETRIES: "5",
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(
      "Mandible rebuilding; request not sent (self-merge, about 12 s remaining; average 18.4 s over 7 rebuilds).\n",
    );
    expect(result.stderr).not.toContain("retrying");
    expect(result.stdout).toBe([
      "503",
      "{",
      '  "error": "mandible_restarting",',
      '  "retryable": true,',
      '  "request_sent": false,',
      '  "phase": "rebuilding",',
      '  "reason": "self_merge",',
      '  "sample_count": 7,',
      '  "average_seconds": 18.4,',
      '  "retry_after_seconds": 12,',
      '  "message": "Mandible rebuilding; request not sent (self-merge, about 12 s remaining; average 18.4 s over 7 rebuilds).",',
      '  "category": "ledger"',
      "}",
      "",
    ].join("\n"));
  });

  it("reports first-sample and overdue states without claiming availability", async () => {
    const port = 19422;
    const first = writeRestartAvailability(port, {
      active: {
        generation_id: "first",
        reason: "self_merge",
        phase: "rebuilding",
        rebuild_started_at_ms: 1_000_000,
      },
      blocked_window: { samples_ms: [], average_ms: null, sample_count: 0 },
    });
    const firstResult = await runBash([
      "source cli/api.sh",
      "api_preflight_operational_mutation POST /api/projects",
    ].join("\n"), port, {
      MANDIBLE_RESTART_AVAILABILITY_FILE: first,
      MANDIBLE_RESTART_AVAILABILITY_NOW_MS: "1000000",
    });
    expect(firstResult.status).toBe(75);
    expect(firstResult.stderr).toBe(
      "Mandible rebuilding; request not sent (self-merge; timing estimate unavailable; no completed rebuild samples).\n",
    );

    const overdue = writeRestartAvailability(port, {
      active: {
        generation_id: "overdue",
        reason: "self_merge",
        phase: "shutdown",
        rebuild_started_at_ms: 990_000,
        shutdown_started_at_ms: 997_000,
        expected_ready_at_ms: 999_000,
      },
    });
    const overdueResult = await runBash([
      "source cli/api.sh",
      "api_preflight_operational_mutation POST /api/projects",
    ].join("\n"), port, {
      MANDIBLE_RESTART_AVAILABILITY_FILE: overdue,
      MANDIBLE_RESTART_AVAILABILITY_NOW_MS: "1000000",
    });
    expect(overdueResult.status).toBe(75);
    expect(overdueResult.stderr).toBe(
      "Mandible restarting; request not sent (self-merge, estimate exceeded by 1 s; average 2.5 s over 2 rebuilds).\n",
    );
  });

  it.each([
    ["stale", { active: { generation_id: "old", reason: "self_merge", phase: "rebuilding", rebuild_started_at_ms: 1 } }],
    ["unrelated instance", { instance_key: "http://127.0.0.1:19999" }],
    ["future version", { version: 2 }],
    ["mixed old version", { version: 0, blocked_window: undefined }],
    ["inconsistent statistics", {
      blocked_window: { samples_ms: [18_000, 18_800], average_ms: 1, sample_count: 2 },
    }],
  ])("ignores %s restart state", async (_label, override) => {
    const port = 19423;
    const receipt = writeRestartAvailability(port, override as Record<string, unknown>);
    const result = await runBash([
      "source cli/api.sh",
      "if api_restart_availability_preflight projects; then printf classified; else printf ignored; fi",
    ].join("\n"), port, {
      MANDIBLE_RESTART_AVAILABILITY_FILE: receipt,
      MANDIBLE_RESTART_AVAILABILITY_NOW_MS: "1000000",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ignored");
    expect(result.stderr).toBe("");
  });

  it("ignores malformed restart state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-restart-malformed-"));
    tempRoots.push(root);
    const receipt = path.join(root, "restart-availability.json");
    fs.writeFileSync(receipt, "{not-json\n");
    const result = await runBash([
      "source cli/api.sh",
      "if api_restart_availability_preflight projects; then printf classified; else printf ignored; fi",
    ].join("\n"), 19424, {
      MANDIBLE_RESTART_AVAILABILITY_FILE: receipt,
      MANDIBLE_RESTART_AVAILABILITY_NOW_MS: "1000000",
    });
    expect(result.stdout).toBe("ignored");
    expect(result.stderr).toBe("");
  });

  it("allows mutation immediately after ready while warm completion is still pending", async () => {
    const target = await listenForInstancePreflight({ instance: MAIN_INSTANCE });
    const receipt = writeRestartAvailability(target.port, {
      active: null,
      last_completion: {
        generation_id: "ready-not-warm",
        rebuild_started_at_ms: 980_000,
        shutdown_started_at_ms: 997_000,
        ready_at_ms: 1_000_000,
      },
      ready_to_warm: { samples_ms: [], average_ms: null, sample_count: 0 },
    });
    try {
      const result = await runBash([
        "set -euo pipefail",
        "source cli/api.sh",
        "tmp_response=$(mktemp)",
        "status=$(api_send_capture POST /api/ledger/issues/abc/comments '{\"message\":\"Ready\"}' \"$tmp_response\")",
        "printf '%s\\n' \"$status\"",
        "cat \"$tmp_response\"",
      ].join("\n"), target.port, {
        MANDIBLE_RESTART_AVAILABILITY_FILE: receipt,
        MANDIBLE_RESTART_AVAILABILITY_NOW_MS: "1000001",
      });
      expect(result.stdout).toBe("200\n{\"id\":\"comment-1\"}");
      expect(result.stderr).toBe("");
      expect(target.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET /api/instance",
        "POST /api/ledger/issues/abc/comments",
      ]);
    } finally {
      await target.close();
    }
  });

  it("uses generated route mutation categories before the fallback table", async () => {
    const categoryFile = writeRouteMutationCategories({
      schema: 1,
      routes: [
        { method: "POST", path: "/api/custom/:id/reconcile", category: "custom_generated" },
      ],
    });
    const result = await runBash([
      "set -euo pipefail",
      "source cli/api.sh",
      "api_operational_mutation_category POST /api/custom/abc/reconcile",
    ].join("\n"), 1, { MANDIBLE_ROUTE_MUTATION_CATEGORIES_FILE: categoryFile });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("custom_generated");
  });

  it("falls back to the built-in category table when generated data is malformed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-route-categories-"));
    tempRoots.push(root);
    const categoryFile = path.join(root, "route-mutation-categories.json");
    fs.writeFileSync(categoryFile, "{not-json\n", "utf8");
    const result = await runBash([
      "set -euo pipefail",
      "source cli/api.sh",
      "api_operational_mutation_category POST /api/projects",
    ].join("\n"), 1, { MANDIBLE_ROUTE_MUTATION_CATEGORIES_FILE: categoryFile });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("projects");
  });

  it("keeps auth check out of operational preflight even if generated data lists it", async () => {
    const categoryFile = writeRouteMutationCategories({
      schema: 1,
      routes: [
        { method: "POST", path: "/api/auth/check", category: "auth" },
      ],
    });
    const result = await runBash([
      "set -euo pipefail",
      "source cli/api.sh",
      "if api_operational_mutation_category POST /api/auth/check; then printf bad; else printf bypass; fi",
    ].join("\n"), 1, { MANDIBLE_ROUTE_MUTATION_CATEGORIES_FILE: categoryFile });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("bypass");
  });

  // Issue c81e101 — cli/api.sh carries a hand-maintained copy of the route
  // mutation-category table for the case where the generated JSON is missing or
  // malformed, and it had drifted from src/instance-policy.ts. This is a
  // behavioral drift check: it runs the shell categorizer over every route
  // family the TypeScript source declares and compares each answer with the
  // authoritative decision, so a future edit to one side without the other
  // fails here instead of silently gating (or silently exempting) a route.
  it("keeps the api.sh fallback category table in sync with instance-policy", async () => {
    const source = readInstancePolicySource();
    const prefixes = parseOperationalPrefixes(source);
    const exceptions = parseSafeUnsafeExceptions(source);
    // If either literal is refactored into a shape these patterns no longer
    // read, fail loudly rather than comparing an empty probe set.
    expect(prefixes.length).toBeGreaterThanOrEqual(20);
    expect(exceptions.length).toBeGreaterThanOrEqual(2);

    const probes = buildCategoryProbes(prefixes, exceptions);
    const missingCategoryFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "mandible-route-categories-")),
      "route-mutation-categories.json",
    );
    tempRoots.push(path.dirname(missingCategoryFile));

    const result = await runBash([
      "set -uo pipefail",
      "source cli/api.sh",
      "while IFS='|' read -r probe_method probe_path; do",
      '  [[ -n "$probe_method" ]] || continue',
      '  if probe_category="$(api_operational_mutation_category "$probe_method" "$probe_path")"; then',
      `    printf '%s|%s|%s\\n' "$probe_method" "$probe_path" "$probe_category"`,
      "  else",
      `    printf '%s|%s|-\\n' "$probe_method" "$probe_path"`,
      "  fi",
      'done <<< "$MANDIBLE_TEST_CATEGORY_PROBES"',
    ].join("\n"), 1, {
      MANDIBLE_ROUTE_MUTATION_CATEGORIES_FILE: missingCategoryFile,
      MANDIBLE_TEST_CATEGORY_PROBES: probes
        .map((probe) => `${probe.method}|${probe.path}`)
        .join("\n"),
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual(
      probes.map((probe) => {
        // api.sh takes a request path and strips the query itself; the
        // TypeScript categorizer is always handed a parsed URL pathname.
        const pathname = probe.path.split("?")[0];
        return `${probe.method}|${probe.path}|${authoritativeCategory(probe.method, pathname) ?? "-"}`;
      }),
    );
  });

  it("keeps exempt routes exempt when the generated table is present", async () => {
    // The generator only emits routes that have a category, so an exempt route
    // is absent from the JSON and looks exactly like an unknown route. The
    // exemption therefore has to be applied before the fallback prefix table.
    const categoryFile = writeRouteMutationCategories({
      schema: 1,
      source: "Router.listRoutePolicies",
      routes: [
        { method: "POST", path: "/api/timeline/:id/rows", category: "timeline" },
      ],
      fallbackCategory: "api",
    });
    const result = await runBash([
      "set -uo pipefail",
      "source cli/api.sh",
      "for probe in 'POST /api/timeline/project' 'POST /api/auth/check' 'PUT /api/timeline/project'; do",
      "  set -- $probe",
      '  if category="$(api_operational_mutation_category "$1" "$2")"; then',
      `    printf '%s %s=%s\\n' "$1" "$2" "$category"`,
      "  else",
      `    printf '%s %s=exempt\\n' "$1" "$2"`,
      "  fi",
      "done",
    ].join("\n"), 1, { MANDIBLE_ROUTE_MUTATION_CATEGORIES_FILE: categoryFile });

    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "POST /api/timeline/project=exempt",
      "POST /api/auth/check=exempt",
      // Only the exact method/path pair is exempt, matching the TypeScript set.
      "PUT /api/timeline/project=timeline",
    ]);
  });

  it("refuses operational mutations against preview instances before sending POST", async () => {
    const target = await listenForInstancePreflight();
    try {
      const result = await runBash([
        "set -euo pipefail",
        "source cli/api.sh",
        "tmp_response=$(mktemp)",
        "status=$(api_send_capture POST /api/ledger/issues/abc/comments '{\"message\":\"New comment\"}' \"$tmp_response\")",
        "printf '%s\\n' \"$status\"",
        "cat \"$tmp_response\"",
      ].join("\n"), target.port);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("403\n");
      expect(result.stdout).toContain("cli_instance_mutation_forbidden");
      expect(result.stderr).toContain("Refusing ledger mutation against Mandible preview instance");
      expect(target.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET /api/instance",
      ]);
    } finally {
      await target.close();
    }
  });

  it("allows auth check on preview instances", async () => {
    const target = await listenForInstancePreflight();
    try {
      const result = await runBash([
        "set -euo pipefail",
        "source cli/api.sh",
        "tmp_response=$(mktemp)",
        "status=$(api_send_capture POST /api/auth/check '{\"repo\":\"mandible\"}' \"$tmp_response\")",
        "printf '%s\\n' \"$status\"",
        "cat \"$tmp_response\"",
      ].join("\n"), target.port);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("200\n{\"check\":{\"status\":\"clean\"}}");
      expect(target.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "POST /api/auth/check",
      ]);
    } finally {
      await target.close();
    }
  });

  it("allows operational mutations only with the explicit test override", async () => {
    const target = await listenForInstancePreflight();
    try {
      const result = await runBash([
        "set -euo pipefail",
        "source cli/api.sh",
        "tmp_response=$(mktemp)",
        "status=$(api_send_capture POST /api/ledger/issues/abc/comments '{\"message\":\"New comment\"}' \"$tmp_response\")",
        "printf '%s\\n' \"$status\"",
        "cat \"$tmp_response\"",
      ].join("\n"), target.port, {
        MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("200\n{\"id\":\"comment-1\"}");
      expect(target.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "POST /api/ledger/issues/abc/comments",
      ]);
    } finally {
      await target.close();
    }
  });

  it("retries transient metadata failures before work-unit, session-link, and comment mutations", async () => {
    const mainPayload = { instance: MAIN_INSTANCE };
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
    const retryEnv = {
      MANDIBLE_HTTP_RETRIES: "1",
      MANDIBLE_HTTP_RETRY_BASE_MS: "1",
      MANDIBLE_HTTP_RETRY_MAX_MS: "1",
      MANDIBLE_HTTP_RETRY_JITTER_MS: "0",
    };
    try {
      const claim = await runMandible([
        "work-unit",
        "claim",
        "--issue",
        "abc123",
        "--repo",
        "mandible",
        "--branch",
        "feature/abc123",
      ], target.port, retryEnv);
      const sessionLink = await runMandible([
        "session",
        "link-issue",
        "session-1",
        "--issue",
        "abc123",
        "--repo",
        "mandible",
      ], target.port, retryEnv);
      const comment = await runBash([
        "set -euo pipefail",
        "source cli/api.sh",
        "tmp_response=$(mktemp)",
        "status=$(api_send_capture POST /api/ledger/issues/abc/comments '{\"message\":\"Recovered\"}' \"$tmp_response\")",
        "printf '%s\\n' \"$status\"",
        "cat \"$tmp_response\"",
      ].join("\n"), target.port, retryEnv);

      expect(claim.status).toBe(0);
      expect(sessionLink.status).toBe(0);
      expect(comment.status).toBe(0);
      expect(comment.stdout).toBe("200\n{\"id\":\"comment-1\"}");
      expect(claim.stderr).toContain("Mandible request transient failure; retrying");
      expect(sessionLink.stderr).toContain("Mandible request transient failure; retrying");
      expect(comment.stderr).toContain("Mandible request transient failure; retrying");
      expect(target.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
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
    } finally {
      await target.close();
    }
  });

  it("uses health instance metadata as a compatibility fallback", async () => {
    const target = await listenForInstancePreflight({
      instance: null,
      healthInstance: MAIN_INSTANCE,
    });
    try {
      const result = await runBash([
        "set -euo pipefail",
        "source cli/api.sh",
        "tmp_response=$(mktemp)",
        "status=$(api_send_capture POST /api/ledger/issues/abc/comments '{\"message\":\"Fallback\"}' \"$tmp_response\")",
        "printf '%s\\n' \"$status\"",
        "cat \"$tmp_response\"",
      ].join("\n"), target.port);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("200\n{\"id\":\"comment-1\"}");
      expect(target.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET /api/instance",
        "GET /api/health",
        "POST /api/ledger/issues/abc/comments",
      ]);
    } finally {
      await target.close();
    }
  });

  it("reports exhausted transient metadata unavailability as retryable without sending the mutation", async () => {
    const busyResponses = Array.from({ length: 2 }, () => ({
      status: 503,
      body: { error: "busy" },
    }));
    const target = await listenForInstancePreflight({
      instance: MAIN_INSTANCE,
      instanceResponses: busyResponses,
    });
    try {
      const result = await runBash([
        "set -euo pipefail",
        "source cli/api.sh",
        "tmp_response=$(mktemp)",
        "status=$(api_send_capture POST /api/ledger/issues/abc/comments '{\"message\":\"Not sent\"}' \"$tmp_response\")",
        "printf '%s\\n' \"$status\"",
        "cat \"$tmp_response\"",
      ].join("\n"), target.port, {
        MANDIBLE_HTTP_RETRIES: "1",
        MANDIBLE_HTTP_RETRY_BASE_MS: "1",
        MANDIBLE_HTTP_RETRY_MAX_MS: "1",
        MANDIBLE_HTTP_RETRY_JITTER_MS: "0",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("503\n");
      expect(result.stdout).toContain("cli_instance_metadata_unavailable");
      expect(result.stdout).toContain('"retryable": true');
      expect(result.stdout).not.toContain("cli_instance_metadata_unknown");
      expect(result.stderr).toContain("temporarily unavailable after bounded retries");
      expect(target.requests.some((request) => request.method === "POST")).toBe(false);
      expect(target.requests.filter((request) => request.url === "/api/instance")).toHaveLength(2);
      expect(target.requests.filter((request) => request.url === "/api/health").length).toBeGreaterThanOrEqual(2);
    } finally {
      await target.close();
    }
  });

  it("fails closed when operational mutation target metadata is unavailable", async () => {
    const target = await listenForInstancePreflight({ instance: null });
    try {
      const result = await runBash([
        "set -euo pipefail",
        "source cli/api.sh",
        "tmp_response=$(mktemp)",
        "status=$(api_send_capture POST /api/ledger/issues/abc/comments '{\"message\":\"New comment\"}' \"$tmp_response\")",
        "printf '%s\\n' \"$status\"",
        "cat \"$tmp_response\"",
      ].join("\n"), target.port);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("403\n");
      expect(result.stdout).toContain("cli_instance_metadata_unknown");
      expect(result.stderr).toContain("instance metadata is unavailable");
      expect(result.stderr).toContain("isolated test/dev environments");
      expect(target.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET /api/instance",
        "GET /api/health",
      ]);
    } finally {
      await target.close();
    }
  });

  it.each([
    ["missing fields", {}],
    ["missing policy", { role: "main" }],
    ["invalid role", { role: "copy", operational_mutations: "allow" }],
    ["invalid policy", { role: "main", operational_mutations: "sometimes" }],
  ])("fails closed when operational mutation target metadata is malformed: %s", async (
    _label,
    instance,
  ) => {
    const target = await listenForInstancePreflight({ instance });
    try {
      const result = await runBash([
        "set -euo pipefail",
        "source cli/api.sh",
        "tmp_response=$(mktemp)",
        "status=$(api_send_capture POST /api/ledger/issues/abc/comments '{\"message\":\"New comment\"}' \"$tmp_response\")",
        "printf '%s\\n' \"$status\"",
        "cat \"$tmp_response\"",
      ].join("\n"), target.port);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("403\n");
      expect(result.stdout).toContain("cli_instance_metadata_unknown");
      expect(result.stderr).toContain("instance metadata is unavailable");
      expect(target.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET /api/instance",
      ]);
    } finally {
      await target.close();
    }
  });

  it("refuses project mutations against preview instances before sending POST", async () => {
    const target = await listenForInstancePreflight();
    try {
      const result = await runMandible(["project", "add", "--key", "demo"], target.port);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing projects mutation against Mandible preview instance");
      expect(target.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET /api/instance",
      ]);
    } finally {
      await target.close();
    }
  });

  it("refuses session link mutations against preview instances before sending POST", async () => {
    const target = await listenForInstancePreflight();
    try {
      const result = await runMandible([
        "session",
        "link-issue",
        "session-1",
        "--issue",
        "abc123",
        "--repo",
        "mandible",
      ], target.port);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing sessions mutation against Mandible preview instance");
      expect(target.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET /api/instance",
      ]);
    } finally {
      await target.close();
    }
  });

  it("refuses inbox ack mutations from the direct inbox script before sending POST", async () => {
    const target = await listenForInstancePreflight();
    try {
      const result = await runMandible(["inbox", "ack", "auth_result", "item-1"], target.port);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing inbox mutation against Mandible preview instance");
      expect(target.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET /api/instance",
      ]);
    } finally {
      await target.close();
    }
  });

  it("refuses session registration from wrap before sending POST", async () => {
    const target = await listenForInstancePreflight();
    try {
      const result = await runMandible([
        "wrap",
        "--app",
        "test",
        "--id",
        "session-1",
        "--",
        "true",
      ], target.port);

      expect(result.status).toBe(0);
      expect(target.requests.some((request) => request.url === "/api/instance")).toBe(true);
      expect(target.requests.some((request) => request.method === "POST")).toBe(false);
      expect(target.requests.some((request) => request.method === "PATCH")).toBe(false);
    } finally {
      await target.close();
    }
  });

  it("refuses task session updates before sending PATCH", async () => {
    const target = await listenForInstancePreflight();
    try {
      const result = await runMandible(["task", "Fixing preview guard"], target.port);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing sessions mutation against Mandible preview instance");
      expect(target.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        expect.stringMatching(/^GET \/api\/sessions\/by-pid\/\d+$/),
        "GET /api/instance",
      ]);
    } finally {
      await target.close();
    }
  });
});
