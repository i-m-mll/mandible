import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");
const CLI_TEST_ENV = {
  MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1",
};

let tempDir = "";
let tempRoots: string[] = [];

function run(
  args: string[],
  cwd = tempDir,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(CLI, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MANDIBLE_PORT: "9", ...CLI_TEST_ENV, ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAsync(
  args: string[],
  cwd = tempDir,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd,
      env: { ...process.env, MANDIBLE_PORT: "9", ...CLI_TEST_ENV, ...extraEnv },
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

function startFileRpcResponder(
  spoolDir: string,
  handler: (request: Record<string, unknown>) => { status: number; body: unknown },
): NodeJS.Timeout {
  fs.mkdirSync(spoolDir, { recursive: true });
  const timer = setInterval(() => {
    for (const file of fs.readdirSync(spoolDir)) {
      if (!file.endsWith(".request.json")) continue;
      const requestPath = path.join(spoolDir, file);
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as Record<string, unknown>;
      const id = typeof request.id === "string" ? request.id : file.replace(/\.request\.json$/, "");
      const response = handler(request);
      fs.writeFileSync(
        path.join(spoolDir, `${id}.response.json`),
        JSON.stringify({ id, ...response }),
        "utf8",
      );
      fs.rmSync(requestPath, { force: true });
    }
  }, 10);
  return timer;
}

interface RecordedRequest {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

function startHttpRecorder(
  handler: (req: RecordedRequest) => { status: number; body: unknown },
): Promise<{ port: number; requests: RecordedRequest[]; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | undefined;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      } catch {
        body = undefined;
      }
      const recorded: RecordedRequest = { method: req.method ?? "GET", url: req.url ?? "/", body };
      requests.push(recorded);
      const result = handler(recorded);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
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
  tempRoots = [];
  createCommittedRepo();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

  it("documents the version identity command surface", () => {
    const result = run(["artifact", "--help"], process.cwd());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("artifact:<id>             logical artifact");
    expect(result.stdout).toContain("artifact-blob:<hash>      immutable artifact bytes");
    expect(result.stdout).toContain("mandible artifact associate <ref> --project <project>");
    expect(result.stdout).toContain("mandible artifact versions <ref>");
    expect(result.stdout).toContain("mandible artifact diff <refA> <refB>");
    expect(result.stdout).toContain("mandible artifact record <path> --kind tracked_repo|local_only|managed");
  });

  it("prints canonical resolve targets and repair warnings", async () => {
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url.startsWith("/api/artifacts/resolve?")) {
        return {
          status: 200,
          body: {
            resolution: {
              status: "resolved",
              target_type: "artifact_blob",
              target_id: "artifact-blob:abc123",
              normalized_ref: "artifact-blob:abc123",
              artifact: { id: "artifact:sha256:abc123" },
              warnings: ["legacy_artifact_ref_read_only", "repair_to_artifact_blob_ref"],
            },
          },
        };
      }
      return { status: 404, body: { error: "unexpected" } };
    });

    try {
      const result = await runAsync(["artifact", "resolve", "artifact:sha256:abc123"], tempDir, {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("resolved artifact_blob artifact-blob:abc123 artifact-blob:abc123");
      expect(result.stdout).toContain("warning: legacy_artifact_ref_read_only");
      expect(result.stdout).toContain("warning: repair_to_artifact_blob_ref");
    } finally {
      await recorder.close();
    }
  });

  it("rejects an unknown record kind without contacting the daemon", () => {
    const result = run(["artifact", "record", "report.md", "--kind", "bogus"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown --kind");
  });

  it("preserves zsh PATH while recording a local artifact version", async () => {
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "POST" && req.url === "/api/artifacts/versions") {
        return {
          status: 200,
          body: {
            result: {
              created: true,
              artifact: { id: "artifact:sha256:abc123" },
              series: { id: "artifact-series:series-1", source_kind: "local_only", version_count: 1 },
              version: { id: "artifact-version:version-1", version_no: 1 },
            },
          },
        };
      }
      return { status: 404, body: { error: "unexpected" } };
    });

    try {
      const result = await runAsync(["artifact", "record", "report.md", "--kind", "local_only", "--json"], tempDir, {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("curl not found");
      const record = recorder.requests.find((entry) => entry.url === "/api/artifacts/versions");
      expect(record).toBeDefined();
      expect(record!.body).toMatchObject({ source_kind: "local_only" });
      expect(fs.realpathSync(record!.body!.path as string)).toBe(
        fs.realpathSync(path.join(tempDir, "report.md")),
      );
    } finally {
      await recorder.close();
    }
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

  it("computes copy snapshot identity without generating base64 in dry-run JSON", () => {
    const result = run(["artifact", "snapshot", "report.md", "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const planned = payload.registered[0].planned_payload;
    expect(planned.custody_mode).toBe("copy");
    expect(planned.metadata.recoverability).toBe("mandible_cas");
    expect(planned.sha256).toMatch(/^[a-f0-9]{64}$/);
    // Bytes never travel through dry-run: no inline base64, just a transport note.
    expect(planned).not.toHaveProperty("content_base64");
    expect(planned).not.toHaveProperty("content_path");
    expect(planned.content_transport).toMatch(/path or file-RPC attachment/);
  });

  it("auto-selects copy custody for file RPC path ingest dry-runs", () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);

    const result = run(["artifact", "ingest", "report.md", "--dry-run", "--json"], tempDir, {
      MANDIBLE_BASE: `file://${spoolDir}`,
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const planned = payload.registered[0].planned_payload;
    expect(payload.custody_mode).toBe("copy");
    expect(planned.custody_mode).toBe("copy");
    expect(planned.metadata.recoverability).toBe("mandible_cas");
    expect(planned).not.toHaveProperty("content_base64");
    expect(planned.content_transport).toMatch(/path or file-RPC attachment/);
  });

  it("rejects explicit link custody in file RPC upload mode", () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);

    const result = run(["artifact", "ingest", "report.md", "--link", "--dry-run", "--json"], tempDir, {
      MANDIBLE_BASE: `file://${spoolDir}`,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("link custody requires daemon-visible host paths");
  });

  it("sends snapshot bytes through a file RPC attachment, not inline base64", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];
    const attachmentReads: Array<{ ref: unknown; bytes: string }> = [];
    const timer = startFileRpcResponder(spoolDir, (request) => {
      seen.push(request);
      if (request.method === "GET" && request.path === "/api/ledger/issues/abc") {
        return {
          status: 200,
          body: { id: "issue-1", display_id: "abc", project: { repo_id: "mandible" } },
        };
      }
      if (request.method === "POST" && request.path === "/api/artifacts/ingest") {
        const body = request.body as Record<string, unknown>;
        // The real transport injects content_path from the attachment; the mock
        // daemon reads the attachment the CLI staged in the spool dir.
        const attachments = request.attachments as Record<string, string> | undefined;
        const attachmentName = attachments?.content_path;
        const bytes = typeof attachmentName === "string"
          ? fs.readFileSync(path.join(spoolDir, attachmentName), "utf8")
          : "";
        attachmentReads.push({ ref: body, bytes });
        return {
          status: 200,
          body: {
            artifact: {
              id: "artifact:sha256:deadbeef",
              custody_mode: "copy",
              availability: "present",
              metadata: { recoverability: "mandible_cas" },
            },
          },
        };
      }
      return { status: 404, body: { error: "unexpected", path: request.path } };
    });

    try {
      const result = await runAsync(["artifact", "snapshot", "report.md", "--issue", "abc", "--json"], tempDir, {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).registered[0].artifact).toMatchObject({
        custody_mode: "copy",
        availability: "present",
      });
      expect(seen.map((request) => request.path)).toEqual([
        "/api/ledger/issues/abc",
        "/api/artifacts/ingest",
      ]);
      const ingest = seen.find((request) => request.path === "/api/artifacts/ingest")!;
      const ingestBody = ingest.body as Record<string, unknown>;
      expect(ingestBody).toMatchObject({ custody_mode: "copy", filename: "report.md", media_type: "text/plain" });
      // Bytes are NOT inline in the request body — they ride as an attachment.
      expect(ingestBody).not.toHaveProperty("content_base64");
      expect(ingestBody).not.toHaveProperty("content_path");
      expect((ingest.attachments as Record<string, string>).content_path).toMatch(/\.attach-content_path$/);
      expect(attachmentReads).toHaveLength(1);
      expect(attachmentReads[0].bytes).toBe("# Report\n\nReady.\n");
    } finally {
      clearInterval(timer);
    }
  });

  it("links snapshot-from-ref results using canonical artifact ids", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);
    const sourceRef = `artifact:sha256:${"a".repeat(64)}`;
    const newRef = `artifact:sha256:${"b".repeat(64)}`;
    const seen: Array<Record<string, unknown>> = [];
    const timer = startFileRpcResponder(spoolDir, (request) => {
      seen.push(request);
      if (request.method === "GET" && request.path === "/api/ledger/issues/abc") {
        return {
          status: 200,
          body: { id: "issue-1", display_id: "abc", project: { repo_id: "mandible" } },
        };
      }
      if (request.method === "POST" && request.path === "/api/artifacts/snapshot") {
        return {
          status: 200,
          body: {
            artifact: {
              id: newRef,
              custody_mode: "copy",
              availability: "present",
            },
          },
        };
      }
      if (request.method === "POST" && request.path === "/api/artifacts/link") {
        return {
          status: 200,
          body: {
            link: {
              id: "artifact-link-1",
              artifact_id: newRef,
              entity_type: "issue",
              entity_id: "issue-1",
              link_type: "references",
            },
          },
        };
      }
      return { status: 404, body: { error: "unexpected", path: request.path } };
    });

    try {
      const result = await runAsync(
        ["artifact", "snapshot", sourceRef, "--from", "report.md", "--issue", "abc", "--json"],
        tempDir,
        {
          MANDIBLE_BASE: `file://${spoolDir}`,
          MANDIBLE_FILE_RPC_TIMEOUT: "5",
        },
      );

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.artifact.id).toBe(newRef);
      expect(payload.link.artifact_id).toBe(newRef);
      expect(seen.map((request) => request.path)).toEqual([
        "/api/ledger/issues/abc",
        "/api/artifacts/snapshot",
        "/api/artifacts/link",
      ]);
      expect(seen[1].body).toMatchObject({ ref: sourceRef, custody_mode: "copy" });
      expect(seen[2].body).toMatchObject({
        ref: newRef,
        entity_type: "issue",
        entity_id: "issue-1",
        link_type: "references",
      });
    } finally {
      clearInterval(timer);
    }
  });

  it("carries a multi-MiB file RPC snapshot through an attachment, never argv (issue 833e972)", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);
    fs.mkdirSync(path.join(tempDir, "_artifacts"), { recursive: true });
    const bigPath = path.join(tempDir, "_artifacts", "big.bin");
    const bigBytes = Buffer.alloc(2 * 1024 * 1024, 0x5a); // 2 MiB, far over ARG_MAX
    fs.writeFileSync(bigPath, bigBytes);

    let attachmentSize = -1;
    const timer = startFileRpcResponder(spoolDir, (request) => {
      if (request.method === "POST" && request.path === "/api/artifacts/ingest") {
        const attachments = request.attachments as Record<string, string> | undefined;
        const name = attachments?.content_path;
        attachmentSize = typeof name === "string" ? fs.statSync(path.join(spoolDir, name)).size : -1;
        return {
          status: 200,
          body: { artifact: { id: "artifact:sha256:big", custody_mode: "copy", availability: "present" } },
        };
      }
      return { status: 404, body: { error: "unexpected" } };
    });

    try {
      const result = await runAsync(["artifact", "snapshot", "_artifacts/big.bin", "--json"], tempDir, {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "10",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(/argument list too long/);
      // The full 2 MiB rode as a spool attachment, not in the JSON body/argv.
      expect(attachmentSize).toBe(bigBytes.length);
    } finally {
      clearInterval(timer);
    }
  });

  it("reports file RPC issue resolver errors with the response detail", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);
    const timer = startFileRpcResponder(spoolDir, () => ({
      status: 404,
      body: { error: "issue_missing" },
    }));

    try {
      const result = await runAsync(["artifact", "snapshot", "report.md", "--issue", "missing", "--json"], tempDir, {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("HTTP 404: issue_missing");
    } finally {
      clearInterval(timer);
    }
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

  it("resolves a feature-worktree _artifacts symlink to a durable realpath URI in dry-run JSON (issue 2f9c3c3)", () => {
    // Persistent repo-root _artifacts target, reached from a feature worktree
    // through a symlink — the disposable-path scenario.
    const persistentArtifacts = path.join(tempDir, "_artifacts");
    fs.mkdirSync(persistentArtifacts, { recursive: true });
    fs.writeFileSync(path.join(persistentArtifacts, "plot.html"), "<html>plot</html>\n", "utf8");
    const featWorktree = path.join(tempDir, "worktrees", "feat");
    fs.mkdirSync(path.dirname(featWorktree), { recursive: true });
    git(["worktree", "add", "-b", "feat", featWorktree]);
    fs.symlinkSync(persistentArtifacts, path.join(featWorktree, "_artifacts"));
    const disposable = path.join(featWorktree, "_artifacts", "plot.html");
    const persistentReal = fs.realpathSync(path.join(persistentArtifacts, "plot.html"));

    const result = run(["artifact", "ingest", disposable, "--allow-local-only", "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    const planned = JSON.parse(result.stdout).registered[0].planned_payload;
    expect(planned.uri).toBe(`file://${persistentReal}`);
    expect(planned.uri).not.toContain(`${path.sep}feat${path.sep}`);
    expect(planned.metadata.recoverability).toBe("local_only");
    expect(planned.metadata.path_decision.symlink_class).toBe("same_repo_durable");
    expect(planned.metadata.path_decision.worktree_substitution).toBe(true);
    // The disposable input path is preserved as metadata, never as the only ref.
    expect(planned.metadata.input_path).toBe(disposable);
    expect(planned.metadata.warnings.map((warning: { code: string }) => warning.code))
      .toContain("symlink_resolved_to_durable_target");
  });

  it("sends a daemon-visible content_path (not base64) for local HTTP copy ingest (issue 833e972)", async () => {
    fs.mkdirSync(path.join(tempDir, "_artifacts"), { recursive: true });
    const bigPath = path.join(tempDir, "_artifacts", "packet.zip");
    fs.writeFileSync(bigPath, Buffer.alloc(2 * 1024 * 1024, 7)); // 2 MiB, over ARG_MAX

    const recorder = await startHttpRecorder((req) => {
      if (req.method === "POST" && req.url === "/api/artifacts/ingest") {
        const body = req.body as Record<string, unknown>;
        return {
          status: 200,
          body: {
            artifact: {
              id: `artifact:sha256:${body.sha256}`,
              custody_mode: "copy",
              availability: "present",
            },
          },
        };
      }
      return { status: 404, body: { error: "unexpected" } };
    });

    try {
      const result = await runAsync(["artifact", "ingest", "_artifacts/packet.zip", "--copy", "--json"], tempDir, {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });

      expect(result.status).toBe(0);
      const ingest = recorder.requests.find((entry) => entry.url === "/api/artifacts/ingest");
      expect(ingest).toBeDefined();
      const body = ingest!.body as Record<string, unknown>;
      // Bytes never travel in-band: a daemon-visible absolute path is sent.
      // (realpath comparison: macOS resolves /var -> /private/var for the cwd.)
      expect(body).not.toHaveProperty("content_base64");
      expect(body).not.toHaveProperty("content_buffer");
      expect(fs.realpathSync(body.content_path as string)).toBe(fs.realpathSync(bigPath));
      expect(body.custody_mode).toBe("copy");
      expect(body.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await recorder.close();
    }
  });

  it("reports an explicit failure when the daemon does not store path-based bytes (issue 833e972)", async () => {
    fs.mkdirSync(path.join(tempDir, "_artifacts"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "_artifacts", "packet.zip"), Buffer.alloc(1024 * 1024, 3));

    // Simulate an older daemon: it ignores content_path and stores a hash-only
    // record (availability "unchecked") rather than copying the bytes.
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "POST" && req.url === "/api/artifacts/ingest") {
        const body = req.body as Record<string, unknown>;
        return {
          status: 200,
          body: {
            artifact: { id: `artifact:sha256:${body.sha256}`, custody_mode: "external", availability: "unchecked" },
          },
        };
      }
      return { status: 404, body: { error: "unexpected" } };
    });

    try {
      const result = await runAsync(["artifact", "ingest", "_artifacts/packet.zip", "--copy", "--json"], tempDir, {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });

      expect(result.status).not.toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.failed).toHaveLength(1);
      expect(payload.failed[0].error).toMatch(/daemon_did_not_store_bytes/);
      // Never a raw "argument list too long" / transport-level leak.
      expect(result.stderr).not.toMatch(/argument list too long/);
    } finally {
      await recorder.close();
    }
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
