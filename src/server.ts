import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SseManager } from "./sse.js";
import type { Db } from "./db.js";
import type { HealthResponse, Logger, StartupCommitInfo } from "./types.js";

const MAX_BODY_BYTES = 1024 * 1024;
const ROOT_DIR = resolveRootDir();
const UI_DIR = path.join(ROOT_DIR, "ui");
const UI_INDEX_PATH = path.join(UI_DIR, "index.html");
const UI_DIST_DIR = path.join(UI_DIR, "dist");
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm"
};

// --- Express-like request/response types ---

export interface RequestLike {
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface ResponseLike {
  status(code: number): ResponseLike;
  json(payload: unknown): void;
}

export type RouteHandler = (req: RequestLike, res: ResponseLike) => unknown;

export interface RouteRegistrar {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  put(path: string, handler: RouteHandler): void;
  patch(path: string, handler: RouteHandler): void;
  delete(path: string, handler: RouteHandler): void;
}

// --- Router implementation ---

interface CompiledRoute {
  method: string;
  regex: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

function compileRoute(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regexStr = pattern.replace(/:([^/]+)/g, (_match, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

class HttpResponse implements ResponseLike {
  private _statusCode = 200;
  private _sent = false;

  constructor(private res: http.ServerResponse) {}

  status(code: number): ResponseLike {
    this._statusCode = code;
    return this;
  }

  json(payload: unknown): void {
    if (this._sent) return;
    this._sent = true;
    const body = JSON.stringify(payload);
    this.res.writeHead(this._statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    });
    this.res.end(body);
  }
}

export class Router implements RouteRegistrar {
  private routes: CompiledRoute[] = [];

  get(path: string, handler: RouteHandler): void {
    this.addRoute("GET", path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.addRoute("POST", path, handler);
  }

  put(path: string, handler: RouteHandler): void {
    this.addRoute("PUT", path, handler);
  }

  patch(path: string, handler: RouteHandler): void {
    this.addRoute("PATCH", path, handler);
  }

  delete(path: string, handler: RouteHandler): void {
    this.addRoute("DELETE", path, handler);
  }

  private addRoute(method: string, path: string, handler: RouteHandler): void {
    const { regex, paramNames } = compileRoute(path);
    this.routes.push({ method, regex, paramNames, handler });
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.regex);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });

      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      let body: unknown = undefined;
      // Bug: a21979a — include DELETE so body.reason is parsed for DELETE /api/auth/request/:id
      if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
        const rawBody = await readBody(req);
        if (rawBody) {
          try { body = JSON.parse(rawBody); } catch { body = rawBody; }
        }
      }

      const request: RequestLike = { method, url: req.url ?? "/", params, query, body };
      const response = new HttpResponse(res);

      await route.handler(request, response);
      return true;
    }

    return false;
  }
}

// --- Server creation ---

export interface ServerOptions {
  db: Db;
  sse: SseManager;
  logger: Logger;
  version: string;
  router: Router;
  getStartupInfo: () => StartupCommitInfo | null;
}

export function createServer(options: ServerOptions): http.Server {
  const { sse, logger, version, router, getStartupInfo } = options;

  router.get("/api/health", (_req, res) => {
    const startupCommit =
      getStartupInfo() ?? { hash: "unknown", summary: "unknown", date: "" };
    const payload: HealthResponse = {
      status: "ok",
      uptime: process.uptime(),
      version,
      startup_commit: startupCommit
    };
    res.json(payload);
  });

  return http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ? new URL(req.url, "http://localhost") : null;
    const pathname = url?.pathname ?? "/";
    const isApi = isApiPath(pathname);

    logger("debug", "request", { method, pathname });

    // SSE endpoints handled directly (long-lived connections don't fit the router)
    if (pathname === "/api/events" && method === "GET") {
      const topics = parseTopics(url?.searchParams, null);
      sse.addClient(req, res, topics);
      return;
    }

    if (pathname === "/api/events/subscribe" && method === "POST") {
      const body = await readBody(req);
      const topics = parseTopics(url?.searchParams, body);
      sse.addClient(req, res, topics);
      return;
    }

    try {
      const handled = await router.handle(req, res);
      if (!handled) {
        if (!isApi && (method === "GET" || method === "HEAD")) {
          const served = await handleStaticRequest(method, pathname, res);
          if (served) {
            return;
          }
        }
        sendNotFound(res, isApi);
      }
    } catch (error) {
      logger("error", "handler_error", { error: String(error) });
      sendJson(res, 500, { error: "internal_error" });
    }
  });
}

