import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");
const CLI_TEST_ENV = {
  MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1",
};

let tempDir = "";

interface RecordedRequest {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

function run(
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(CLI, args, {
    cwd: tempDir,
    encoding: "utf8",
    env: { ...process.env, MANDIBLE_PORT: "9", ...CLI_TEST_ENV, ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAsync(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd: tempDir,
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
        res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
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
      resolve({
        port: (server.address() as AddressInfo).port,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function issueResponse() {
  return {
    id: "issue-1234567890",
    display_id: "abc",
    project: { repo_id: "mandible" },
  };
}

function linkResponse(body: Record<string, unknown>, versionNo = 3) {
  const linkKind = body.link_kind === "living" ? "living" : "pinned";
  return {
    resolution: {
      logical_artifact: { id: "artifact:abc123def456" },
      artifact_version: { version_no: versionNo },
    },
    link: {
      id: "artifact-link-1",
      artifact_id: "artifact:abc123def456",
      entity_type: "issue",
      entity_id: "issue-1234567890",
      link_type: body.link_type,
      link_kind: linkKind,
      series_id: linkKind === "living" ? "artifact-series:series-1" : null,
      series_ref: linkKind === "living" ? body.ref : null,
    },
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-cli-artifact-link-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("artifact link CLI", () => {
  it("formats a resolved typed identity as short id, URL, Markdown, full id, or JSON", async () => {
    const fullId = `artifact-blob:${"a".repeat(64)}`;
    const shortRef = "artifact-blob:aaaaaaaaaaaa";
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url.startsWith("/api/artifacts/resolve?")) {
        return {
          status: 200,
          body: {
            resolution: {
              status: "resolved",
              target_type: "artifact_blob",
              target_id: fullId,
              artifact_blob: { id: fullId, ref: shortRef },
            },
          },
        };
      }
      return { status: 404, body: { error: "unexpected", url: req.url } };
    });

    try {
      const env = {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
        MANDIBLE_WEB_BASE: "http://localhost:19420",
      };
      const id = await runAsync(["artifact", "format", fullId], env);
      const url = await runAsync(["artifact", "format", fullId, "--as", "url"], env);
      const markdown = await runAsync([
        "artifact", "format", fullId, "--as", "markdown", "--label", "Blob bytes",
      ], env);
      const full = await runAsync(["artifact", "format", fullId, "--as", "full"], env);
      const json = await runAsync(["artifact", "format", fullId, "--json"], env);

      expect(id.stdout.trim()).toBe(shortRef);
      expect(url.stdout.trim()).toBe(
        "http://localhost:19420/#/artifacts?ref=artifact-blob%3Aaaaaaaaaaaaa&sidebar=hidden",
      );
      expect(markdown.stdout.trim()).toBe(`[Blob bytes](${url.stdout.trim()})`);
      expect(full.stdout.trim()).toBe(fullId);
      expect(JSON.parse(json.stdout)).toMatchObject({
        ref: shortRef,
        full_id: fullId,
        target_type: "artifact_blob",
        url: url.stdout.trim(),
      });
    } finally {
      await recorder.close();
    }
  });

  it("keeps living and pinned series links on the series route", async () => {
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url.startsWith("/api/artifacts/resolve?")) {
        const pinned = req.url.includes(encodeURIComponent("@3"));
        return {
          status: 200,
          body: {
            resolution: {
              status: "resolved",
              ref: pinned ? "artifact-series:series-full@3" : "artifact-series:series-full",
              scheme: "artifact-series",
              target_type: "artifact_version",
              target_id: "artifact-version:version-full",
              logical_artifact: { id: "artifact:series-full", ref: "artifact:series" },
              artifact_version: { id: "artifact-version:version-full", ref: "artifact-version:version", version_no: 3 },
              warnings: pinned ? [] : ["series_latest_not_pinned"],
            },
          },
        };
      }
      return { status: 404, body: { error: "unexpected", url: req.url } };
    });

    try {
      const env = {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
        MANDIBLE_WEB_BASE: "http://localhost:19420",
      };
      const living = await runAsync(["artifact", "format", "artifact-series:series-full", "--as", "url"], env);
      const pinned = await runAsync(["artifact", "format", "artifact-series:series-full@3", "--json"], env);

      expect(living.stdout.trim()).toBe(
        "http://localhost:19420/#/artifacts?series=artifact-series%3Aseries&sidebar=hidden",
      );
      expect(JSON.parse(pinned.stdout)).toMatchObject({
        ref: "artifact-series:series@3",
        full_id: "artifact-series:series-full@3",
        target_type: "artifact_series",
        url: "http://localhost:19420/#/artifacts?series=artifact-series%3Aseries&version=3&sidebar=hidden",
      });
    } finally {
      await recorder.close();
    }
  });

  it("omits link_kind when no typed-link flag is supplied and prints a pinned badge", async () => {
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url === "/api/ledger/issues/abc") {
        return { status: 200, body: issueResponse() };
      }
      if (req.method === "POST" && req.url === "/api/artifacts/link") {
        return { status: 200, body: linkResponse(req.body!) };
      }
      return { status: 404, body: { error: "unexpected", url: req.url } };
    });

    try {
      const result = await runAsync(["artifact", "link", "artifact:series-1", "--issue", "abc"], {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(
        "linked artifact:abc123def456 references issue:issue-1234567890 [pinned v3]",
      );
      const linkRequest = recorder.requests.find((request) => request.url === "/api/artifacts/link")!;
      expect(linkRequest.body).toMatchObject({
        ref: "artifact:series-1",
        entity_type: "issue",
        entity_id: "issue-1234567890",
        link_type: "references",
        repo_id: "mandible",
        source: "artifact_cli",
      });
      expect(linkRequest.body).not.toHaveProperty("link_kind");
    } finally {
      await recorder.close();
    }
  });

  it("sends explicit living and pinned link_kind flags", async () => {
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url === "/api/ledger/issues/abc") {
        return { status: 200, body: issueResponse() };
      }
      if (req.method === "POST" && req.url === "/api/artifacts/link") {
        return { status: 200, body: linkResponse(req.body!) };
      }
      return { status: 404, body: { error: "unexpected", url: req.url } };
    });

    try {
      const env = { MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}` };
      const living = await runAsync(
        ["artifact", "link", "artifact:series-1", "--issue", "abc", "--living"],
        env,
      );
      const pinned = await runAsync(
        ["artifact", "link", "artifact:series-1", "--issue", "abc", "--pinned"],
        env,
      );

      expect(living.status).toBe(0);
      expect(living.stdout.trim()).toBe(
        "linked artifact:abc123def456 references issue:issue-1234567890 [living · latest v3]",
      );
      expect(pinned.status).toBe(0);
      expect(pinned.stdout.trim()).toBe(
        "linked artifact:abc123def456 references issue:issue-1234567890 [pinned v3]",
      );
      const linkBodies = recorder.requests
        .filter((request) => request.url === "/api/artifacts/link")
        .map((request) => request.body);
      expect(linkBodies[0]).toMatchObject({ link_kind: "living" });
      expect(linkBodies[1]).toMatchObject({ link_kind: "pinned" });
    } finally {
      await recorder.close();
    }
  });

  it("rejects mutually exclusive link-kind flags before contacting the daemon", () => {
    const result = run([
      "artifact",
      "link",
      "artifact:series-1",
      "--issue",
      "abc",
      "--pinned",
      "--living",
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Arguments do not match");
  });

  it("surfaces backend evidence_links_must_be_pinned errors clearly", async () => {
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url === "/api/ledger/issues/abc") {
        return { status: 200, body: issueResponse() };
      }
      if (req.method === "POST" && req.url === "/api/artifacts/link") {
        return { status: 400, body: { error: "evidence_links_must_be_pinned" } };
      }
      return { status: 404, body: { error: "unexpected", url: req.url } };
    });

    try {
      const result = await runAsync(
        [
          "artifact",
          "link",
          "artifact:series-1",
          "--issue",
          "abc",
          "--relation",
          "evidence",
          "--living",
        ],
        { MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}` },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Failed to link artifact ref");
      expect(result.stderr).toContain("evidence_links_must_be_pinned");
      const body = recorder.requests.find((request) => request.url === "/api/artifacts/link")!.body;
      expect(body).toMatchObject({ link_type: "evidence", link_kind: "living" });
    } finally {
      await recorder.close();
    }
  });

