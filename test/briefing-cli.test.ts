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

function runRpc(
  args: string[],
  handle: (request: FileRpcRequest) => { status: number; body: unknown },
): Promise<{ status: number | null; stdout: string; requests: FileRpcRequest[] }> {
  const responder = startFileRpcResponder(spoolDir, handle);
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
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

function runCreate(): Promise<{ status: number | null; stdout: string; requests: FileRpcRequest[] }> {
  return runRpc(["briefing", "create", "artifact-version:4c62bc989c2b7a6f48583eb9eca871e8",
    "--title", "AGENTS review", "--comparison-base", "artifact-version:11111111111111111111111111111111", "--json"], (request) => {
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
}

describe("briefing CLI", () => {
  it("documents and validates exact-version creation", () => {
    expect(runOffline(["help"]).stdout).toContain("briefing create <version-ref>");
    expect(runOffline(["briefing", "--help"]).stdout).toContain("mandible briefing create");
    expect(runOffline(["briefing", "bundle", "--help"]).stdout).toContain("mandible briefing bundle create");
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

  it("supports create, append, and show for ordered Briefing bundles", async () => {
    const bundle = { id: "bundle-12345678", name: "Agent policy", created_at: 1, updated_at: 1,
      members: [{ position: 0, briefing: { id: "briefing-one", title: "Global", briefing_key: "global",
        latest_round_id: "round-1", round_count: 1, created_at: 1, updated_at: 1 } }] };
    const created = await runRpc(["briefing", "bundle", "create", "--name", "Agent policy",
      "briefing-one", "--json"], (request) => {
      expect(request).toMatchObject({ method: "POST", path: "/api/briefing-bundles",
        body: { name: "Agent policy", briefing_refs: ["briefing-one"] } });
      return { status: 201, body: { bundle } };
    });
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ bundle: { id: "bundle-12345678" } });

    const added = await runRpc(["briefing", "bundle", "add", "bundle-12345678", "briefing-two", "--json"],
      (request) => {
        expect(request).toMatchObject({ method: "POST", path: "/api/briefing-bundles/bundle-12345678/briefings",
          body: { briefing_ref: "briefing-two" } });
        return { status: 200, body: { bundle, added: true } };
      });
    expect(added.status).toBe(0);

    const shown = await runRpc(["briefing", "bundle", "show", "bundle-12345678", "--json"], (request) => {
      expect(request).toMatchObject({ method: "GET", path: "/api/briefing-bundles/bundle-12345678" });
      return { status: 200, body: { bundle } };
    });
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).bundle.members).toHaveLength(1);
  });
});
