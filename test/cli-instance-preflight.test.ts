import http from "node:http";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

type RecordedRequest = {
  method: string;
  url: string;
  body: string;
};

let server: http.Server | null = null;

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

function listenForInstancePreflight() {
  const requests: RecordedRequest[] = [];
  server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({ method: req.method ?? "GET", url: req.url ?? "/", body: raw });
      if (req.method === "GET" && req.url === "/api/instance") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          instance: {
            role: "preview",
            operational_mutations: "reject",
            operational_mutations_overridden: true,
            db_path: "/tmp/mandible-preview.db",
            db_path_source: "iab-preview-copy",
            source_db_path: "/tmp/mandible-main.db",
            source_db_path_source: "env",
          },
        }));
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
});

describe("CLI instance mutation preflight", () => {
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
});
