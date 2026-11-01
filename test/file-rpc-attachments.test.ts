import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import { waitUntil } from "./helpers/wait-until.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { setupOperator } from "../src/users/store.js";
import { setSetting } from "../src/client-auth/settings-kv.js";
import { setDb, type Db } from "../src/db.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { registerProviderRoutes } from "../src/routes/providers.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { Router } from "../src/server.js";
import { shutdownArtifactIngestPool } from "../src/artifact-ingest-pool.js";
import { borrowArtifactAttachment, isOpenedArtifactAttachment } from "../src/artifact-attachment.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { STANDARD_PREVIEW_EFFECTS } from "../src/security/effect-policy.js";

const workerControl = vi.hoisted(() => ({ mode: "", gate: null as SharedArrayBuffer | null }));

// Instrument the real worker's filesystem read, so barriers surround actual
// off-thread consumption without introducing a test protocol into production.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return { ...actual, Worker: class extends actual.Worker {
    constructor(source: string | URL, options?: import("node:worker_threads").WorkerOptions) {
      const prelude = `
        const { workerData: controlData } = require("node:worker_threads");
        if (controlData && controlData.mode) {
          const io = require("node:fs");
          const originalRead = io.readFileSync;
          const gate = new Int32Array(controlData.gate);
          io.readFileSync = function(input, ...args) {
            if (typeof input !== "number" || Atomics.compareExchange(gate, 2, 0, 1) !== 0) return originalRead(input, ...args);
            if (controlData.mode === "exit") process.exit(23);
            if (controlData.mode === "error") throw new Error("injected worker read failure");
            const bytes = originalRead(input, ...args);
            Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
            Atomics.wait(gate, 1, 0);
            return bytes;
          };
        }
      `;
      super(options?.eval ? prelude + source : source, { ...options, workerData: { mode: workerControl.mode, gate: workerControl.gate } });
    }
  } };
});

const actualOpen = fs.openSync;
let root: string;
let spool: string;
let cas: string;
let db: Db;
let router: Router;
let fds: number[];
let nextId: number;
const hash = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");
const casFile = (digest: string) => path.join(cas, "sha256", digest.slice(0, 2), digest);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(testRuntimeRoot, "attachments-"));
  spool = path.join(root, "spool"); fs.mkdirSync(spool, { mode: 0o700 });
  vi.stubEnv("MANDIBLE_FILE_RPC_DIR", spool);
  cas = path.join(root, "cas");
  db = migratedMemoryDb(); setDb(db); setSetting(db, "artifact_root", cas);
  router = authenticatedTestRouter(setupOperator(db, { slug: "operator" }));
  registerProviderRoutes(router, inlineLedgerReader());
  workerControl.mode = ""; workerControl.gate = null;
  fds = []; nextId = 0;
  const open = actualOpen;
  vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: string | number, ...args: unknown[]) => {
    const fd = open(file, flags, ...(args as [number?]));
    if (String(file).startsWith(spool + path.sep) && typeof flags === "number" && (flags & fs.constants.O_NOFOLLOW)) fds.push(fd);
    return fd;
  }) as typeof fs.openSync);
});

