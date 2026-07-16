import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

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

describe("CLI instance mutation preflight", () => {
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
