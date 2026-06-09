import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");

let tempDir = "";

function run(args: string[], cwd = tempDir): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(CLI, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MANDIBLE_PORT: "9" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(args: string[], cwd = tempDir): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
}

function createCommittedRepo(): void {
  fs.writeFileSync(path.join(tempDir, "report.md"), "# Report\n\nReady.\n", "utf8");
  git(["init"]);
  git(["config", "user.name", "Mandible Test"]);
  git(["config", "user.email", "mandible-test@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "report.md"]);
  git(["commit", "-m", "add report"]);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-cli-"));
  createCommittedRepo();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("artifact CLI", () => {
  it("documents the artifact command surface", () => {
    const result = run(["artifact", "--help"], process.cwd());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mandible artifact ingest <path...>");
    expect(result.stdout).toContain("mandible artifact snapshot <artifact-ref> --from <path>");
    expect(result.stdout).toContain("mandible artifact bundle create");
    expect(result.stdout).toContain("Recoverability:");
  });

  it("classifies clean tracked files as commit-pinned repo links in dry-run JSON", () => {
    const result = run(["artifact", "ingest", "report.md", "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const planned = payload.registered[0].planned_payload;
    expect(planned.uri).toMatch(/^repo:\/\/mandible-artifact-cli-/);
    expect(planned.uri).toContain("@");
    expect(planned.metadata.recoverability).toBe("repo_commit");
    expect(planned.metadata.git.tracked).toBe(true);
    expect(planned.metadata.git.dirty).toBe(false);
    expect(planned.metadata.warnings).toEqual([]);
  });

  it("redacts copied bytes from snapshot dry-run JSON", () => {
    const result = run(["artifact", "snapshot", "report.md", "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const planned = payload.registered[0].planned_payload;
    expect(planned.custody_mode).toBe("copy");
    expect(planned.metadata.recoverability).toBe("mandible_cas");
    expect(planned.content_base64).toBe("<base64 omitted in dry-run>");
  });

  it("keeps untracked repo-local files local-only instead of minting repo URIs", () => {
    fs.mkdirSync(path.join(tempDir, "_artifacts"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "_artifacts", "checkpoint.bin"), "checkpoint\n", "utf8");

    const result = run(["artifact", "ingest", "_artifacts/checkpoint.bin", "--allow-local-only", "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const planned = payload.registered[0].planned_payload;
    expect(planned.uri).toMatch(/^file:\/\//);
    expect(planned.canonical_ref).toMatch(/^artifact:[a-f0-9]{64}$/);
    expect(planned.metadata.recoverability).toBe("local_only");
    expect(planned.metadata.git.untracked).toBe(true);
    expect(planned.metadata.warnings.map((warning: { code: string }) => warning.code)).toContain("untracked_local_only");
  });

  it("previews bundle identity while preserving member recoverability in dry-run JSON", () => {
    const result = run(["artifact", "bundle", "create", "--name", "smoke", "report.md", "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.planned_payload.role).toBe("run_packet");
    expect(payload.planned_payload.reference.identity_kind).toBe("bundle_manifest");
    expect(payload.members[0].artifact.recoverability).toBe("repo_commit");
    expect(payload.planned_payload.json.members[0].ref).toContain("repo://");
  });
});