afterEach(async () => {
  if (workerControl.gate) { const gate = new Int32Array(workerControl.gate); Atomics.store(gate, 1, 1); Atomics.notify(gate, 1); }
  await shutdownArtifactIngestPool();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

function request(options: { endpoint?: string; body?: Record<string, unknown>; name?: unknown; field?: string; id?: string } = {}) {
  const id = options.id ?? `request-${nextId++}`;
  const name = options.name ?? `${id}.attachment`;
  fs.writeFileSync(path.join(spool, `${id}.request.json`), JSON.stringify({
    id, method: "POST", path: options.endpoint ?? "/api/artifacts/ingest", body: options.body ?? {},
    attachments: { [options.field ?? "content_path"]: name },
  }));
  return { id, file: path.join(spool, String(name)) };
}

async function processRequest(id: string, transport = new FileRpcTransport({ router, dir: spool })) {
  await transport.processOnce();
  const response = JSON.parse(fs.readFileSync(path.join(spool, `${id}.response.json`), "utf8"));
  expect(fs.existsSync(path.join(spool, `${id}.request.json`))).toBe(false);
  for (const fd of fds) expect(() => fs.fstatSync(fd)).toThrow();
  return response;
}

async function followup() {
  const next = request(); fs.writeFileSync(next.file, "next request succeeds");
  expect((await processRequest(next.id)).status).toBe(200);
}

function expectNoArtifact(bytes?: Buffer | string) {
  expect(db.prepare("SELECT count(*) AS n FROM artifact_blob").get()).toMatchObject({ n: 0 });
  if (bytes) expect(fs.existsSync(casFile(hash(bytes)))).toBe(false);
}

describe("descriptor-bound file RPC ingestion", () => {
  it.each(["ingest", "snapshot"])("materializes normal and large binary %s attachments through real routes", async (endpoint) => {
    for (const bytes of [Buffer.from([0, 255, 1, 128]), crypto.randomBytes(12 * 1024 * 1024)]) {
      const { id, file } = request({ endpoint: `/api/artifacts/${endpoint}`, body: { filename: "binary.bin" } });
      fs.writeFileSync(file, bytes);
      const response = await processRequest(id);
      expect(response).toMatchObject({ status: 200, body: { artifact: { content_hash: hash(bytes), size_bytes: bytes.length } } });
      expect(fs.readFileSync(casFile(hash(bytes))).equals(bytes)).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  it.each(["regular", "symlink"])("consumes original opened bytes after %s substitution before off-thread reading", async (kind) => {
    const original = Buffer.from("original opened bytes");
    const replacement = Buffer.from("outside replacement!!");
    const { id, file } = request(); fs.writeFileSync(file, original);
    const outside = path.join(root, "outside"); fs.writeFileSync(outside, replacement);
    const invoke = router.invoke.bind(router);
    vi.spyOn(router, "invoke").mockImplementation(async (input) => {
      expect(isOpenedArtifactAttachment((input.body as Record<string, unknown>).content_path)).toBe(true);
      fs.renameSync(file, file + ".original");
      if (kind === "symlink") fs.symlinkSync(outside, file); else fs.writeFileSync(file, replacement);
      return invoke(input);
    });
    const response = await processRequest(id);
    expect(response).toMatchObject({ status: 200, body: { artifact: { content_hash: hash(original) } } });
    expect(fs.readFileSync(casFile(hash(original))).equals(original)).toBe(true);
    expect(fs.existsSync(casFile(hash(replacement)))).toBe(false);
    expect(fs.readFileSync(outside).equals(replacement)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rejects a symlink substituted immediately before atomic open", async () => {
    const { id, file } = request(); fs.writeFileSync(file, "published");
    const outside = path.join(root, "outside"); fs.writeFileSync(outside, "outside bytes");
    const open = actualOpen;
    vi.mocked(fs.openSync).mockImplementation(((p: fs.PathLike, flags: string | number, ...args: unknown[]) => {
      if (p === file) { fs.unlinkSync(file); fs.symlinkSync(outside, file); }
      return open(p, flags, ...(args as [number?]));
    }) as typeof fs.openSync);
    expect(await processRequest(id)).toMatchObject({ status: 400, body: { code: "file_rpc_attachment_invalid" } });
    expectNoArtifact("outside bytes"); expect(fs.readFileSync(outside, "utf8")).toBe("outside bytes");
  });

  it.each(["fifo", "directory", "dangling", "hardlink", "missing", "field", "name"])("refuses invalid %s before mutation", async (kind) => {
    const { id, file } = request({ field: kind === "field" ? "repo_locator" : undefined, name: kind === "name" ? "../outside" : undefined });
    if (kind === "fifo") execFileSync("mkfifo", [file], { timeout: 10_000 });
    if (kind === "directory") fs.mkdirSync(file);
    if (kind === "dangling") fs.symlinkSync(path.join(root, "absent"), file);
    if (kind === "hardlink") { fs.writeFileSync(file, "linked"); fs.linkSync(file, path.join(root, "other-link")); }
    const response = await processRequest(id);
    expect(response.status).toBe(400);
    expect(response.body.code).toMatch(/^file_rpc_attachment_(invalid|missing)$/);
    expectNoArtifact();
    await followup();
  });

  it("fails closed when required acquisition flags are unavailable, preserving attachment-free RPC", async () => {
    const { id, file } = request(); fs.writeFileSync(file, "published");
    const open = actualOpen;
    vi.mocked(fs.openSync).mockImplementation(((p: fs.PathLike, flags: string | number, ...args: unknown[]) => {
      if (p === file) throw Object.assign(new Error("unsupported flags"), { code: "ENOTSUP" });
      return open(p, flags, ...(args as [number?]));
    }) as typeof fs.openSync);
    expect(await processRequest(id)).toMatchObject({ status: 501, body: { code: "file_rpc_attachment_unsupported" } });
    expectNoArtifact();
    fs.writeFileSync(path.join(spool, "inline.request.json"), JSON.stringify({ id: "inline", method: "POST", path: "/api/artifacts/ingest", body: { content: "inline bytes" } }));
    expect((await processRequest("inline")).status).toBe(200);
  });

  it("refuses ineffective no-follow support rather than consuming a symlink target", async () => {
    const { id, file } = request(); fs.writeFileSync(file, "published");
    vi.mocked(fs.openSync).mockImplementation(((p: fs.PathLike, flags: string | number, ...args: unknown[]) => {
      return actualOpen(p, typeof flags === "number" ? flags & ~fs.constants.O_NOFOLLOW : flags, ...(args as [number?]));
    }) as typeof fs.openSync);
    expect(await processRequest(id)).toMatchObject({ status: 501, body: { code: "file_rpc_attachment_unsupported" } });
    expectNoArtifact();
  });

  it("preserves preview effect denial for attachments while allowing instance-local inline bytes", async () => {
    const instance = { ...resolveInstanceInfo(), role: "preview" as const, allowed_effects: [...STANDARD_PREVIEW_EFFECTS], artifact_root: cas };
    router = authenticatedTestRouter(setupOperator(db, { slug: "operator" }), { instance });
    registerProviderRoutes(router, inlineLedgerReader());
    for (const endpoint of ["ingest", "snapshot"]) {
      const { id, file } = request({ endpoint: `/api/artifacts/${endpoint}` }); fs.writeFileSync(file, "production file effect");
      expect((await processRequest(id)).status).toBe(403); expectNoArtifact();
    }
    fs.writeFileSync(path.join(spool, "inline.request.json"), JSON.stringify({ id: "inline", method: "POST", path: "/api/artifacts/ingest", body: { content: "preview inline" } }));
    expect((await processRequest("inline")).status).toBe(200);
  });

  it("reports unexpected CAS storage failure as a server error without artifact registration", async () => {
    fs.writeFileSync(cas, "not a directory");
    const { id, file } = request(); fs.writeFileSync(file, "storage failure bytes");
    expect(await processRequest(id)).toMatchObject({ status: 500, body: { code: "file_rpc_attachment_io_error" } });
    expectNoArtifact(); fs.unlinkSync(cas); await followup();
  });

  it("refuses a symlink or nonprivate spool root without touching its contents", async () => {
    const actual = path.join(root, "actual"); fs.mkdirSync(actual, { mode: 0o700 });
    const entry = path.join(actual, "keep"); fs.writeFileSync(entry, "untouched");
    fs.rmdirSync(spool); fs.symlinkSync(actual, spool);
    await expect(new FileRpcTransport({ router, dir: spool }).processOnce()).rejects.toThrow("file_rpc_spool_not_private");
    expect(fs.readFileSync(entry, "utf8")).toBe("untouched");
    fs.unlinkSync(spool); fs.mkdirSync(spool, { mode: 0o755 });
    await expect(new FileRpcTransport({ router, dir: spool }).processOnce()).rejects.toThrow("file_rpc_spool_not_private");
  });

  it.each(["truncate", "grow"])("detects %s during worker read before publishing CAS or ledger state", async (mode) => {
    workerControl.mode = "barrier"; workerControl.gate = new SharedArrayBuffer(12);
    const gate = new Int32Array(workerControl.gate);
    const bytes = Buffer.alloc(4096, 42);
    const { id, file } = request(); fs.writeFileSync(file, bytes);
    const processing = processRequest(id);
    await waitUntil(() => Atomics.load(gate, 0), "worker completed descriptor read");
    if (mode === "truncate") fs.truncateSync(file, 1); else fs.appendFileSync(file, "growth");
    Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
    expect(await processing).toMatchObject({ status: 409, body: { code: "file_rpc_attachment_changed" } });
    expectNoArtifact(bytes); await followup();
  });

  it.each(["error", "exit", "shutdown"])("retains descriptor ownership through worker %s and serves the next request", async (mode) => {
    workerControl.mode = mode === "shutdown" ? "barrier" : mode;
    workerControl.gate = new SharedArrayBuffer(12);
    const { id, file } = request(); fs.writeFileSync(file, "must not register");
    const processing = processRequest(id);
    if (mode === "shutdown") {
      await waitUntil(() => Atomics.load(new Int32Array(workerControl.gate!), 0), "worker borrowed descriptor");
      await shutdownArtifactIngestPool();
    }
    expect(await processing).toMatchObject({ status: 500, body: { code: "file_rpc_attachment_io_error" } });
    expectNoArtifact(); workerControl.mode = "";
    await followup();
  });

  it("denies unscoped routes without opening attachments and still removes owned entries", async () => {
    const { id, file } = request({ endpoint: "/api/admin/config" }); fs.writeFileSync(file, "not readable by denied route");
    expect(await processRequest(id)).toMatchObject({ status: 403, body: { error: "file_rpc_route_denied" } });
    expect(fds).toHaveLength(0); expect(fs.existsSync(file)).toBe(false); expectNoArtifact();
  });

  it("closes on handler failure, reports cleanup separately, and preserves the terminal response", async () => {
    const failing = new Router();
    failing.post("/api/fail", () => { throw new Error("handler failed"); }, { fileRpc: "allow", operation: { id: "fail", effects: [], requestSchema: null, reportingCategory: null } });
    const logger = vi.fn();
    const { id, file } = request({ endpoint: "/api/fail", id: "envelope-id" }); fs.writeFileSync(file, "owned");
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((p) => { if (p === file) throw Object.assign(new Error("cleanup failed"), { code: "EACCES" }); return unlink(p); });
    fs.renameSync(path.join(spool, `${id}.request.json`), path.join(spool, "different-spool-id.request.json"));
    const response = await processRequest(id, new FileRpcTransport({ router: failing, dir: spool, logger }));
    expect(response.status).toBe(500); expect(logger).toHaveBeenCalledWith("warn", "file_rpc_cleanup_failed", { file: path.basename(file), operation: "unlink" });
    expect(fs.existsSync(path.join(spool, "different-spool-id.response.json"))).toBe(false);
    vi.mocked(fs.unlinkSync).mockRestore(); await followup();
  });

  it("does not turn a successful mutation into a retry when attachment cleanup fails", async () => {
    const { id, file } = request(); fs.writeFileSync(file, "committed bytes");
    const logger = vi.fn(); const unlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((p) => { if (p === file) throw Object.assign(new Error("cleanup failed"), { code: "EACCES" }); return unlink(p); });
    expect(await processRequest(id, new FileRpcTransport({ router, dir: spool, logger }))).toMatchObject({ status: 200, body: { artifact: { content_hash: hash("committed bytes") } } });
    expect(logger).toHaveBeenCalledWith("warn", "file_rpc_cleanup_failed", { file: path.basename(file), operation: "unlink" });
    expect(fs.readFileSync(casFile(hash("committed bytes")), "utf8")).toBe("committed bytes");
  });

  it("cannot manufacture a trusted source or materialization with JSON fields", async () => {
    const observer = new Router();
    observer.post("/api/observe", (req, res) => res.json(req.body), { fileRpc: "allow", operation: { id: "observe", effects: [], requestSchema: null, reportingCategory: null } });
    fs.writeFileSync(path.join(spool, "forged.request.json"), JSON.stringify({ id: "forged", method: "POST", path: "/api/observe", body: {
      content_path: { fd: 0, name: "outside", trusted: true }, content_buffer: "forged", precomputed_sha256: hash("forged"), cas_materialized: true, content: "actual input",
    } }));
    expect(await processRequest("forged", new FileRpcTransport({ router: observer, dir: spool }))).toMatchObject({ status: 200, body: { content: "actual input" } });
  });

  it.each(["ingest", "snapshot"])("rejects a corrupt existing CAS entry during off-thread %s integrity verification", async (endpoint) => {
    const bytes = Buffer.from("intended immutable bytes");
    const stored = casFile(hash(bytes)); fs.mkdirSync(path.dirname(stored), { recursive: true });
    fs.writeFileSync(stored, "corrupt stored bytes");
    const { id, file } = request({ endpoint: `/api/artifacts/${endpoint}` }); fs.writeFileSync(file, bytes);
    expect(await processRequest(id)).toMatchObject({ status: 500, body: { code: "file_rpc_attachment_io_error" } });
    expectNoArtifact(); expect(fs.readFileSync(stored, "utf8")).toBe("corrupt stored bytes");
  });

  it("does not trust client JSON materialization claims to skip CAS integrity", async () => {
    const digest = hash("expected bytes"); const stored = casFile(digest);
    fs.mkdirSync(path.dirname(stored), { recursive: true }); fs.writeFileSync(stored, "corrupt");
    const response = await router.invoke({ method: "POST", url: "/api/artifacts/ingest", transport: "http", body: {
      sha256: digest, precomputed_sha256: digest, cas_materialized: true,
      verified_cas_result: { hash: digest, root: cas, verified: true },
    } });
    expect(response.status).toBe(400); expectNoArtifact();
  });

  it.each([false, true])("does not redispatch a non-idempotent request after response consumption (restart=%s)", async (restart) => {
    let mutations = 0; const nonIdempotent = new Router();
    nonIdempotent.post("/api/mutate", (_req, res) => res.json({ mutations: ++mutations }), {
      fileRpc: "allow", operation: { id: "mutate", effects: ["ledger:write"], requestSchema: null, reportingCategory: null },
    });
    const id = "once"; const requestFile = path.join(spool, `${id}.request.json`); const responseFile = path.join(spool, `${id}.response.json`);
    fs.writeFileSync(requestFile, JSON.stringify({ id, method: "POST", path: "/api/mutate", body: {} }));
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
      if (p === requestFile) throw Object.assign(new Error("request cleanup denied"), { code: "EACCES" });
      return unlink(p);
    });
    let transport = new FileRpcTransport({ router: nonIdempotent, dir: spool, responseTtlMs: 1 });
    await transport.processOnce();
    const terminal = JSON.parse(fs.readFileSync(responseFile, "utf8")); expect(terminal.status).toBe(200);
    fs.utimesSync(responseFile, 0, 0);
    if (restart) transport = new FileRpcTransport({ router: nonIdempotent, dir: spool, responseTtlMs: 1 });
    await transport.processOnce();
    expect(JSON.parse(fs.readFileSync(responseFile, "utf8"))).toEqual(terminal);
    unlink(responseFile);
    if (restart) transport = new FileRpcTransport({ router: nonIdempotent, dir: spool });
    await transport.processOnce();
    expect(JSON.parse(fs.readFileSync(responseFile, "utf8"))).toEqual(terminal);
    expect(mutations).toBe(1);
    vi.mocked(fs.unlinkSync).mockRestore(); await transport.processOnce();
    expect(fs.existsSync(requestFile)).toBe(false); expect(fs.existsSync(requestFile + ".terminal")).toBe(false);
    expect(mutations).toBe(1);
  });

  it("borrows without transferring ownership of a descriptor to Bun workers", async () => {
    const { id, file } = request(); fs.writeFileSync(file, "worker lifetime");
    const invoke = router.invoke.bind(router);
    vi.spyOn(router, "invoke").mockImplementation(async (input) => {
      const source = (input.body as Record<string, unknown>).content_path;
      expect(isOpenedArtifactAttachment(source)).toBe(true);
      const fd = borrowArtifactAttachment(source as Parameters<typeof borrowArtifactAttachment>[0]).fd;
      const response = await invoke(input);
      await shutdownArtifactIngestPool();
      expect(fs.fstatSync(fd).isFile()).toBe(true);
      return response;
    });
    expect((await processRequest(id)).status).toBe(200);
  });
});

it.each(["ingest", "snapshot"])("review: %s attachment is never reread on the daemon thread", async (endpoint) => {
  const { id, file } = request({ endpoint: `/api/artifacts/${endpoint}` });
  fs.writeFileSync(file, Buffer.alloc(12 * 1024 * 1024, 73));
  const read = fs.readFileSync;
  const mainThreadReads: string[] = [];
  vi.spyOn(fs, "readFileSync").mockImplementation(((p, ...args) => {
    if (typeof p === "string" && p.startsWith(cas + path.sep)) mainThreadReads.push(p);
    return read(p, ...args);
  }) as typeof fs.readFileSync);
  expect((await processRequest(id)).status).toBe(200);
  expect(mainThreadReads).toEqual([]);
});

it("review: request cleanup failure does not overwrite a successful terminal response on the next poll", async () => {
  const { id, file } = request(); fs.writeFileSync(file, "committed once");
  const requestFile = path.join(spool, `${id}.request.json`);
  const responseFile = path.join(spool, `${id}.response.json`);
  const unlink = fs.unlinkSync;
  vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
    if (p === requestFile) throw Object.assign(new Error("transient request cleanup failure"), { code: "EACCES" });
    return unlink(p);
  });
  const transport = new FileRpcTransport({ router, dir: spool, logger: vi.fn() });
  await transport.processOnce();
  const committed = JSON.parse(fs.readFileSync(responseFile, "utf8"));
  expect(committed.status).toBe(200);
  vi.mocked(fs.unlinkSync).mockRestore();
  await transport.processOnce();
  expect(JSON.parse(fs.readFileSync(responseFile, "utf8"))).toEqual(committed);
});