export interface StartServerOptions {
  logger?: Logger;
}

/**
 * Attach a WebSocket upgrade handler to an existing http.Server.
 * Keeps server.ts generic — it accepts a raw upgrade callback and
 * has no knowledge of WebSocket or PTY internals.
 * Bug: e980dd8
 */
export function attachWebSocketUpgrade(
  server: http.Server,
  handleUpgrade: (
    req: http.IncomingMessage,
    socket: import("stream").Duplex,
    head: Buffer
  ) => void
): void {
  server.on("upgrade", handleUpgrade);
}

export function startServer(
  server: http.Server,
  port: number,
  options?: StartServerOptions
): Promise<number> {
  const logger = options?.logger;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);

      // Permanent post-listen error handler: if the listen socket encounters a
      // fatal error after startup (EMFILE, EADDRINUSE on re-listen, etc.), the
      // server silently stops accepting connections but the process stays alive
      // (kept running by SSE response streams). Detect this and exit so the
      // supervisor can restart us cleanly.
      server.on("error", (err: NodeJS.ErrnoException) => {
        const msg = `listen socket error: ${err.code ?? err.message}`;
        if (logger) {
          logger("error", "server_socket_error", { error: msg, code: err.code });
        } else {
          process.stderr.write(`${JSON.stringify({ level: "error", message: msg })}\n`);
        }
        process.exit(1);
      });

      const address = server.address();
      if (typeof address === "object" && address) {
        resolve(address.port);
        return;
      }
      resolve(port);
    });
  });
}

function parseTopics(searchParams: URLSearchParams | null | undefined, body: string | null): string[] {
  const topics: string[] = [];
  if (searchParams) {
    for (const value of searchParams.getAll("topic")) {
      topics.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
    }
  }
  if (body) {
    try {
      const parsed = JSON.parse(body) as { topic?: string; topics?: string[] };
      if (parsed.topic) {
        topics.push(parsed.topic);
      }
      if (Array.isArray(parsed.topics)) {
        topics.push(...parsed.topics);
      }
    } catch {
      // ignore
    }
  }
  return topics;
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let total = 0;
    let data = "";
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      data += chunk.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(null));
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendNotFound(res: http.ServerResponse, isApi: boolean): void {
  if (isApi) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const body = "Not Found";
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function handleStaticRequest(
  method: string,
  pathname: string,
  res: http.ServerResponse
): Promise<boolean> {
  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    return false;
  }
  return sendFile(res, filePath, method);
}

const PWA_FILES = new Set(["/manifest.json", "/sw.js", "/icon.svg", "/icon-192.png", "/icon-512.png"]);

function resolveStaticPath(pathname: string): string | null {
  if (pathname === "/") {
    return UI_INDEX_PATH;
  }
  if (PWA_FILES.has(pathname)) {
    return resolveSafePath(UI_DIR, pathname.slice(1));
  }
  if (pathname.startsWith("/dist/")) {
    const requestPath = pathname.slice("/dist/".length);
    if (!requestPath) {
      return null;
    }
    return resolveSafePath(UI_DIST_DIR, requestPath);
  }
  return null;
}

function resolveSafePath(baseDir: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const normalized = decoded.replace(/\\/g, "/");
  const resolved = path.resolve(baseDir, `.${path.sep}${normalized}`);
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

async function sendFile(
  res: http.ServerResponse,
  filePath: string,
  method: string
): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }
    res.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
      "Last-Modified": stat.mtime.toUTCString(),
    });
    if (method === "HEAD") {
      res.end();
      return true;
    }
    const data = await fs.promises.readFile(filePath);
    res.end(data);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function resolveRootDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..");
}
