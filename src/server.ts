import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  normalizeAmbientProviderIdentity,
  type AmbientProviderIdentity,
} from "./ambient-provider-identity.js";
import { evaluateInstanceMutation, resolveInstanceInfo } from "./instance-policy.js";
import { SseManager } from "./sse.js";
import type { Db } from "./db.js";
import type { HealthResponse, InstanceInfo, Logger, StartupCommitInfo } from "./types.js";
import type { DaemonMemorySnapshot } from "./daemon-memory.js";
import type { EventLoopLagSnapshot } from "./daemon-event-loop.js";

const MAX_BODY_BYTES = 1024 * 1024;
const ROOT_DIR = resolveRootDir();
const UI_DIR = path.join(ROOT_DIR, "ui");
const UI_INDEX_PATH = path.join(UI_DIR, "index.html");
const UI_DIST_DIR = path.join(UI_DIR, "dist");
const UI_ASSET_MANIFEST_PATH = path.join(UI_DIST_DIR, "asset-manifest.json");
const UI_BOOTSTRAP_SCRIPT_RE = /<script\s+id="mandible-bootstrap"\s+type="application\/json"><\/script>/;
const HASHED_ASSET_NAME_RE = /-[A-Za-z0-9_-]{8,}\.[^.]+$/;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
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

type UiAssetManifest = {
  version: 1;
  entryPreloads: string[];
  routes: Record<string, string>;
};

// --- Express-like request/response types ---

export interface RequestLike {
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  ambient_identity?: AmbientProviderIdentity | null;
}

export interface ResponseLike {
  status(code: number): ResponseLike;
  json(payload: unknown): void;
  html?(payload: string): void;
}

export type RouteHandler = (req: RequestLike, res: ResponseLike) => unknown;

export interface FileRpcPolicyContext {
  method: string;
  pathname: string;
  params: Record<string, string>;
}

export type FileRpcPolicy = "allow" | "deny" | {
  allowWhen(context: FileRpcPolicyContext): boolean;
};

export interface RouteOptions {
  fileRpc: FileRpcPolicy;
}

export interface RoutePolicyEntry {
  method: string;
  path: string;
  fileRpc: "allow" | "deny" | "conditional";
  operationalMutationCategory?: string;
}

export interface RouterOptions {
  logger?: Logger;
  instance?: InstanceInfo;
}

export interface RouterInvokeRequest {
  method: string;
  url: string;
  body?: unknown;
  ambient_identity?: unknown;
}

export interface RouterInvokeResponse {
  status: number;
  body: unknown;
}

export interface RouteRegistrar {
  get(path: string, handler: RouteHandler, options: RouteOptions): void;
  post(path: string, handler: RouteHandler, options: RouteOptions): void;
  put(path: string, handler: RouteHandler, options: RouteOptions): void;
  patch(path: string, handler: RouteHandler, options: RouteOptions): void;
  delete(path: string, handler: RouteHandler, options: RouteOptions): void;
}

// --- Router implementation ---

interface CompiledRoute {
  method: string;
  path: string;
  regex: RegExp;
  paramNames: string[];
  handler: RouteHandler;
  options: RouteOptions;
}

interface RouteMatch {
  route: CompiledRoute;
  params: Record<string, string>;
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

  html(payload: string): void {
    if (this._sent) return;
    this._sent = true;
    this.res.writeHead(this._statusCode, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
    });
    this.res.end(payload);
  }
}

class CapturedResponse implements ResponseLike {
  statusCode = 200;
  sent = false;
  body: unknown = null;

  status(code: number): ResponseLike {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): void {
    if (this.sent) return;
    this.sent = true;
    this.body = payload;
  }

  html(payload: string): void {
    if (this.sent) return;
    this.sent = true;
    this.body = payload;
  }
}

export class Router implements RouteRegistrar {
  private routes: CompiledRoute[] = [];
  private readonly instance: InstanceInfo;

  constructor(private options: RouterOptions = {}) {
    this.instance = options.instance ?? resolveInstanceInfo();
  }

  get(path: string, handler: RouteHandler, options: RouteOptions): void {
    this.addRoute("GET", path, handler, options);
  }

  post(path: string, handler: RouteHandler, options: RouteOptions): void {
    this.addRoute("POST", path, handler, options);
  }

