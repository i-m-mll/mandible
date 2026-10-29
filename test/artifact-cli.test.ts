import { artifactRepo } from "./helpers/artifact-repo-fixtures.js";
// @vitest-environment node
/**
 * What only a real `mandible artifact` spawn proves: artifact bytes never ride
 * in argv or in-band JSON (a daemon-visible path over HTTP, a spool attachment
 * over file RPC), multi-path partial failures, zsh PATH preservation, link-kind
 * flags, canonical refs in what the CLI writes, and backend errors surfaced.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { fileRpc, runCli, scratchDir, startStubDaemon, type StubDaemon, type StubHandler } from "./helpers/cli-process.js";
import type { FileRpcHandler, FileRpcResponder } from "./helpers/file-rpc-responder.js";

const cleanups: Array<() => unknown> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function daemon(handler: StubHandler): Promise<StubDaemon> {
  const stub = await startStubDaemon(handler);
  cleanups.push(() => stub.close());
  return stub;
}

function spool(handler: FileRpcHandler): { env: Record<string, string>; responder: FileRpcResponder; dir: string } {
  const dir = scratchDir("spool");
  const stub = fileRpc(handler, dir);
  cleanups.push(() => stub.responder.stop());
  return { ...stub, dir };
}

/** A committed repo holding report.md, the CLI's working directory. */
function repo(): string {
  const dir = scratchDir("artifact-repo");
  artifactRepo(dir, { "report.md": "# Report\n\nReady.\n" });
  return dir;
}

const recorded = (version: string) => ({
  created: true,
  artifact: { id: `artifact:logical-${version}` },
  series: { id: `artifact-series:${version}`, ref: `artifact-series:${version}`, version_count: 1 },
  version: { id: `artifact-version:${version}-v1`, ref: `artifact-version:${version}`, version_no: 1 },
  warnings: [],
});

const issue = { id: "issue-1234567890", display_id: "abc", project: { repo_id: "mandible" } };

