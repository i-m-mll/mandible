import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");
let server: http.Server | null = null;

afterEach(() => new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve()));

function run(args: string[], port: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd: process.cwd(),
      env: { ...process.env, MANDIBLE_BASE: `http://127.0.0.1:${port}` },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("mandible changes", () => {
  it("passes the bounded feed parameters through and prints authoritative JSON", async () => {
    let requested = "";
    server = http.createServer((req, res) => {
      requested = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        schema: "mandible-ledger-change-feed@1",
        changes: [],
        high_water_mark: 7,
        next_cursor: "next.cursor",
      }));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const result = await run([
      "changes", "--project", "alpha project", "--cursor", "old.cursor",
      "--limit", "25", "--schema", "mandible-ledger-change-feed@1", "--json",
    ], address.port);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ high_water_mark: 7, next_cursor: "next.cursor" });
    const url = new URL(requested, "http://localhost");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      project: "alpha project",
      cursor: "old.cursor",
      limit: "25",
      schema: "mandible-ledger-change-feed@1",
    });
  });

  it("surfaces fail-closed feed errors", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "retention_gap", error: "controlled resync required" }));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const result = await run(["changes", "--project", "alpha", "--cursor", "stale"], address.port);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("retention_gap: controlled resync required");
  });
});