  it("keeps artifact ref link bodies pinned-default without link_kind", async () => {
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url === "/api/ledger/issues/abc") {
        return { status: 200, body: issueResponse() };
      }
      if (req.method === "GET" && req.url.startsWith("/api/artifacts/resolve?")) {
        return {
          status: 200,
          body: {
            resolution: {
              artifact: { id: "artifact:abc123def456" },
            },
          },
        };
      }
      if (req.method === "POST" && req.url === "/api/artifacts/link") {
        return { status: 200, body: linkResponse(req.body!) };
      }
      return { status: 404, body: { error: "unexpected", url: req.url } };
    });

    try {
      const result = await runAsync(["artifact", "ref", "artifact-blob:resolved", "--issue", "abc", "--json"], {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });

      expect(result.status, result.stderr).toBe(0);
      const body = recorder.requests.find((request) => request.url === "/api/artifacts/link")!.body;
      expect(body).toMatchObject({
        ref: "artifact-blob:resolved",
        entity_type: "issue",
        entity_id: "issue-1234567890",
        link_type: "references",
      });
      expect(body).not.toHaveProperty("link_kind");
    } finally {
      await recorder.close();
    }
  });

  it("keeps artifact snapshot link bodies pinned-default without link_kind", async () => {
    fs.writeFileSync(path.join(tempDir, "report.md"), "# Report\n", "utf8");
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url === "/api/ledger/issues/abc") {
        return { status: 200, body: issueResponse() };
      }
      if (req.method === "POST" && req.url === "/api/artifacts/snapshot") {
        return {
          status: 200,
          body: {
            artifact: {
              id: "artifact:abc123def456",
              custody_mode: "copy",
              availability: "present",
            },
          },
        };
      }
      if (req.method === "POST" && req.url === "/api/artifacts/link") {
        return { status: 200, body: linkResponse(req.body!) };
      }
      return { status: 404, body: { error: "unexpected", url: req.url } };
    });

    try {
      const result = await runAsync(
        ["artifact", "snapshot", "artifact:old", "--from", "report.md", "--issue", "abc", "--json"],
        { MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}` },
      );

      expect(result.status, result.stderr).toBe(0);
      const body = recorder.requests.find((request) => request.url === "/api/artifacts/link")!.body;
      expect(body).toMatchObject({
        ref: "artifact:abc123def456",
        entity_type: "issue",
        entity_id: "issue-1234567890",
        link_type: "references",
      });
      expect(body).not.toHaveProperty("link_kind");
    } finally {
      await recorder.close();
    }
  });
});

describe("artifact versions CLI display", () => {
  it("relabels the human series heading as artifact", async () => {
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url.startsWith("/api/artifacts/versions?")) {
        return {
          status: 200,
          body: {
            history: {
              series: {
                id: "artifact-series:series-1",
                source_kind: "managed",
                version_count: 2,
                title: "Report",
              },
              versions: [
                {
                  version_no: 1,
                  source_kind: "managed",
                  artifact_id: "artifact:111111111111",
                  label: "draft",
                },
                {
                  version_no: 2,
                  source_kind: "managed",
                  artifact_id: "artifact:222222222222",
                  label: null,
                },
              ],
              links: [],
            },
          },
        };
      }
      return { status: 404, body: { error: "unexpected", url: req.url } };
    });

    try {
      const result = await runAsync(["artifact", "versions", "artifact:series-1"], {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("artifact artifact:series-1 [managed] 2 version(s)");
      expect(result.stdout).not.toContain("artifact-series:series-1");
      expect(result.stdout).toContain("v1 managed artifact:111111111111 (draft)");
      expect(result.stdout).toContain("v2 managed artifact:222222222222");
      expect(result.stdout).not.toContain("artifact:sha256:");
    } finally {
      await recorder.close();
    }
  });

  it("keeps the versions JSON envelope keys frozen", async () => {
    const recorder = await startHttpRecorder((req) => {
      if (req.method === "GET" && req.url.startsWith("/api/artifacts/versions?")) {
        return {
          status: 200,
          body: {
            history: {
              series: { id: "artifact-series:series-1", source_kind: "managed", version_count: 0 },
              versions: [],
              links: [],
            },
          },
        };
      }
      return { status: 404, body: { error: "unexpected", url: req.url } };
    });

    try {
      const result = await runAsync(["artifact", "versions", "artifact:series-1", "--json"], {
        MANDIBLE_BASE: `http://127.0.0.1:${recorder.port}`,
      });

      expect(result.status, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toHaveProperty("history.series");
      expect(payload).toHaveProperty("history.versions");
      expect(payload.history.series.id).toBe("artifact-series:series-1");
    } finally {
      await recorder.close();
    }
  });
});