describe("artifact CLI", () => {
  it.concurrent("sends daemon-visible paths over HTTP, never bytes, for ingest, dry-run, and blob-only", async () => {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "packet.zip"), Buffer.alloc(2 * 1024 * 1024, 7));
    const stub = await daemon(({ body }) => {
      const request = body as { paths?: string[]; dry_run?: boolean; blob_only?: boolean };
      if (request.dry_run) return { body: { dry_run: true, plans: [{ custody_mode: "git" }], registered: [], failed: [] } };
      if (request.paths) return { body: { registered: [recorded("report")], failed: [], atomic: true } };
      return { body: { artifact: { id: "artifact-blob:abc", ref: "artifact-blob:abc", custody_mode: "managed", availability: "present" } } };
    });
    const run = (...args: string[]) => runCli(["artifact", "ingest", ...args, "--json"], { cwd, env: stub.env });

    const [ingested, planned, packet, blobs] = await Promise.all([
      run("report.md"),
      run("report.md", "--dry-run"),
      run("packet.zip", "--managed"),
      run("report.md", "missing.md", "report.md", "--blob-only"),
    ]);

    for (const result of [ingested, planned, packet]) expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(ingested.stdout).registered[0].version.ref).toBe("artifact-version:report");
    expect(blobs.status).toBe(1);
    expect(JSON.parse(blobs.stdout).registered).toHaveLength(2);
    expect(JSON.parse(blobs.stdout).failed).toHaveLength(1);
    expect(stub.requests.every((request) => request.url === "/api/artifacts/ingest")).toBe(true);
    for (const request of stub.requests) {
      expect(request.body).not.toHaveProperty("content_base64");
      expect(request.body).not.toHaveProperty("content_buffer");
    }
    const paths = stub.requests.flatMap((request) => (request.body as { paths?: string[] }).paths ?? []).map((file) => fs.realpathSync(file));
    expect(paths).toEqual(expect.arrayContaining([fs.realpathSync(path.join(cwd, "report.md")), fs.realpathSync(path.join(cwd, "packet.zip"))]));
  });

  it.concurrent("carries multi-path file RPC snapshots as spool attachments and reports per-item partial failures", async () => {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "second.md"), "second snapshot");
    const attached: string[] = [];
    const { env, responder, dir } = spool((request) => {
      if (request.method === "GET" && request.path === "/api/ledger/issues/abc") return { status: 200, body: issue };
      if (request.method === "POST" && request.path === "/api/artifacts/versions") {
        attached.push(fs.readFileSync(path.join(dir, (request.attachments as Record<string, string>).path), "utf8"));
        return { status: 200, body: { result: recorded("report") } };
      }
      return { status: 404, body: { error: "unexpected", path: request.path } };
    });

    const result = await runCli(["artifact", "snapshot", "report.md", "missing.md", "second.md", "--issue", "abc", "--json"], { cwd, env });

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.registered).toHaveLength(2);
    expect(payload.failed).toHaveLength(1);
    expect(payload.atomic).toBeUndefined();
    const record = responder.requests.find((request) => request.path === "/api/artifacts/versions")!;
    expect(record.body).toMatchObject({ source_kind: "managed", custody_mode: "managed" });
    expect(record.body).not.toHaveProperty("content_base64");
    expect(record.body).not.toHaveProperty("path");
    expect(attached).toEqual(["# Report\n\nReady.\n", "second snapshot"]);
  });

  it.concurrent("carries a multi-MiB file RPC snapshot through an attachment, never argv (issue 833e972)", async () => {
    const cwd = repo();
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x5a);
    fs.writeFileSync(path.join(cwd, "big.bin"), bytes);
    let attachedSize = -1;
    const { env, dir } = spool((request) => {
      if (request.method !== "POST" || request.path !== "/api/artifacts/versions") return { status: 404, body: { error: "unexpected" } };
      attachedSize = fs.statSync(path.join(dir, (request.attachments as Record<string, string>).path)).size;
      return { status: 200, body: { result: recorded("big") } };
    });

    const result = await runCli(["artifact", "snapshot", "big.bin", "--json"], { cwd, env: { ...env, MANDIBLE_FILE_RPC_TIMEOUT: "10" } });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/argument list too long/);
    expect(attachedSize).toBe(bytes.length);
  });

  it.concurrent("plans file RPC ingest as managed custody without in-band bytes and refuses git custody there", async () => {
    const cwd = repo();
    const env = { MANDIBLE_BASE: `file://${scratchDir("spool")}` };

    const [planned, git] = await Promise.all([
      runCli(["artifact", "ingest", "report.md", "--dry-run", "--json"], { cwd, env }),
      runCli(["artifact", "ingest", "report.md", "--git", "--dry-run", "--json"], { cwd, env }),
    ]);

    expect(planned.status, planned.stderr).toBe(0);
    const payload = JSON.parse(planned.stdout);
    expect(payload.custody_mode).toBe("managed");
    expect(payload.registered[0].planned_payload).toMatchObject({ custody_mode: "managed", metadata: { recoverability: "mandible_cas" } });
    expect(payload.registered[0].planned_payload).not.toHaveProperty("content_base64");
    expect(git.status).toBe(2);
    expect(git.stderr).toContain("git custody requires daemon-visible host paths");
  });

  it("preserves zsh PATH while recording a local artifact version", async () => {
    const cwd = repo();
    const stub = await daemon(({ url }) => url === "/api/artifacts/versions"
      ? { body: { result: { ...recorded("local"), series: { id: "artifact-series:local", source_kind: "local_only", version_count: 1 } } } }
      : undefined);

    const result = await runCli(["artifact", "record", "report.md", "--kind", "local_only", "--json"], { cwd, env: stub.env });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("curl not found");
    const body = stub.requests.find((request) => request.url === "/api/artifacts/versions")?.body as { source_kind: string; path: string };
    expect(body.source_kind).toBe("local_only");
    expect(fs.realpathSync(body.path)).toBe(fs.realpathSync(path.join(cwd, "report.md")));
  });

  it("surfaces the backend's error detail and exits non-zero", async () => {
    const cwd = repo();
    const cases: Array<[string[], string, number, string]> = [
      [["artifact", "associate", "artifact:deadbeef", "--project", "mandible"], "/api/artifacts/associations", 422, "artifact_ref_ambiguous"],
      [["artifact", "record", "--ref", "artifact:deadbeef", "--kind", "managed"], "/api/artifacts/versions", 422, "artifact_ref_not_resolved"],
      [["artifact", "bundle", "create", "--name", "review", "artifact:deadbeef"], "/api/artifacts/bundles", 422, "bundle_member_ref_not_resolved"],
      [["artifact", "ingest", "report.md", "--managed", "--json"], "/api/artifacts/ingest", 422, "logical version rejected"],
      [["artifact", "link", "artifact:series-1", "--issue", "abc", "--relation", "evidence", "--living"], "/api/artifacts/link", 400, "evidence_links_must_be_pinned"],
    ];
    const stub = await daemon(({ method, url }) => {
      if (method === "GET" && url === "/api/ledger/issues/abc") return { body: issue };
      const failing = cases.find(([, route]) => route === url);
      return failing ? { status: failing[2], body: { error: failing[3] } } : undefined;
    });
    const resolver = spool(() => ({ status: 404, body: { error: "issue_missing" } }));

    const results = await Promise.all([
      ...cases.map(([args]) => runCli(args, { cwd, env: { ...stub.env, MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1" } })),
      runCli(["artifact", "snapshot", "report.md", "--issue", "missing", "--json"], { cwd, env: resolver.env }),
    ]);

    for (const [index, message] of [...cases.map((entry) => entry[3]), "HTTP 404: issue_missing"].entries()) {
      expect(results[index].status, message).not.toBe(0);
      expect(results[index].stderr, message).toContain(message);
    }
  });

  it("sends link_kind only when a link-kind flag asks for it", async () => {
    const cwd = repo();
    const stub = await daemon(({ method, url, body }) => {
      if (method === "GET" && url === "/api/ledger/issues/abc") return { body: issue };
      if (method === "GET" && url.startsWith("/api/artifacts/resolve?")) return { body: { resolution: { artifact: { id: "artifact:abc123def456" } } } };
      if (method === "POST" && url === "/api/artifacts/snapshot") return { body: { artifact: { id: "artifact:abc123def456", custody_mode: "copy", availability: "present" } } };
      if (method !== "POST" || url !== "/api/artifacts/link") return undefined;
      const living = (body as { link_kind?: string }).link_kind === "living";
      return {
        body: {
          resolution: { logical_artifact: { id: "artifact:abc123def456" }, artifact_version: { version_no: 3 } },
          link: { id: "artifact-link-1", artifact_id: "artifact:abc123def456", entity_type: "issue", entity_id: issue.id, link_type: "references", link_kind: living ? "living" : "pinned" },
        },
      };
    });
    const run = (...args: string[]) => runCli(["artifact", ...args], { cwd, env: { ...stub.env, MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1" } });

    const results = await Promise.all([
      run("link", "artifact:series-default", "--issue", "abc"),
      run("link", "artifact:series-living", "--issue", "abc", "--living"),
      run("link", "artifact:series-pinned", "--issue", "abc", "--pinned"),
      run("ref", "artifact-blob:resolved", "--issue", "abc", "--json"),
      run("snapshot", "artifact:old", "--from", "report.md", "--issue", "abc", "--json"),
    ]);

    for (const result of results) expect(result.status, result.stderr).toBe(0);
    expect(results[0].stdout.trim()).toBe(`linked artifact:abc123def456 references issue:${issue.id} [pinned v3]`);
    expect(results[1].stdout.trim()).toBe(`linked artifact:abc123def456 references issue:${issue.id} [living · latest v3]`);
    const kinds = Object.fromEntries(stub.requests.filter((request) => request.url === "/api/artifacts/link")
      .map((request) => [(request.body as { ref: string }).ref, (request.body as { link_kind?: string }).link_kind ?? "omitted"]));
    expect(kinds).toEqual({
      "artifact:series-default": "omitted",
      "artifact:series-living": "living",
      "artifact:series-pinned": "pinned",
      "artifact-blob:resolved": "omitted",
      "artifact:abc123def456": "omitted",
    });
  });

  it("links a snapshot taken from a ref by its canonical artifact-blob ref", async () => {
    const cwd = repo();
    const hash = "b".repeat(64);
    const { env, responder } = spool((request) => {
      if (request.method === "GET" && request.path === "/api/ledger/issues/abc") return { status: 200, body: issue };
      if (request.path === "/api/artifacts/snapshot") return { status: 200, body: { artifact: { id: "artifact:bbbbbbbbbbbb", content_hash: hash, custody_mode: "managed", availability: "present" } } };
      if (request.path === "/api/artifacts/link") return { status: 200, body: { link: { id: "artifact-link-1", artifact_id: "artifact:bbbbbbbbbbbb", entity_type: "issue", entity_id: issue.id, link_type: "references" } } };
      return { status: 404, body: { error: "unexpected", path: request.path } };
    });

    const result = await runCli(["artifact", "snapshot", "artifact:logical-source", "--from", "report.md", "--issue", "abc", "--json"], { cwd, env });

    expect(result.status, result.stderr).toBe(0);
    expect(responder.requests.find((request) => request.path === "/api/artifacts/snapshot")?.body).toMatchObject({ ref: "artifact:logical-source", custody_mode: "managed" });
    expect(responder.requests.find((request) => request.path === "/api/artifacts/link")?.body).toMatchObject({ ref: `artifact-blob:${hash}`, entity_id: issue.id });
  });

  it("follows a short blob id to its canonical target for show and content", async () => {
    const cwd = repo();
    const hash = "a".repeat(64);
    const shortId = `artifact:${hash.slice(0, 12)}`;
    const target = encodeURIComponent(`artifact-blob:${hash}`);
    const stub = await daemon(({ url }) => {
      if (url.startsWith("/api/artifacts/resolve?")) {
        return { body: { resolution: { status: "resolved", target_type: "artifact_blob", target_id: `artifact-blob:${hash}`, artifact: { id: shortId } } } };
      }
      if (url === `/api/artifacts/${target}`) return { body: { artifact: { id: shortId, custody_mode: "managed", availability: "present" } } };
      if (url === `/api/artifacts/${target}/content`) return { body: { content: { artifact_id: shortId, preview: { text: "compact content\n" } } } };
      return undefined;
    });

    const [shown, content] = await Promise.all([
      runCli(["artifact", "show", shortId, "--json"], { cwd, env: stub.env }),
      runCli(["artifact", "content", shortId], { cwd, env: stub.env }),
    ]);

    expect(shown.status, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout).artifact.id).toBe(shortId);
    expect(content.status, content.stderr).toBe(0);
    expect(content.stdout).toBe("compact content\n\n");
    expect(stub.requests.map((request) => request.url).filter((url) => !url.startsWith("/api/artifacts/resolve?")).sort())
      .toEqual([`/api/artifacts/${target}`, `/api/artifacts/${target}/content`]);
  });

  it("writes bundle members by canonical ref, never the obsolete artifact id", async () => {
    const cwd = repo();
    const hash = "a".repeat(64);
    const stub = await daemon(({ url }) => url.startsWith("/api/artifacts/resolve?")
      ? { body: { resolution: { status: "resolved", artifact: { id: `artifact:sha256:${hash}`, content_hash: hash, custody_mode: "managed", availability: "present", metadata: { recoverability: "mandible_cas" } } } } }
      : undefined);

    const result = await runCli(["artifact", "bundle", "create", "--name", "review", `artifact-blob:${hash}`, "--dry-run", "--json"], { cwd, env: stub.env });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).planned_payload.json.members[0]).toMatchObject({ artifact_id: `artifact-blob:${hash}`, ref: `artifact-blob:${hash}` });
    expect(result.stdout).not.toContain("artifact:sha256:");
  });
});