  put(path: string, handler: RouteHandler, options: RouteOptions): void {
    this.addRoute("PUT", path, handler, options);
  }

  patch(path: string, handler: RouteHandler, options: RouteOptions): void {
    this.addRoute("PATCH", path, handler, options);
  }

  delete(path: string, handler: RouteHandler, options: RouteOptions): void {
    this.addRoute("DELETE", path, handler, options);
  }

  private addRoute(method: string, path: string, handler: RouteHandler, options: RouteOptions): void {
    const { regex, paramNames } = compileRoute(path);
    this.routes.push({ method, path, regex, paramNames, handler, options });
  }

  resolveFileRpcPolicy(method: string, requestUrl: string): boolean {
    const normalizedMethod = method.toUpperCase();
    const url = new URL(requestUrl, "http://localhost");
    const match = this.matchRoute(normalizedMethod, url.pathname);
    if (!match) {
      return false;
    }
    const policy = match.route.options.fileRpc;
    if (policy === "allow") {
      return true;
    }
    if (policy === "deny") {
      return false;
    }
    return policy.allowWhen({
      method: normalizedMethod,
      pathname: url.pathname,
      params: match.params,
    });
  }

  listRoutePolicies(): RoutePolicyEntry[] {
    return this.routes.map((route) => {
      const operationalMutationCategory = operationalMutationCategoryForRoute(route.method, route.path);
      return {
        method: route.method,
        path: route.path,
        fileRpc: serializeFileRpcPolicy(route.options.fileRpc),
        ...(operationalMutationCategory ? { operationalMutationCategory } : {}),
      };
    });
  }

  async invoke(input: RouterInvokeRequest): Promise<RouterInvokeResponse> {
    const response = new CapturedResponse();
    const handled = await this.dispatch(
      input.method,
      input.url,
      input.body,
      response,
      input.ambient_identity,
    );
    if (!handled) {
      return { status: 404, body: { error: "not_found" } };
    }
    return {
      status: response.statusCode,
      body: response.sent ? response.body : null,
    };
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const method = req.method ?? "GET";
    let body: unknown = undefined;
    if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
      const rawBody = await readIncomingBody(req);
      if (rawBody) {
        try { body = JSON.parse(rawBody); } catch { body = rawBody; }
      }
    }
    return this.dispatch(method, req.url ?? "/", body, new HttpResponse(res), ambientIdentityFromHeaders(req.headers));
  }

  private async dispatch(
    method: string,
    requestUrl: string,
    body: unknown,
    response: ResponseLike,
    ambientIdentity?: unknown,
  ): Promise<boolean> {
    const normalizedMethod = method.toUpperCase();
    const url = new URL(requestUrl, "http://localhost");
    const pathname = url.pathname;
    const requestAmbientIdentity = UNSAFE_METHODS.has(normalizedMethod)
      ? normalizeAmbientProviderIdentity(ambientIdentity)
      : null;

    const match = this.matchRoute(normalizedMethod, pathname);
    if (match) {
      const { route, params } = match;

      const mutationDecision = evaluateInstanceMutation(this.instance, normalizedMethod, pathname);
      if (!mutationDecision.allowed) {
        response.status(mutationDecision.status).json(mutationDecision.body);
        return true;
      }

      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      const request: RequestLike = {
        method: normalizedMethod,
        url: requestUrl,
        params,
        query,
        body,
        ambient_identity: requestAmbientIdentity,
      };

      try {
        await route.handler(request, response);
      } catch (error) {
        this.options.logger?.("error", "route_handler_error", {
          method: normalizedMethod,
          pathname,
          error: String(error),
        });
        response.status(500).json({ error: "internal_error" });
      }
      return true;
    }

    return false;
  }

  private matchRoute(method: string, pathname: string): RouteMatch | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.regex);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      return { route, params };
    }
    return null;
  }
}

function serializeFileRpcPolicy(policy: FileRpcPolicy): "allow" | "deny" | "conditional" {
  if (policy === "allow" || policy === "deny") {
    return policy;
  }
  return "conditional";
}

