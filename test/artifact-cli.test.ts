import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFileRpcResponder } from "./helpers/file-rpc-responder.js";

const CLI = path.join(process.cwd(), "bin", "mandible");
const MAIN_INSTANCE_RESPONSE = MAIN_CLI_INSTANCE_RESPONSE;

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
    env: { ...process.env, MANDIBLE_PORT: "9", ...extraEnv },
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
      env: { ...process.env, MANDIBLE_PORT: "9", ...extraEnv },
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
      if (recorded.method === "GET" && recorded.url === "/api/instance") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(MAIN_INSTANCE_RESPONSE));
        return;
      }
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
  it("exposes retained artifact commands in generated help", () => {
    const result = run(["artifact", "--help"], process.cwd());
    expect(result.status, result.stderr).toBe(0);
    for (const command of ["ingest", "snapshot", "bundle create", "associate", "versions", "diff", "record"]) {
      expect(result.stdout).toContain(`mandible artifact ${command} `);
    }
  });

  it("records logical paths atomically and keeps blob-only transport explicit",async()=>{
    const recorder=await startHttpRecorder(req=>({status:200,body:req.body?.paths ? {
      registered:[{version:{ref:'artifact-version:report'}}],failed:[],atomic:true
    } : {artifact:{id:'artifact-blob:abc',ref:'artifact-blob:abc',custody_mode:'managed',availability:'present'}}}));
    try {
      const env={MANDIBLE_BASE:`http://127.0.0.1:${recorder.port}`};
      const normal=await runAsync(['artifact','ingest','report.md','--json'],tempDir,env);
      expect(normal.status).toBe(0);expect(JSON.parse(normal.stdout).registered[0].version.ref).toBe('artifact-version:report');
      expect(recorder.requests[0].body?.paths).toEqual([fs.realpathSync(path.join(tempDir,'report.md'))]);
      const blob=await runAsync(['artifact','ingest','report.md','missing.md','report.md','--blob-only','--json'],tempDir,env);
      expect(blob.status).toBe(1);expect(JSON.parse(blob.stdout).registered).toHaveLength(2);expect(JSON.parse(blob.stdout).failed).toHaveLength(1);
      expect(recorder.requests.every(req=>req.url==='/api/artifacts/ingest')).toBe(true);
    } finally {await recorder.close();}
  });

  it("sends dry-run paths to the canonical planner without uploading bytes",async()=>{
    const recorder=await startHttpRecorder(req=>({status:200,body:{dry_run:true,plans:[{custody_mode:'git'}],registered:[],failed:[]}}));
    try {
      const result=await runAsync(['artifact','ingest','report.md','--dry-run','--json'],tempDir,{MANDIBLE_BASE:`http://127.0.0.1:${recorder.port}`});
      expect(result.status, result.stderr).toBe(0);expect(recorder.requests).toHaveLength(1);
      expect(recorder.requests[0].body).toMatchObject({paths:[fs.realpathSync(path.join(tempDir,'report.md'))],dry_run:true});
      expect(recorder.requests[0].body).not.toHaveProperty('content_base64');
    } finally {await recorder.close();}
  });

  it("prints canonical resolve targets", async () => {
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
              artifact: { id: "artifact:abc123def456" },
              warnings: [],
            },
          },
        };
      }
      return { status: 404, body: { error: "unexpected" } };
    });

    try {
      const result = await runAsync(["artifact", "resolve", "artifact-blob:abc123"], tempDir, {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("resolved artifact_blob artifact-blob:abc123 artifact-blob:abc123");
    } finally {
      await recorder.close();
    }
  });

  it("uses a short blob id's canonical target for artifact show", async () => {
    const hash = "a".repeat(64);
    const shortId = `artifact:${hash.slice(0, 12)}`;
    const canonicalTarget = `artifact-blob:${hash}`;
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url.startsWith("/api/artifacts/resolve?")) {
        return {
          status: 200,
          body: {
            resolution: {
              status: "resolved",
              target_type: "artifact_blob",
              target_id: canonicalTarget,
              artifact: { id: shortId },
            },
          },
        };
      }
      if (req.method === "GET" && req.url === `/api/artifacts/${encodeURIComponent(canonicalTarget)}`) {
        return {
          status: 200,
          body: {
            artifact: {
              id: shortId,
              role: "report",
              custody_mode: "managed",
              availability: "present",
              uri: `cas://${hash}`,
            },
          },
        };
      }
      return { status: 404, body: { error: "unexpected", url: req.url } };
    });

    try {
      const result = await runAsync(["artifact", "show", shortId, "--json"], tempDir, {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).artifact.id).toBe(shortId);
      expect(recorder.requests.map((request) => request.url)).toEqual([
        `/api/artifacts/resolve?ref=${encodeURIComponent(shortId)}`,
        `/api/artifacts/${encodeURIComponent(canonicalTarget)}`,
      ]);
    } finally {
      await recorder.close();
    }
  });

  it("uses a short blob id's canonical target for artifact content", async () => {
    const hash = "b".repeat(64);
    const shortId = `artifact:${hash.slice(0, 12)}`;
    const canonicalTarget = `artifact-blob:${hash}`;
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url.startsWith("/api/artifacts/resolve?")) {
        return {
          status: 200,
          body: {
            resolution: {
              status: "resolved",
              target_type: "artifact_blob",
              target_id: canonicalTarget,
              artifact: { id: shortId },
            },
          },
        };
      }
      if (req.method === "GET" && req.url === `/api/artifacts/${encodeURIComponent(canonicalTarget)}/content`) {
        return {
          status: 200,
          body: { content: { artifact_id: shortId, preview: { text: "compact content\n" } } },
        };
      }
      return { status: 404, body: { error: "unexpected", url: req.url } };
    });

    try {
      const result = await runAsync(["artifact", "content", shortId], tempDir, {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("compact content\n\n");
      expect(recorder.requests.map((request) => request.url)).toEqual([
        `/api/artifacts/resolve?ref=${encodeURIComponent(shortId)}`,
        `/api/artifacts/${encodeURIComponent(canonicalTarget)}/content`,
      ]);
    } finally {
      await recorder.close();
    }
  });

  it("prints unsupported diagnostics for legacy resolve refs", async () => {
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url.startsWith("/api/artifacts/resolve?")) {
        return {
          status: 200,
          body: {
            resolution: {
              status: "unsupported",
              target_id: null,
              normalized_ref: "artifact:abc123def456",
              artifact: null,
              warnings: ["legacy_artifact_ref_unsupported", "repair_to_artifact_blob_ref"],
            },
          },
        };
      }
      return { status: 404, body: { error: "unexpected" } };
    });

    try {
      const result = await runAsync(["artifact", "resolve", `artifact:sha256:${"a".repeat(64)}`], tempDir, {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("unsupported legacy_artifact - artifact:abc123def456");
      expect(result.stdout).not.toContain("artifact:sha256:");
      expect(result.stdout).toContain("warning: legacy_artifact_ref_unsupported");
      expect(result.stdout).toContain("warning: repair_to_artifact_blob_ref");
    } finally {
      await recorder.close();
    }
  });

  it("rejects an unknown record kind without contacting the daemon", () => {
    const result = run(["artifact", "record", "report.md", "--kind", "bogus"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid value for --kind");
  });

  it("preserves zsh PATH while recording a local artifact version", async () => {
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "POST" && req.url === "/api/artifacts/versions") {
        return {
          status: 200,
          body: {
            result: {
              created: true,
              artifact: { id: "artifact:abc123def456" },
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

      expect(result.status, result.stderr).toBe(0);
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

  it.each([
    {
      name: "associate",
      args: ["artifact", "associate", "artifact:deadbeef", "--project", "mandible"],
      route: "/api/artifacts/associations",
      message: "artifact_ref_ambiguous",
    },
    {
      name: "record",
      args: ["artifact", "record", "--ref", "artifact:deadbeef", "--kind", "managed"],
      route: "/api/artifacts/versions",
      message: "artifact_ref_not_resolved",
    },
    {
      name: "bundle create",
      args: ["artifact", "bundle", "create", "--name", "review", "artifact:deadbeef"],
      route: "/api/artifacts/bundles",
      message: "bundle_member_ref_not_resolved",
    },
  ])("surfaces non-2xx API details for $name", async ({ args, route, message }) => {
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "POST" && req.url === route) {
        return { status: 422, body: { error: message } };
      }
      return { status: 404, body: { error: "unexpected" } };
    });

    try {
      const result = await runAsync(args, tempDir, {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`HTTP 422): ${message}`);
    } finally {
      await recorder.close();
    }
  });

  it("auto-selects copy custody for file RPC path ingest dry-runs", () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);

    const result = run(["artifact", "ingest", "report.md", "--dry-run", "--json"], tempDir, {
      MANDIBLE_BASE: `file://${spoolDir}`,
    });

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    const planned = payload.registered[0].planned_payload;
    expect(payload.custody_mode).toBe("managed");
    expect(planned.custody_mode).toBe("managed");
    expect(planned.metadata.recoverability).toBe("mandible_cas");
    expect(planned).not.toHaveProperty("content_base64");
    expect(planned.content_transport).toMatch(/path or file-RPC attachment/);
  });

  it("rejects explicit link custody in file RPC upload mode", () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);

    const result = run(["artifact", "ingest", "report.md", "--git", "--dry-run", "--json"], tempDir, {
      MANDIBLE_BASE: `file://${spoolDir}`,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("git custody requires daemon-visible host paths");
  });

  it("preserves multi-path file RPC attachments and per-item partial failures", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];
    const attachmentReads: Array<{ ref: unknown; bytes: string }> = [];
    const responder = startFileRpcResponder(spoolDir, (request) => {
      seen.push(request);
      if (request.method === "GET" && request.path === "/api/ledger/issues/abc") {
        return {
          status: 200,
          body: { id: "issue-1", display_id: "abc", project: { repo_id: "mandible" } },
        };
      }
      if (request.method === "POST" && request.path === "/api/artifacts/versions") {
        const body = request.body as Record<string, unknown>;
        // The real transport injects path from the attachment; the mock
        // daemon reads the attachment the CLI staged in the spool dir.
        const attachments = request.attachments as Record<string, string> | undefined;
        const attachmentName = attachments?.path;
        const bytes = typeof attachmentName === "string"
          ? fs.readFileSync(path.join(spoolDir, attachmentName), "utf8")
          : "";
        attachmentReads.push({ ref: body, bytes });
        return {
          status: 200,
          body: { result: {
            created: true,
            artifact: { id: "artifact:logical-report" },
            series: { id: "artifact-series:report", ref: "artifact-series:report", version_count: 1 },
            version: { id: "artifact-version:report-v1", ref: "artifact-version:report", version_no: 1 },
            warnings: [],
          } },
        };
      }
      return { status: 404, body: { error: "unexpected", path: request.path } };
    });

    try {
      fs.writeFileSync(path.join(tempDir, "second.md"), "second snapshot");
      const result = await runAsync(["artifact", "snapshot", "report.md", "missing.md", "second.md", "--issue", "abc", "--json"], tempDir, {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).registered).toHaveLength(2);
      expect(JSON.parse(result.stdout).failed).toHaveLength(1);
      expect(JSON.parse(result.stdout).atomic).toBeUndefined();
      expect(JSON.parse(result.stdout).registered[0].version.ref).toBe("artifact-version:report");
      expect(seen.map((request) => request.path)).toEqual([
        "/api/ledger/issues/abc",
        "/api/artifacts/versions",
        "/api/artifacts/versions",
      ]);
      const record = seen.find((request) => request.path === "/api/artifacts/versions")!;
      const recordBody = record.body as Record<string, unknown>;
      expect(recordBody).toMatchObject({ source_kind: "managed", custody_mode: "managed", media_type: "text/plain" });
      // Bytes are NOT inline in the request body — they ride as an attachment.
      expect(recordBody).not.toHaveProperty("content_base64");
      expect(recordBody).not.toHaveProperty("path");
      expect((record.attachments as Record<string, string>).path).toMatch(/\.attach-path$/);
      expect(attachmentReads).toHaveLength(2);
      expect(attachmentReads[1].bytes).toBe("second snapshot");
      expect(attachmentReads[0].bytes).toBe("# Report\n\nReady.\n");
    } finally {
      responder.stop();
    }
  });

  it("links snapshot-from-ref results using canonical artifact-blob refs", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);
    const sourceRef = "artifact:logical-source";
    const newHash = "b".repeat(64);
    const newRef = "artifact:bbbbbbbbbbbb";
    const seen: Array<Record<string, unknown>> = [];
    const responder = startFileRpcResponder(spoolDir, (request) => {
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
              content_hash: newHash,
              custody_mode: "managed",
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

      expect(result.status, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.artifact.id).toBe(newRef);
      expect(payload.link.artifact_id).toBe(newRef);
      expect(seen.map((request) => request.path)).toEqual([
        "/api/ledger/issues/abc",
        "/api/artifacts/snapshot",
        "/api/artifacts/link",
      ]);
      expect(seen[1].body).toMatchObject({ ref: sourceRef, custody_mode: "managed" });
      expect(seen[2].body).toMatchObject({
        ref: `artifact-blob:${newHash}`,
        entity_type: "issue",
        entity_id: "issue-1",
        link_type: "references",
      });
    } finally {
      responder.stop();
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
    const responder = startFileRpcResponder(spoolDir, (request) => {
      if (request.method === "POST" && request.path === "/api/artifacts/versions") {
        const attachments = request.attachments as Record<string, string> | undefined;
        const name = attachments?.path;
        attachmentSize = typeof name === "string" ? fs.statSync(path.join(spoolDir, name)).size : -1;
        return {
          status: 200,
          body: { result: {
            created: true,
            artifact: { id: "artifact:logical-big" },
            series: { id: "artifact-series:big", ref: "artifact-series:big", version_count: 1 },
            version: { id: "artifact-version:big-v1", ref: "artifact-version:big", version_no: 1 },
            warnings: [],
          } },
        };
      }
      return { status: 404, body: { error: "unexpected" } };
    });

    try {
      const result = await runAsync(["artifact", "snapshot", "_artifacts/big.bin", "--json"], tempDir, {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "10",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toMatch(/argument list too long/);
      // The full 2 MiB rode as a spool attachment, not in the JSON body/argv.
      expect(attachmentSize).toBe(bigBytes.length);
    } finally {
      responder.stop();
    }
  });

  it("reports file RPC issue resolver errors with the response detail", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-artifact-"));
    tempRoots.push(spoolDir);
    const responder = startFileRpcResponder(spoolDir, () => ({
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
      responder.stop();
    }
  });

  it("sends a daemon-visible path (not base64) for local HTTP copy ingest (issue 833e972)", async () => {
    fs.mkdirSync(path.join(tempDir, "_artifacts"), { recursive: true });
    const bigPath = path.join(tempDir, "_artifacts", "packet.zip");
    fs.writeFileSync(bigPath, Buffer.alloc(2 * 1024 * 1024, 7)); // 2 MiB, over ARG_MAX

    const recorder = await startHttpRecorder((req) => {
      if (req.method === "POST" && req.url === "/api/artifacts/ingest") {
        return {
          status: 200,
          body: { registered: [{
            created: true,
            artifact: { id: "artifact:logical-packet" },
            series: { id: "artifact-series:packet", ref: "artifact-series:packet", version_count: 1 },
            version: { id: "artifact-version:packet-v1", ref: "artifact-version:packet", version_no: 1 },
            warnings: [],
          }], failed:[] },
        };
      }
      return { status: 404, body: { error: "unexpected" } };
    });

    try {
      const result = await runAsync(["artifact", "ingest", "_artifacts/packet.zip", "--managed", "--json"], tempDir, {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });

      expect(result.status, result.stderr).toBe(0);
      const record = recorder.requests.find((entry) => entry.url === "/api/artifacts/ingest");
      expect(record).toBeDefined();
      const body = record!.body as Record<string, unknown>;
      // Bytes never travel in-band: a daemon-visible absolute path is sent.
      // (realpath comparison: macOS resolves /var -> /private/var for the cwd.)
      expect(body).not.toHaveProperty("content_base64");
      expect(body).not.toHaveProperty("content_buffer");
      expect(fs.realpathSync((body.paths as string[])[0])).toBe(fs.realpathSync(bigPath));
      expect(body.custody_mode).toBe("managed");
    } finally {
      await recorder.close();
    }
  });

  it("reports an explicit failure when the daemon cannot record the logical version", async () => {
    fs.mkdirSync(path.join(tempDir, "_artifacts"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "_artifacts", "packet.zip"), Buffer.alloc(1024 * 1024, 3));

    // Simulate a daemon that rejects the logical version mutation.
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "POST" && req.url === "/api/artifacts/ingest") {
        return { status: 422, body: { error: "logical version rejected" } };
      }
      return { status: 404, body: { error: "unexpected" } };
    });

    try {
      const result = await runAsync(["artifact", "ingest", "_artifacts/packet.zip", "--managed", "--json"], tempDir, {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("logical version rejected");
      // Never a raw "argument list too long" / transport-level leak.
      expect(result.stderr).not.toMatch(/argument list too long/);
    } finally {
      await recorder.close();
    }
  });

  it("previews bundle identity while preserving member recoverability in dry-run JSON", () => {
    const result = run(["artifact", "bundle", "create", "--name", "smoke", "report.md", "--dry-run", "--json"]);

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.planned_payload.role).toBe("run_packet");
    expect(payload.planned_payload.reference.identity_kind).toBe("bundle_manifest");
    expect(payload.members[0].artifact.recoverability).toBe("repo_commit");
    expect(payload.planned_payload.json.members[0].ref).toContain("repo://");
  });

  it("serializes resolved bundle members with canonical refs, never the obsolete artifact id", async () => {
    const hash = "a".repeat(64);
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url.startsWith("/api/artifacts/resolve?")) {
        return {
          status: 200,
          body: {
            resolution: {
              status: "resolved",
              artifact: {
                id: `artifact:sha256:${hash}`,
                content_hash: hash,
                custody_mode: "managed",
                availability: "present",
                metadata: { recoverability: "mandible_cas" },
              },
            },
          },
        };
      }
      return { status: 404, body: { error: "unexpected" } };
    });

    try {
      const result = await runAsync(
        ["artifact", "bundle", "create", "--name", "review", `artifact-blob:${hash}`, "--dry-run", "--json"],
        tempDir,
        { MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}` },
      );

      expect(result.status, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.planned_payload.json.members[0]).toMatchObject({
        artifact_id: `artifact-blob:${hash}`,
        ref: `artifact-blob:${hash}`,
      });
      expect(result.stdout).not.toContain("artifact:sha256:");
    } finally {
      await recorder.close();
    }
  });
});
