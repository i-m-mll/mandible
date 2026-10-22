import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { startFileRpcResponder } from "./helpers/file-rpc-responder.js";

const CLI = path.join(process.cwd(), "bin", "mandible");
const guards = ["--expected-revision", "0", "--expected-custody-generation", "2"];

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
    const recorder = startFileRpcResponder(spoolDir, (request) => ({
      status: 200,
      body: request.method === "GET"
        ? { actions: [{ id: "act1", ordinal: 1, kind: "comment_add", target_issue_ref: "abc", state: "staged" }] }
        : { action: { id: "act1" }, action_id: "act1", deleted: true },
    }));
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
        ...guards,
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
        "--expected-revision", "1", "--expected-custody-generation", "3",
      ], env);
      expect(edit.status).toBe(0);

      const rm = await run(["auth", "action", "rm", "req1", "act1", "--expected-revision", "2", "--expected-custody-generation", "3"], env);
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
        expected_revision: 0,
        expected_custody_generation: 2,
      });
      expect(recorder.requests[2].body).toMatchObject({
        kind: "label_add",
        target_issue_ref: "abc",
        payload: { label: "ready" },
        expected_revision: 1,
        expected_custody_generation: 3,
      });
      expect(recorder.requests[3].body).toEqual({ expected_revision: 2, expected_custody_generation: 3 });
    } finally {
      recorder.stop();
    }
  });
  it("rejects missing and invalid guards before writing a transport request", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-action-guards-"));
    tempDirs.push(spoolDir);
    const env = { MANDIBLE_BASE: `file://${spoolDir}`, MANDIBLE_FILE_RPC_TIMEOUT: "1" };
    for (const subcommand of ["add", "edit", "rm"]) {
      const args = ["auth", "action", subcommand, "req1",
        ...(subcommand === "add" ? [] : ["act1"]),
        ...(subcommand === "rm" ? [] : ["--kind", "comment_add", "--issue", "abc", "--body", "Hello"])];
      for (const flag of ["--expected-revision", "--expected-custody-generation"]) {
        const other = flag === "--expected-revision" ? "--expected-custody-generation" : "--expected-revision";
        for (const invalid of [undefined, "-1", "1.5", "wrong", "9007199254740992"]) {
          const result = await run([...args, other, "2", ...(invalid === undefined ? [] : [flag, invalid])], env);
          expect(result.status, result.stderr).toBe(2);
          expect(result.stderr).toContain(flag);
          expect(fs.readdirSync(spoolDir).filter((file) => file.endsWith(".request.json"))).toEqual([]);
        }
      }
    }
  }, 30_000);
});