function operationalMutationCategoryForRoute(method: string, pathPattern: string): string | null {
  if (!UNSAFE_METHODS.has(method)) {
    return null;
  }
  if (pathPattern === "/api/auth/check") {
    return null;
  }
  const pathPrefixes: Array<[string, string]> = [
    ["/api/knowledge-backrefs", "artifacts"],
    ["/api/work-units", "work_units"],
    ["/api/admin", "system"],
    ["/api/artifacts", "artifacts"],
    ["/api/auth", "auth"],
    ["/api/backup", "backup"],
    ["/api/chats", "chats"],
    ["/api/console", "console"],
    ["/api/conversations", "conversations"],
    ["/api/inbox", "inbox"],
    ["/api/ledger", "ledger"],
    ["/api/issues", "issues"],
    ["/api/presets", "presets"],
    ["/api/projects", "projects"],
    ["/api/provider-manifests", "providers"],
    ["/api/providers", "providers"],
    ["/api/runtime", "runtime"],
    ["/api/settings", "settings"],
    ["/api/sessions", "sessions"],
    ["/api/spaces", "spaces"],
    ["/api/system", "system"],
    ["/api/timeline", "timeline"],
    ["/api/webhooks", "webhooks"],
    ["/api/work", "work"],
    ["/api", "api"],
  ];
  for (const [prefix, category] of pathPrefixes) {
    if (pathPattern === prefix || pathPattern.startsWith(`${prefix}/`)) {
      return category;
    }
  }
  return null;
}

