import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "./types.js";
import type { Router, RouterInvokeResponse } from "./server.js";

const DEFAULT_FILE_RPC_DIR = path.join(os.homedir(), ".cache", "mandible", "agent-rpc");
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_RESPONSE_TTL_MS = 15 * 60 * 1_000;

export interface FileRpcRequest {
  id?: string;
  method?: string;
  path?: string;
  url?: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface FileRpcTransportOptions {
  router: Router;
  dir?: string;
  logger?: Logger;
  pollIntervalMs?: number;
  responseTtlMs?: number;
}

export class FileRpcTransport {
  readonly dir: string;
  private readonly router: Router;
  private readonly logger?: Logger;
  private readonly pollIntervalMs: number;
  private readonly responseTtlMs: number;
  private timer: NodeJS.Timeout | null = null;
  private processing = false;
  private readonly activeFiles = new Set<string>();

  constructor(options: FileRpcTransportOptions) {
    this.router = options.router;
    this.dir = options.dir ?? process.env.MANDIBLE_FILE_RPC_DIR ?? DEFAULT_FILE_RPC_DIR;
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.responseTtlMs = options.responseTtlMs ?? DEFAULT_RESPONSE_TTL_MS;
  }

  start(): void {
    ensurePrivateDir(this.dir);
    void this.processOnce();
    this.timer = setInterval(() => {
      void this.processOnce();
    }, this.pollIntervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
    this.logger?.("info", "file_rpc_started", { dir: this.dir });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async processOnce(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      ensurePrivateDir(this.dir);
      this.cleanupExpiredResponses();
      const files = fs.readdirSync(this.dir)
        .filter((file) => file.endsWith(".request.json"))
        .sort();
      for (const file of files) {
        await this.processFile(path.join(this.dir, file));
      }
    } finally {
      this.processing = false;
    }
  }

  private async processFile(requestPath: string): Promise<void> {
    if (this.activeFiles.has(requestPath)) {
      return;
    }
    this.activeFiles.add(requestPath);
    try {
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as FileRpcRequest;
      const requestId = safeRequestId(request.id, requestPath);
      const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";
      const requestUrl = buildRequestUrl(request);
      const response = await this.dispatch(method, requestUrl, request.body);
      this.writeResponse(requestId, response);
      fs.rmSync(requestPath, { force: true });
      this.logger?.("info", "file_rpc_request", {
        file: path.basename(requestPath),
        method,
        path: new URL(requestUrl, "http://localhost").pathname,
        status: response.status,
      });
    } catch (error) {
      const requestId = safeRequestId(undefined, requestPath);
      this.writeResponse(requestId, {
        status: 400,
        body: { error: "bad_file_rpc_request", detail: String(error) },
      });
      fs.rmSync(requestPath, { force: true });
      this.logger?.("info", "file_rpc_request", {
        file: path.basename(requestPath),
        status: 400,
        error: String(error),
      });
    } finally {
      this.activeFiles.delete(requestPath);
    }
  }

  private async dispatch(method: string, requestUrl: string, body: unknown): Promise<RouterInvokeResponse> {
    const pathname = new URL(requestUrl, "http://localhost").pathname;
    if (!isAllowedFileRpcRoute(method, pathname)) {
      return {
        status: 403,
        body: { error: "file_rpc_route_denied", method, path: pathname },
      };
    }
    try {
      return await this.router.invoke({ method, url: requestUrl, body });
    } catch (error) {
      return {
        status: 500,
        body: { error: "internal_error", detail: String(error) },
      };
    }
  }

  private writeResponse(id: string, response: RouterInvokeResponse): void {
    const finalPath = path.join(this.dir, `${id}.response.json`);
    const tempPath = `${finalPath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, JSON.stringify({ id, ...response }), { mode: 0o600 });
    fs.renameSync(tempPath, finalPath);
  }

  private cleanupExpiredResponses(): void {
    const cutoff = Date.now() - this.responseTtlMs;
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith(".response.json")) {
        continue;
      }
      const candidate = path.join(this.dir, file);
      try {
        const stat = fs.statSync(candidate);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(candidate, { force: true });
        }
      } catch {
        // Best effort cleanup only.
      }
    }
  }
}

export function isAllowedFileRpcRoute(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "GET" && pathname === "/api/conversations") return true;
  if (normalizedMethod === "GET" && pathname === "/api/conversations/sources") return true;
  if (normalizedMethod === "GET" && pathname === "/api/conversations/search") return true;
  if (normalizedMethod === "GET" && /^\/api\/conversations\/[^/]+$/.test(pathname)) return true;
  if (normalizedMethod === "GET" && /^\/api\/conversations\/[^/]+\/blocks$/.test(pathname)) return true;
  if (normalizedMethod === "GET" && /^\/api\/conversations\/[^/]+\/forks$/.test(pathname)) return true;
  if (normalizedMethod === "GET" && pathname === "/api/issues") return true;
  if (normalizedMethod === "POST" && pathname === "/api/issues/resolutions") return true;
  if (normalizedMethod === "POST" && /^\/api\/issues\/[^/]+$/.test(pathname)) {
    const repoId = pathname.split("/").at(-1) ?? "";
    return !["migration", "reconcile", "scan"].includes(repoId);
  }
  if (normalizedMethod === "GET" && /^\/api\/ledger\/issues\/[^/]+$/.test(pathname)) return true;
  if (normalizedMethod === "PATCH" && /^\/api\/ledger\/issues\/[^/]+$/.test(pathname)) return true;
  if (normalizedMethod === "GET" && /^\/api\/ledger\/issues\/[^/]+\/umbrella-status$/.test(pathname)) return true;
  if (normalizedMethod === "POST" && /^\/api\/ledger\/issues\/[^/]+\/umbrella-adopt$/.test(pathname)) return true;
  if (normalizedMethod === "POST" && /^\/api\/ledger\/issues\/[^/]+\/umbrella-reconcile$/.test(pathname)) return true;
  if (
    normalizedMethod === "POST" &&
    /^\/api\/ledger\/issues\/[^/]+\/umbrella-manifest-refresh$/.test(pathname)
  ) return true;
  if (normalizedMethod === "GET" && /^\/api\/ledger\/issues\/[^/]+\/parent-role$/.test(pathname)) return true;
  if (normalizedMethod === "POST" && /^\/api\/ledger\/issues\/[^/]+\/parent-role$/.test(pathname)) return true;
  if (normalizedMethod === "GET" && /^\/api\/ledger\/issues\/[^/]+\/head$/.test(pathname)) return true;
  if (normalizedMethod === "GET" && /^\/api\/ledger\/issues\/[^/]+\/body\/revisions$/.test(pathname)) return true;
  if (normalizedMethod === "POST" && /^\/api\/ledger\/issues\/[^/]+\/comments$/.test(pathname)) return true;
  if (normalizedMethod === "GET" && /^\/api\/ledger\/issues\/[^/]+\/checkpoints$/.test(pathname)) return true;
  if (normalizedMethod === "POST" && /^\/api\/ledger\/issues\/[^/]+\/checkpoints$/.test(pathname)) return true;
  if (normalizedMethod === "POST" && pathname === "/api/ledger/relationships") return true;
  if (normalizedMethod === "POST" && pathname === "/api/ledger/relationships/unlink") return true;
  if (normalizedMethod === "POST" && /^\/api\/ledger\/issues\/[^/]+\/worker-status$/.test(pathname)) return true;
  if (normalizedMethod === "POST" && /^\/api\/ledger\/issues\/[^/]+\/branches$/.test(pathname)) return true;
  if (normalizedMethod === "POST" && /^\/api\/ledger\/issues\/[^/]+\/labels$/.test(pathname)) return true;
  if (normalizedMethod === "GET" && /^\/api\/ledger\/comments\/[^/]+\/revisions$/.test(pathname)) return true;
  if (normalizedMethod === "GET" && /^\/api\/ledger\/body-revisions\/[^/]+$/.test(pathname)) return true;
  if (normalizedMethod === "GET" && pathname === "/api/auth/queue") return true;
  if (normalizedMethod === "GET" && /^\/api\/auth\/request\/[^/]+$/.test(pathname)) return true;
  if (normalizedMethod === "POST" && pathname === "/api/auth/check") return true;
  if (normalizedMethod === "POST" && pathname === "/api/auth/request") return true;
  if (normalizedMethod === "GET" && /^\/api\/auth\/request\/[^/]+\/actions$/.test(pathname)) return true;
  if (normalizedMethod === "POST" && /^\/api\/auth\/request\/[^/]+\/actions$/.test(pathname)) return true;
  if (normalizedMethod === "PUT" && /^\/api\/auth\/request\/[^/]+\/actions\/[^/]+$/.test(pathname)) return true;
  if (normalizedMethod === "DELETE" && /^\/api\/auth\/request\/[^/]+\/actions\/[^/]+$/.test(pathname)) return true;
  if (normalizedMethod === "GET" && pathname === "/api/artifacts") return true;
  if (normalizedMethod === "GET" && pathname === "/api/artifacts/resolve") return true;
  if (normalizedMethod === "POST" && pathname === "/api/artifacts/ingest") return true;
  if (normalizedMethod === "POST" && pathname === "/api/artifacts/link") return true;
  if (normalizedMethod === "POST" && pathname === "/api/artifacts/check") return true;
  if (normalizedMethod === "POST" && pathname === "/api/artifacts/snapshot") return true;
  if (normalizedMethod === "GET" && pathname === "/api/system/logs") return true;
  if (normalizedMethod === "GET" && pathname === "/api/work/repos") return true;
  return false;
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Some mounts do not support chmod; creation mode still documents intent.
  }
}

function safeRequestId(id: string | undefined, requestPath: string): string {
  const candidate = id ?? path.basename(requestPath).replace(/\.request\.json$/, "");
  return candidate.replace(/[^A-Za-z0-9._-]/g, "_") || `request-${Date.now()}`;
}

function buildRequestUrl(request: FileRpcRequest): string {
  const rawPath = typeof request.path === "string"
    ? request.path
    : typeof request.url === "string"
      ? request.url
      : "/";
  const url = new URL(rawPath, "http://localhost");
  if (request.query && typeof request.query === "object") {
    for (const [key, value] of Object.entries(request.query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}
