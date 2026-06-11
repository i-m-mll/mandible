import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");

function run(
  args: string[],
  extraEnv: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MANDIBLE_PORT: "9",
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
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function startFileRpcRecorder(spoolDir: string): { timer: NodeJS.Timeout; requests: Array<Record<string, unknown>> } {
  fs.mkdirSync(spoolDir, { recursive: true });
  const requests: Array<Record<string, unknown>> = [];
  const timer = setInterval(() => {
    for (const file of fs.readdirSync(spoolDir)) {
      if (!file.endsWith(".request.json")) continue;
      const requestPath = path.join(spoolDir, file);
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as Record<string, unknown>;
      requests.push(request);
      const id = String(request.id ?? file.replace(/\.request\.json$/, ""));
      const body = request.method === "GET"
        ? { actions: [{ id: "act1", ordinal: 1, kind: "comment_add", target_issue_ref: "abc", state: "staged" }] }
        : { action: { id: "act1" }, action_id: "act1", deleted: true };
      fs.writeFileSync(
        path.join(spoolDir, `${id}.response.json`),
        JSON.stringify({ id, status: 200, body }),
        "utf8",
      );
      fs.rmSync(requestPath, { force: true });
    }
  }, 10);
  return { timer, requests };
}

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("auth action CLI", () => {
  it("lists and mutates staged actions through file RPC", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-action-cli-"));
    tempDirs.push(spoolDir);
    const recorder = startFileRpcRecorder(spoolDir);
    const env = {
      MANDIBLE_BASE: `file://${spoolDir}`,
      MANDIBLE_FILE_RPC_TIMEOUT: "5",
    };

    try {
      const list = await run(["auth", "action", "list", "req1", "--json"], env);
      expect(list.status).toBe(0);
      expect(JSON.parse(list.stdout).actions).toHaveLength(1);

      const add = await run([
        "auth",
        "action",
        "add",
        "req1",
        "--kind",
        "comment_add",
        "--issue",
        "abc",
        "--body",
        "Hello",
      ], env);
      expect(add.status).toBe(0);

      const edit = await run([
        "auth",
        "action",
        "edit",
        "req1",
        "act1",
        "--kind",
        "label_add",
        "--issue",
        "abc",
        "--label",
        "ready",
      ], env);
      expect(edit.status).toBe(0);

      const rm = await run(["auth", "action", "rm", "req1", "act1"], env);
      expect(rm.status).toBe(0);

      expect(recorder.requests.map((request) => [request.method, request.path])).toEqual([
        ["GET", "/api/auth/request/req1/actions"],
        ["POST", "/api/auth/request/req1/actions"],
        ["PUT", "/api/auth/request/req1/actions/act1"],
        ["DELETE", "/api/auth/request/req1/actions/act1"],
      ]);
      expect(recorder.requests[1].body).toMatchObject({
        kind: "comment_add",
        target_issue_ref: "abc",
        payload: { body: "Hello" },
      });
      expect(recorder.requests[2].body).toMatchObject({
        kind: "label_add",
        target_issue_ref: "abc",
        payload: { label: "ready" },
      });
    } finally {
      clearInterval(recorder.timer);
    }
  });
});