function ambientIdentityFromHeaders(headers: http.IncomingHttpHeaders): AmbientProviderIdentity | null {
  const provider = headerValue(headers["x-mandible-ambient-provider"]);
  const providerSessionId = headerValue(headers["x-mandible-ambient-provider-session-id"]);
  return normalizeAmbientProviderIdentity({
    provider,
    provider_session_id: providerSessionId,
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// --- Server creation ---

export interface ServerOptions {
  db: Db;
  sse: SseManager;
  logger: Logger;
  version: string;
  router: Router;
  getStartupInfo: () => StartupCommitInfo | null;
  // Bug: 4db692a — health endpoint includes rebuilding flag so the UI
  // doesn't reload while the daemon is still alive but about to restart.
  isRebuilding?: () => boolean;
  // Bug: 645f8a8 — lifecycle-owned readiness source. When omitted the daemon
  // is reported ready (back-compat for servers created without a lifecycle,
  // e.g. unit tests). The real daemon wires this to the lifecycle readiness
  // flag so health reports false until critical startup work completes.
  isReady?: () => boolean;
  getMemoryDiagnostics?: () => DaemonMemorySnapshot;
  getEventLoopDiagnostics?: () => EventLoopLagSnapshot;
  instance?: InstanceInfo;
  fileRpcDir?: string;
}

export function createServer(options: ServerOptions): http.Server {
  const { sse, logger, version, router, getStartupInfo, isRebuilding, isReady } = options;
  const instance = options.instance ?? resolveInstanceInfo();

  router.get("/api/health", (_req, res) => {
    const startupCommit =
      getStartupInfo() ?? { hash: "unknown", summary: "unknown", date: "" };
    // Bug: 4db692a — include rebuilding flag so the UI health poll can
    // distinguish "daemon still alive during build" from "daemon restarted
    // with new code". Only included when true to keep the common-case
    // response small.
    const rebuilding = isRebuilding?.() ?? false;
    // Bug: 645f8a8 — readiness is always present so the UI can treat
    // "ready !== true" as "keep the splash up / block mutations". A server
    // created without a readiness source (tests) reports ready by default.
    const ready = isReady?.() ?? true;
    const payload: HealthResponse = {
      status: "ok",
      uptime: process.uptime(),
      version,
      startup_commit: startupCommit,
      instance,
      ...(options.fileRpcDir ? { file_rpc_dir: options.fileRpcDir } : {}),
      ready,
      ...(rebuilding ? { rebuilding: true } : {}),
      ...(options.getMemoryDiagnostics ? { memory: options.getMemoryDiagnostics() } : {}),
      ...(options.getEventLoopDiagnostics ? { eventLoop: options.getEventLoopDiagnostics() } : {}),
    };
    res.json(payload);
  }, { fileRpc: "deny" });

  router.get("/api/instance", (_req, res) => {
    res.json({ instance });
  }, { fileRpc: "deny" });

  return http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ? new URL(req.url, "http://localhost") : null;
    const pathname = url?.pathname ?? "/";
    const isApi = isApiPath(pathname);
    const requestStartedAt = performance.now();
    let loggedRequest = false;
    const logRequest = (aborted: boolean) => {
      if (loggedRequest) {
        return;
      }
      loggedRequest = true;
      const status = res.statusCode || (aborted ? 499 : 200);
      logger(status >= 500 || aborted ? "warn" : "info", "http_request", {
        subsystem: "http",
        method,
        pathname,
        status,
        duration_ms: Math.round(performance.now() - requestStartedAt),
        origin: headerValue(req.headers.origin) ?? null,
        request_id: headerValue(req.headers["x-request-id"]) ?? null,
        aborted,
      });
    };
    res.once("finish", () => logRequest(false));
    res.once("close", () => {
      if (!res.writableEnded) {
        logRequest(true);
      }
    });

    const boundary = validateDaemonWriteBoundary(req, method, isApi);
    if (!boundary.ok) {
      logger("warn", "request_forbidden", { method, pathname, reason: boundary.reason });
      writeJsonResponse(res, 403, { error: "forbidden", reason: boundary.reason });
      return;
    }

    // SSE endpoints handled directly (long-lived connections don't fit the router)
    if (pathname === "/api/events" && method === "GET") {
      const topics = parseTopics(url?.searchParams, null);
      sse.addClient(req, res, topics);
      return;
    }

    if (pathname === "/api/events/subscribe" && method === "POST") {
      const body = await readIncomingBody(req);
      const topics = parseTopics(url?.searchParams, body);
      sse.addClient(req, res, topics);
      return;
    }

    try {
      const handled = await router.handle(req, res);
      if (!handled) {
        if (!isApi && (method === "GET" || method === "HEAD")) {
          const served = await handleStaticRequest(method, pathname, req, res, instance);
          if (served) {
            return;
          }
        }
        sendNotFound(res, isApi);
      }
    } catch (error) {
      logger("error", "handler_error", { error: String(error) });
      writeJsonResponse(res, 500, { error: "internal_error" });
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
  server.on("upgrade", (req, socket, head) => {
    const boundary = validateDaemonBrowserBoundary(req);
    if (!boundary.ok) {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    handleUpgrade(req, socket, head);
  });
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

function readIncomingBody(req: http.IncomingMessage): Promise<string | null> {
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

function writeJsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendNotFound(res: http.ServerResponse, isApi: boolean): void {
  if (isApi) {
    writeJsonResponse(res, 404, { error: "not_found" });
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
  req: http.IncomingMessage,
  res: http.ServerResponse,
  instance: InstanceInfo
): Promise<boolean> {
  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    return false;
  }
  return sendFile(req, res, filePath, method, instance);
}

const PWA_FILES = new Set([
  "/manifest.json",
  "/sw.js",
  "/icon.svg",
  "/header-logo.svg",
  "/icon-192.png",
  "/icon-512.png",
]);

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
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  method: string,
  instance: InstanceInfo
): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (filePath === UI_INDEX_PATH) {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const manifest = await readUiAssetManifest();
      const body = injectBootstrapData(injectAssetPreloads(raw, manifest), instance);
      res.writeHead(200, {
        "Content-Type": getContentType(filePath),
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-cache",
        "Last-Modified": stat.mtime.toUTCString(),
      });
      if (method === "HEAD") {
        res.end();
        return true;
      }
      res.end(body);
      return true;
    }
    const lastModified = stat.mtime.toUTCString();
    const immutable = isImmutableBuildAsset(filePath);
    const cacheControl = immutable ? "public, max-age=31536000, immutable" : "no-cache";
    if (!immutable && isNotModified(req.headers["if-modified-since"], stat.mtime)) {
      res.writeHead(304, {
        "Cache-Control": cacheControl,
        "Last-Modified": lastModified,
      });
      res.end();
      return true;
    }
    res.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Content-Length": stat.size,
      "Cache-Control": cacheControl,
      "Last-Modified": lastModified,
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

function isImmutableBuildAsset(filePath: string): boolean {
  const relative = path.relative(UI_DIST_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return HASHED_ASSET_NAME_RE.test(path.basename(filePath));
}

async function readUiAssetManifest(): Promise<UiAssetManifest | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(UI_ASSET_MANIFEST_PATH, "utf8")) as Partial<UiAssetManifest>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entryPreloads) || !isStringRecord(parsed.routes)) {
      return null;
    }
    const entryPreloads = parsed.entryPreloads.filter(isSafeDistAssetUrl);
    const routes = Object.fromEntries(
      Object.entries(parsed.routes).filter((entry): entry is [string, string] => isSafeDistAssetUrl(entry[1])),
    );
    return { version: 1, entryPreloads, routes };
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

function isSafeDistAssetUrl(value: unknown): value is string {
  return typeof value === "string" && /^\/dist\/[A-Za-z0-9_./-]+$/.test(value) && !value.includes("..");
}

function injectAssetPreloads(html: string, manifest: UiAssetManifest | null): string {
  if (!manifest) return html;
  const entryLinks = manifest.entryPreloads
    .map((href) => `    <link rel="modulepreload" href="${href}" />`)
    .join("\n");
  const routeJson = JSON.stringify(manifest.routes).replace(/[<>&]/g, (char) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
  })[char] ?? char);
  const routePreload = `    <script>(function(){var r=${routeJson},p=(location.hash||\"#/spaces\").replace(/^#\\/?/,\"\").split(\"?\")[0]||\"spaces\";if([\"conversations\",\"chats\",\"chat-history\",\"sessions\"].includes(p))p=\"console\";if(p===\"review\")p=\"work\";if(p===\"presets\")p=\"artifacts\";var h=r[p]||r.spaces;if(h){var l=document.createElement(\"link\");l.rel=\"modulepreload\";l.href=h;document.head.appendChild(l)}})();</script>`;
  const injected = [entryLinks, routePreload].filter(Boolean).join("\n");
  return html.replace(/\s*<\/head>/, `\n${injected}\n  </head>`);
}

function isNotModified(header: string | string[] | undefined, mtime: Date): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  const sinceMs = Date.parse(value);
  if (Number.isNaN(sinceMs)) return false;
  const fileSeconds = Math.floor(mtime.getTime() / 1000);
  const sinceSeconds = Math.floor(sinceMs / 1000);
  return fileSeconds <= sinceSeconds;
}

function injectBootstrapData(html: string, instance: InstanceInfo): string {
  const json = JSON.stringify({ instance }).replace(/[<>&]/g, (char) => {
    switch (char) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      default:
        return char;
    }
  });
  const script = `<script id="mandible-bootstrap" type="application/json">${json}</script>`;
  if (UI_BOOTSTRAP_SCRIPT_RE.test(html)) {
    return html.replace(UI_BOOTSTRAP_SCRIPT_RE, script);
  }
  return html.replace(/<script\s+type="module"\s+src="\.\/dist\/app\.js"><\/script>/, `${script}\n    $&`);
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

type WriteBoundaryResult = { ok: true } | { ok: false; reason: string };

function validateDaemonWriteBoundary(
  req: http.IncomingMessage,
  method: string,
  isApi: boolean,
): WriteBoundaryResult {
  const normalizedMethod = method.toUpperCase();
  if (!isApi || !UNSAFE_METHODS.has(normalizedMethod)) {
    return { ok: true };
  }

  return validateDaemonBrowserBoundary(req);
}

function validateDaemonBrowserBoundary(req: http.IncomingMessage): WriteBoundaryResult {
  const host = parseHostHeader(firstHeader(req, "host"));
  if (!host || !isLoopbackHostname(host.hostname)) {
    return { ok: false, reason: "invalid_host" };
  }

  const secFetchSite = firstHeader(req, "sec-fetch-site")?.toLowerCase();
  if (secFetchSite === "cross-site") {
    return { ok: false, reason: "cross_site_fetch" };
  }

  const origin = firstHeader(req, "origin");
  if (!origin) {
    return { ok: true };
  }

  const parsedOrigin = parseOriginHeader(origin);
  if (!parsedOrigin || !isLoopbackHostname(parsedOrigin.hostname)) {
    return { ok: false, reason: "invalid_origin" };
  }
  if (parsedOrigin.port !== host.port) {
    return { ok: false, reason: "origin_port_mismatch" };
  }

  return { ok: true };
}

function firstHeader(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function parseHostHeader(value: string | undefined): { hostname: string; port: string } | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(`http://${value}`);
    return {
      hostname: normalizeHostname(url.hostname),
      port: url.port,
    };
  } catch {
    return null;
  }
}

function parseOriginHeader(value: string): { hostname: string; port: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return {
      hostname: normalizeHostname(url.hostname),
      port: url.port,
    };
  } catch {
    return null;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function resolveRootDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..");
}
