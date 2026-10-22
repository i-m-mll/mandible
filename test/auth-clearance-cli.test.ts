import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";

const CLI = path.join(process.cwd(), "bin", "mandible");

describe("auth clearance CLI", () => {
  it("sends prospective exact scope without requiring a request id", async () => {
    const requests: Array<{ method: string; route: string; payload: unknown }> = [];
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/api/instance") {
        res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
        return;
      }
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        requests.push({ method: req.method!, route: req.url!, payload: JSON.parse(raw) });
        res.end(JSON.stringify({ clearance_id: "clearance123" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
    try {
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(CLI, [
          "auth", "clearance", "create", "--grantee", "agent-a", "--project", "mandible",
          "--base", "develop", "--issue", "de690d2", "--head", "feature/exact",
          "--duration-minutes", "30", "--max-uses", "2", "--json",
        ], { cwd: process.cwd(), env: { ...process.env, MANDIBLE_BASE: `http://127.0.0.1:${address.port}` } });
        let stdout = ""; let stderr = "";
        child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ clearance_id: "clearance123" });
      expect(requests).toEqual([{
        method: "POST", route: "/api/auth/clearances",
        payload: {
          grantee: "agent-a", action: "merge", project: "mandible", base: "develop",
          issue: "de690d2", head: "feature/exact", duration_minutes: 30, max_uses: 2,
        },
      }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
