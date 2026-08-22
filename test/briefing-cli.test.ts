import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFileRpcResponder, type FileRpcRequest } from "./helpers/file-rpc-responder.js";

const CLI = path.join(process.cwd(), "bin", "mandible");
let spoolDir = "";

beforeEach(() => { spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-briefing-cli-")); });
afterEach(() => { fs.rmSync(spoolDir, { recursive: true, force: true }); });

function runOffline(args: string[]) {
  const result = spawnSync(CLI, args, { encoding: "utf8", env: { ...process.env, MANDIBLE_PORT: "9" } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runCreate(): Promise<{ status: number | null; stdout: string; requests: FileRpcRequest[] }> {
  const responder = startFileRpcResponder(spoolDir, (request) => {
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/api/briefings");
    expect(request.body).toEqual({
      artifact_version_ref: "artifact-version:4c62bc989c2b7a6f48583eb9eca871e8",
      comparison_base_artifact_version_ref: "artifact-version:11111111111111111111111111111111",
      title: "AGENTS review",
    });
    return { status: 201, body: {
      receipt_id: "round-1", briefing_id: "briefing-1", run_id: "artifact:v1",
      round_id: "round-1", artifact_version_id: "version-1", quiet: false,
    } };
  });
  return new Promise((resolve) => {
    const child = spawn(CLI, ["briefing", "create", "artifact-version:4c62bc989c2b7a6f48583eb9eca871e8",
      "--title", "AGENTS review", "--comparison-base", "artifact-version:11111111111111111111111111111111", "--json"], {
      env: { ...process.env, MANDIBLE_BASE: `file://${spoolDir}`, MANDIBLE_FILE_RPC_TIMEOUT: "5",
        MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1" },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (status) => {
      responder.stop();
      resolve({ status, stdout, requests: responder.requests });
    });
  });
}

describe("briefing CLI", () => {
  it("documents and validates exact-version creation", () => {
    expect(runOffline(["help"]).stdout).toContain("briefing create <version-ref>");
    expect(runOffline(["briefing", "--help"]).stdout).toContain("mandible briefing create");
    const logical = runOffline(["briefing", "create", "artifact:logical", "--title", "Review"]);
    expect(logical.status).toBe(2);
    expect(logical.stderr).toContain("exact artifact-version");
    const logicalBase = runOffline(["briefing", "create", "artifact-version:exact", "--title", "Review",
      "--comparison-base", "artifact:logical"]);
    expect(logicalBase.status).toBe(2);
    expect(logicalBase.stderr).toContain("--comparison-base requires one exact artifact-version");
  });

  it("posts the exact version and title through the supported API", async () => {
    const result = await runCreate();
    expect(result.status).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ briefing_id: "briefing-1", round_id: "round-1" });
  });
});
