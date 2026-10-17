import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  normalizeAmbientProviderIdentity,
  type AmbientProviderIdentity,
} from "./ambient-provider-identity.js";
import {
  resolveInstanceInfo,
} from "./instance-policy.js";
import { authorizeEffects } from "./security/effect-policy.js";
import { EFFECTS, resolveOperation, type OperationDescriptor } from "./security/operation-policy.js";
import { SseManager } from "./sse.js";
import type { Db } from "./db.js";
import type { HealthResponse, InstanceInfo, Logger, StartupCommitInfo } from "./types.js";
import type { DaemonMemorySnapshot } from "./daemon-memory.js";
import type { EventLoopLagSnapshot } from "./daemon-event-loop.js";
import { OperatorNotConfiguredError } from "./identity/resolver.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const MAX_BODY_BYTES = 1024 * 1024;
const ROOT_DIR = resolveRootDir();
const UI_DIR = path.join(ROOT_DIR, "ui");
const UI_INDEX_PATH = path.join(UI_DIR, "index.html");
const UI_DIST_DIR = path.join(UI_DIR, "dist");
const UI_ASSET_MANIFEST_PATH = path.join(UI_DIST_DIR, "asset-manifest.json");
const UI_BOOTSTRAP_SCRIPT_RE = /<script\s+id="mandible-bootstrap"\s+type="application\/json"><\/script>/;
const HASHED_ASSET_NAME_RE = /-[A-Za-z0-9_-]{8,}\.[^.]+$/;
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
  local_managed_identity?: LocalManagedIdentity | null;
  managed_client?: boolean;
  // Issue 708dc4c — the authenticated client identity resolved by the
  // client-auth gate (bearer/capability token → user), or null when the request
  // is unauthenticated. Downstream attribution wiring consumes this; the gate
  // itself performs authentication only, not authorization.
  client_identity?: ResolvedClientIdentity | null;
  /** Classified auth failure; raw bearer material is never exposed to routes. */
  /** Aborts when the underlying HTTP client disconnects before a response completes. */
  signal?: AbortSignal;
  target_instance_id?: string | null;
}

export interface LocalManagedIdentity {
  app_name: string;
  session_id: string;
}

// --- Client authentication gate (issue 708dc4c) ---

export type ClientAuthMode = "compat" | "strict";

export interface ResolvedClientIdentity {
  user_id: string;
  slug: string;
  method: "api_token" | "ephemeral" | "installation_context" | "local_os_user" | "local_socket";
  credential_id: string | null;
  source: "http_bearer" | "installation_context" | "file_rpc_capability" | "in_process" | "local_os_user" | "local_socket";
  /**
   * Issue 499c148 — which daemon-minted ephemeral credential answered
   * (`agent_session:<id>`). Set
   * only for `method: "ephemeral"`; reporting-only, never an authorization
   * input, and deliberately absent for api_token identities.
   */
  ephemeral_purpose?: string | null;
  effect_ceiling: readonly import("./security/effect-policy.js").Effect[];
  audience?: string | null;
  csrf_token?: string | null;
}

export interface ClientAuthRequestContext {
  method: string;
  pathname: string;
}

export interface UnattributedWriteRecord {
  method: string;
  pathname: string;
  transport: "http" | "file-rpc";
  category?: string | null;
}

/**
 * The client-authentication gate the router consults at the request boundary.
 * Implemented by ClientAuthenticator (src/client-auth) in production. Isolated
 * route tests may omit the boundary.
 */
export interface ClientAuthGate {
  localBrowserIdentity?(): ResolvedClientIdentity | null;
  localSocketIdentity?(ambient: AmbientProviderIdentity | null, managed: boolean, localManaged?: LocalManagedIdentity | null): ResolvedClientIdentity | null;
  localSocketBootstrapAllowed?(): boolean;
  authenticate(
    credential: string | null | undefined,
    source: ResolvedClientIdentity["source"],
    context?: ClientAuthRequestContext,
  ): ResolvedClientIdentity | null;
  mode(): ClientAuthMode;
  recordUnattributedWrite(record: UnattributedWriteRecord): void;
  telemetrySnapshot?(): unknown;
  authorityId?(): string;
  credentialDirectory?(): string;
  authenticateInternalContext?(credential: string | null | undefined): Promise<ResolvedClientIdentity | null>;
  validateBrowserCsrf?(identity: ResolvedClientIdentity, csrf: string | null | undefined): boolean;
}

const STRICT_ANONYMOUS_HTTP_ROUTES = new Set([
  "/api/health",
  "/api/instance",
  "/api/client-auth/whoami",
  "/api/users/setup",
]);

/** Presentation transport for a credential, used to label the resolved source. */
function clientAuthSourceForTransport(
  transport: "http" | "file-rpc" | "in-process" | "local-socket",
): ResolvedClientIdentity["source"] {
  if (transport === "local-socket") return "local_socket";
  if (transport === "http") return "http_bearer";
  if (transport === "file-rpc") return "file_rpc_capability";
  return "in_process";
}

function resolveLocalSocketIdentity(
  gate: ClientAuthGate,
  credential: string | null | undefined,
  ambient: AmbientProviderIdentity | null,
  managed: boolean,
  localManaged: LocalManagedIdentity | null,
  context: ClientAuthRequestContext,
): ResolvedClientIdentity | null {
  const claimed = ambient || localManaged
    ? gate.localSocketIdentity?.(ambient, true, localManaged) ?? null
    : null;
  if ((ambient || localManaged) && !claimed) return null;
  if (credential !== null && credential !== undefined) {
    const verified = gate.authenticate(credential, "local_socket", context);
    return verified && (!claimed || claimed.user_id === verified.user_id) ? verified : null;
  }
  return claimed ?? gate.localSocketIdentity?.(null, managed, null) ?? null;
}

export interface ResponseLike {
  status(code: number): ResponseLike;
  header?(name: string, value: string | string[]): ResponseLike;
  json(payload: unknown): void;
  empty?(): void;
  html?(payload: string): void;
  text?(payload: string, contentType?: string): void;
  binary?(payload: Buffer, contentType: string): void;
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
  operation: OperationDescriptor;
  fileRpc: FileRpcPolicy;
  // Infrastructure mutations may opt out of historical unattributed-write
  // telemetry. Authorization never depends on this counter.
  countUnattributed?: boolean;
}

export interface RoutePolicyEntry {
  method: string;
  path: string;
  fileRpc: "allow" | "deny" | "conditional";
  operationId: string;
  operationalMutationCategory: string | null;
  requestSchema: "handler" | "zod";
  effects: readonly import("./security/operation-policy.js").Effect[] | null;
}

export interface RouterOptions {
  logger?: Logger;
  instance?: InstanceInfo;
  // Issue 708dc4c — optional client-auth gate. Omitted in tests and legacy
  // servers, preserving the original unauthenticated boundary behavior.
  clientAuth?: ClientAuthGate;
}

export interface RouterInvokeRequest {
  method: string;
  url: string;
  body?: unknown;
  ambient_identity?: unknown;
  // Issue 708dc4c — bearer/capability token presented over an in-process or
  // file-RPC invocation, and the transport used to present it.
  credential?: string | null;
  transport?: "http" | "file-rpc" | "in-process";
  signal?: AbortSignal;
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
  private readonly headers: Record<string, string | string[]> = {};

  constructor(private res: http.ServerResponse) {}

  status(code: number): ResponseLike {
    this._statusCode = code;
    return this;
  }

  header(name: string, value: string | string[]): ResponseLike {
    this.headers[name] = value;
    return this;
  }

  json(payload: unknown): void {
    if (this._sent) return;
    this._sent = true;
    const body = JSON.stringify(payload);
    this.res.writeHead(this._statusCode, {
      ...this.headers,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    });
    this.res.end(body);
  }

  empty(): void {
    if (this._sent) return;
    this._sent = true;
    this.res.writeHead(this._statusCode, { ...this.headers, "Content-Length": "0" });
    this.res.end();
  }

  html(payload: string): void {
    if (this._sent) return;
    this._sent = true;
    this.res.writeHead(this._statusCode, {
      ...this.headers,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
    });
    this.res.end(payload);
  }

  text(payload: string, contentType = "text/plain; charset=utf-8"): void {
    if (this._sent) return;
    this._sent = true;
    this.res.writeHead(this._statusCode, {
      ...this.headers,
      "Content-Type": contentType,
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
    });
    this.res.end(payload);
  }

  binary(payload: Buffer, contentType: string): void {
    if (this._sent) return;
    this._sent = true;
    this.res.writeHead(this._statusCode, { ...this.headers, "Content-Type": contentType,
      "Content-Length": payload.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
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

  header(_name: string, _value: string | string[]): ResponseLike {
    return this;
  }

  json(payload: unknown): void {
    if (this.sent) return;
    this.sent = true;
    this.body = payload;
  }

  empty(): void {
    if (this.sent) return;
    this.sent = true;
    this.body = null;
  }

  html(payload: string): void {
    if (this.sent) return;
    this.sent = true;
    this.body = payload;
  }

  text(payload: string): void {
    if (this.sent) return;
    this.sent = true;
    this.body = payload;
  }

  binary(payload: Buffer): void {
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
    const operation = options?.operation;
    if (!operation || typeof operation.id !== "string" || !operation.id.trim()
        || !(operation.reportingCategory === null || typeof operation.reportingCategory === "string" && operation.reportingCategory.length > 0)
        || !(operation.requestSchema === null || typeof operation.requestSchema?.safeParse === "function")
        || !(typeof operation.effects === "function" || Array.isArray(operation.effects) && operation.effects.every(effect => EFFECTS.includes(effect)))
        || !(options.fileRpc === "allow" || options.fileRpc === "deny"
          || typeof options.fileRpc === "object" && typeof options.fileRpc?.allowWhen === "function")) {
      throw new Error(`Incomplete operation descriptor: ${method} ${path}`);
    }
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
      return {
        method: route.method,
        path: route.path,
        fileRpc: serializeFileRpcPolicy(route.options.fileRpc),
        operationId: route.options.operation.id,
        operationalMutationCategory: route.options.operation.reportingCategory,
        requestSchema: route.options.operation.requestSchema === null ? "handler" : "zod",
        effects: typeof route.options.operation.effects === "function" ? null : route.options.operation.effects,
      };
    });
  }

  resolveRequestOperation(method: string, requestUrl: string, body?: unknown) {
    const match = this.matchRoute(method.toUpperCase(), new URL(requestUrl, "http://localhost").pathname);
    return match ? resolveOperation(match.route.options.operation, { instanceRole: this.instance.role, body, params: match.params }) : null;
  }

  operationCatalog(version: string) {
    return {
      schema: "mandible-operation-catalog@2" as const,
      source: "Router.listRoutePolicies" as const,
      runtime: {
        version,
        instance_id: this.instance.instance_id,
        backend_generation: this.instance.backend_generation,
      },
      routes: this.listRoutePolicies(),
    };
  }

  async invoke(input: RouterInvokeRequest): Promise<RouterInvokeResponse> {
    const response = new CapturedResponse();
    const handled = await this.dispatch(
      input.method,
      input.url,
      input.body,
      response,
      input.ambient_identity,
      input.credential,
      input.transport ?? "in-process",
      input.signal,
    );
    if (!handled) {
      return { status: 404, body: { error: "not_found" } };
    }
    return {
      status: response.statusCode,
      body: response.sent ? response.body : null,
    };
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, transport: "http" | "local-socket" = "http"): Promise<boolean> {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    const abortOnClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once("aborted", abort);
    res.once("close", abortOnClose);
    const method = req.method ?? "GET";
    let body: unknown = undefined;
    if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
      const rawBody = await readIncomingBody(req, req.url?.split("?")[0] === "/api/chat-attachments" ? 7 * 1024 * 1024 : MAX_BODY_BYTES);
      if (rawBody) {
        try { body = JSON.parse(rawBody); } catch { body = rawBody; }
      }
    }
    try {
      let localManaged: LocalManagedIdentity | null = null;
      if (transport === "local-socket") {
        try {
          localManaged = localManagedIdentityFromHeaders(req.headers);
          if (providerHeadersPresent(req.headers) && !ambientIdentityFromHeaders(req.headers)) {
            throw new Error("Invalid provider claim.");
          }
        } catch {
          new HttpResponse(res).status(401).json({ error: "authentication_required", reason: "invalid_managed_identity" });
          return true;
        }
      }
      const browserRequest = transport === "http" && isBrowserRequest(req.headers);
      if (browserRequest && headerValue(req.headers.authorization)) {
        new HttpResponse(res).status(400).json({
          error: "browser_bearer_forbidden",
          message: "Browser requests use local OS-user access; bearer credentials are reserved for other clients.",
        });
        return true;
      }
      return await this.dispatch(
        method,
        req.url ?? "/",
        body,
        new HttpResponse(res),
        ambientIdentityFromHeaders(req.headers),
        browserRequest ? null : bearerFromHeaders(req.headers),
        transport,
        abortController.signal,
        {
          browserRequest,
          csrf: headerValue(req.headers["x-mandible-csrf"]),
          internalContext: headerValue(req.headers["x-mandible-session-context"]),
          targetInstanceId: headerValue(req.headers["x-mandible-target-instance"]),
          managed: managedClientFromHeaders(req.headers),
          localManaged,
        },
      );
    } finally {
      req.removeListener("aborted", abort);
      res.removeListener("close", abortOnClose);
    }
  }

  private async dispatch(
    method: string,
    requestUrl: string,
    body: unknown,
    response: ResponseLike,
    ambientIdentity?: unknown,
    credential?: string | null,
    transport: "http" | "file-rpc" | "in-process" | "local-socket" = "in-process",
    signal?: AbortSignal,
    httpAuth?: {
      browserRequest: boolean;
      csrf?: string;
      internalContext?: string;
      targetInstanceId?: string;
      managed?: boolean;
      localManaged?: LocalManagedIdentity | null;
    },
  ): Promise<boolean> {
    const normalizedMethod = method.toUpperCase();
    const url = new URL(requestUrl, "http://localhost");
    const pathname = url.pathname;
    const requestAmbientIdentity = normalizeAmbientProviderIdentity(ambientIdentity);

    const match = this.matchRoute(normalizedMethod, pathname);
    if (match) {
      const { route, params } = match;

      // Issue 708dc4c — client-authentication gate. Resolve the presented token
      // to a client identity (attached to the request for downstream
      // attribution). Strict HTTP uses one identity boundary for reads and
      // writes; compat mode counts unattributed writes. When no gate is wired
      // (tests/legacy), this block is skipped.
      let clientIdentity: ResolvedClientIdentity | null = null;
      const gate = this.options.clientAuth;
      if (gate) {
        clientIdentity = transport === "local-socket"
          ? resolveLocalSocketIdentity(
              gate, credential, requestAmbientIdentity, httpAuth?.managed === true,
              httpAuth?.localManaged ?? null, { method: normalizedMethod, pathname },
            )
          : httpAuth?.internalContext && gate.authenticateInternalContext
          ? await gate.authenticateInternalContext(httpAuth.internalContext)
          : httpAuth?.browserRequest && gate.localBrowserIdentity
            ? gate.localBrowserIdentity()
          : !httpAuth?.browserRequest ? gate.authenticate(
                credential,
                clientAuthSourceForTransport(transport),
                { method: normalizedMethod, pathname },
              ) : null;
        const localBootstrap = transport === "local-socket"
          && normalizedMethod === "POST" && pathname === "/api/users/setup"
          && credential == null && !httpAuth?.managed && !requestAmbientIdentity && !httpAuth?.localManaged
          && gate.localSocketBootstrapAllowed?.() === true;
        if (transport === "local-socket" && !clientIdentity && pathname !== "/api/health" && !localBootstrap) {
          response.status(401).json({ error: "authentication_required", reason: "local_identity_unknown" });
          return true;
        }
        if (
          transport === "http"
          && gate.mode() === "strict"
          && !clientIdentity
          && !STRICT_ANONYMOUS_HTTP_ROUTES.has(pathname)
        ) {
          response.status(401).json({
            error: "authentication_required",
            reason: httpAuth?.browserRequest ? "local_access_required" : "unknown",
          });
          return true;
        }
        if (
          httpAuth?.browserRequest
          && UNSAFE_METHODS.has(normalizedMethod)
          && (clientIdentity?.source === "local_os_user" || clientIdentity?.source === "installation_context")
          && !gate.validateBrowserCsrf?.(clientIdentity, httpAuth.csrf)
        ) {
          response.status(403).json({ error: "csrf_required" });
          return true;
        }
        if (transport !== "in-process" && UNSAFE_METHODS.has(normalizedMethod) && !clientIdentity && !localBootstrap
            && !STRICT_ANONYMOUS_HTTP_ROUTES.has(pathname)) {
          const telemetryTransport = transport === "http" ? "http" : "file-rpc";
          if (gate.mode() === "strict") {
            response.status(401).json({
              error: "authentication_required",
              reason: "client_auth_strict_mode",
            });
            return true;
          }
          if (route.options.countUnattributed !== false) {
            gate.recordUnattributedWrite({
              method: normalizedMethod,
              pathname,
              transport: telemetryTransport,
              category: route.options.operation.reportingCategory,
            });
          }
        }
      }

      const schema = route.options.operation.requestSchema;
      if (schema !== null) {
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          response.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
          return true;
        }
        body = parsed.data;
      }

      // Direct invocation is a trusted process-local composition boundary.
      // HTTP and file-RPC are ingress and must satisfy both the instance and
      // credential effect ceilings; treating an omitted test/internal
      // transport as file-RPC would invent a remote caller that does not exist.
      if (gate && transport !== "in-process") {
        const operation = resolveOperation(route.options.operation, { instanceRole: this.instance.role, body, params });
        const effectDecision = authorizeEffects(this.instance, clientIdentity, operation);
        if (!effectDecision.allowed) {
          response.status(effectDecision.code === "authentication_required" ? 401 : 403).json({
            error: effectDecision.code,
            operation: operation?.id ?? null,
            missing_effects: effectDecision.missing,
            instance_id: this.instance.instance_id,
          });
          return true;
        }
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
        local_managed_identity: transport === "local-socket" ? httpAuth?.localManaged ?? null : null,
        managed_client: transport === "local-socket" && httpAuth?.managed === true,
        client_identity: clientIdentity,
        signal,
        target_instance_id: httpAuth?.targetInstanceId ?? null,
      };

      try {
        await route.handler(request, response);
      } catch (error) {
        if (error instanceof OperatorNotConfiguredError) {
          response.status(409).json({
            error: error.message,
            code: error.code,
            hint: error.hint,
            retryable: error.retryable,
          });
          return true;
        }
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

// Issue 97cf613 — the route→category table and the exemption set live in
// instance-policy.ts. This wrapper only names the route-pattern call site; do
// not reintroduce a local copy of either table here.


function ambientIdentityFromHeaders(headers: http.IncomingHttpHeaders): AmbientProviderIdentity | null {
  const provider = headerValue(headers["x-mandible-ambient-provider"]);
  const providerSessionId = headerValue(headers["x-mandible-ambient-provider-session-id"]);
  return normalizeAmbientProviderIdentity({
    provider,
    provider_session_id: providerSessionId,
  });
}

function providerHeadersPresent(headers: http.IncomingHttpHeaders): boolean {
  return headerValue(headers["x-mandible-ambient-provider"]) !== undefined
    || headerValue(headers["x-mandible-ambient-provider-session-id"]) !== undefined;
}

function localManagedIdentityFromHeaders(headers: http.IncomingHttpHeaders): LocalManagedIdentity | null {
  const app = headerValue(headers["x-mandible-managed-app"]);
  const session = headerValue(headers["x-mandible-managed-session-id"]);
  if (app === undefined && session === undefined) return null;
  if (app === undefined || session === undefined) throw new Error("Incomplete managed identity.");
  const appName = app.trim();
  const sessionId = session.trim();
  if (!appName || !sessionId || appName.length > 128 || sessionId.length > 256
      || /[\x00-\x1f\x7f]/.test(appName) || /[\x00-\x1f\x7f]/.test(sessionId)) {
    throw new Error("Invalid managed identity.");
  }
  return { app_name: appName, session_id: sessionId };
}

function managedClientFromHeaders(headers: http.IncomingHttpHeaders): boolean {
  return headerValue(headers["x-mandible-managed-client"]) !== undefined
    || headerValue(headers["x-mandible-ambient-provider"]) !== undefined
    || headerValue(headers["x-mandible-ambient-provider-session-id"]) !== undefined
    || headerValue(headers["x-mandible-managed-app"]) !== undefined
    || headerValue(headers["x-mandible-managed-session-id"]) !== undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// Issue 708dc4c — extract the bearer credential from the Authorization header
// for the client-auth gate. The gate tolerates a bare token or a `Bearer `
// scheme; returning the raw header value keeps this layer scheme-agnostic.
function bearerFromHeaders(headers: http.IncomingHttpHeaders): string | null {
  return headerValue(headers["authorization"]) ?? null;
}

function isBrowserRequest(headers: http.IncomingHttpHeaders): boolean {
  return headerValue(headers.origin) !== undefined
    || headerValue(headers["sec-fetch-site"]) !== undefined
    || headerValue(headers.cookie) !== undefined;
}

// --- Server creation ---

export interface ServerOptions {
  db: Db;
  sse: SseManager;
  logger: Logger;
  version: string;
  router: Router;
  getStartupInfo: () => StartupCommitInfo | null;
  startupEpoch?: string;
  // Bug: 4db692a — health endpoint includes rebuilding flag so the UI
  // doesn't reload while the daemon is still alive but about to restart.
  isRebuilding?: () => boolean;
  // Issue a09b4d2 — an announced rebuild that will not restart the daemon.
  getRebuildFailure?: () => NonNullable<HealthResponse["rebuild_failure"]> | null;
  // Bug: 645f8a8 — lifecycle-owned readiness source. When omitted the daemon
  // is reported ready (back-compat for servers created without a lifecycle,
  // e.g. unit tests). The real daemon wires this to the lifecycle readiness
  // flag so health reports false until critical startup work completes.
  isReady?: () => boolean;
  // Optional second-tier readiness source. Omitted servers are warm by default
  // for backward compatibility with existing embedders and tests.
  isWarm?: () => boolean;
  getMemoryDiagnostics?: () => DaemonMemorySnapshot;
  getEventLoopDiagnostics?: () => EventLoopLagSnapshot;
  instance?: InstanceInfo;
  fileRpcDir?: string;
  localSocketPath?: string;
  // Issue 708dc4c — client-auth gate for boundary telemetry and the dashboard
  // local access boundary. Optional for isolated test servers.
  clientAuth?: ClientAuthGate;
}

export function createServer(options: ServerOptions, transport: "http" | "local-socket" = "http"): http.Server {
  const { sse, logger, version, router, getStartupInfo, isRebuilding, isReady, isWarm } = options;
  const instance = options.instance ?? resolveInstanceInfo();

  if (transport === "http") {
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
    const warm = isWarm?.() ?? true;
    const payload: HealthResponse = {
      status: "ok",
      uptime: process.uptime(),
      version,
      ...(options.startupEpoch ? { startup_epoch: options.startupEpoch } : {}),
      startup_commit: startupCommit,
      instance,
      ...(options.fileRpcDir ? { file_rpc_dir: options.fileRpcDir } : {}),
      ...(options.localSocketPath ? { local_socket_path: options.localSocketPath } : {}),
      ready,
      warm,
      ...(rebuilding ? { rebuilding: true } : {}),
      ...(!rebuilding && options.getRebuildFailure?.() ? { rebuild_failure: options.getRebuildFailure()! } : {}),
      ...(options.getMemoryDiagnostics ? { memory: options.getMemoryDiagnostics() } : {}),
      ...(options.getEventLoopDiagnostics ? { eventLoop: options.getEventLoopDiagnostics() } : {}),
      // Issue 708dc4c — surface client-auth mode and the unattributed-write
      // ratchet so operators can see readiness for strict mode.
      ...(options.clientAuth
        ? {
            client_auth: {
              mode: options.clientAuth.mode(),
              ...(options.clientAuth.credentialDirectory
                ? { credential_directory: options.clientAuth.credentialDirectory() }
                : {}),
              ...(options.clientAuth.authorityId
                ? { authority_id: options.clientAuth.authorityId() }
                : {}),
              ...(options.clientAuth.telemetrySnapshot
                ? { telemetry: options.clientAuth.telemetrySnapshot() }
                : {}),
            },
          }
        : {}),
    };
    res.json(payload);
  }, { operation: { id: "get:/api/health", effects: [], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  router.post("/api/events/subscribe", (_req, res) => {
    res.status(400).json({ error: "stream_transport_required" });
  }, { operation: { id: "events.subscribe", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  router.get("/api/instance", (_req, res) => {
    res.json({ instance, operations: router.operationCatalog(version) });
  }, { operation: { id: "get:/api/instance", effects: [], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
  }

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

    const boundary = transport === "http"
      ? validateDaemonWriteBoundary(req, method, pathname, isApi, instance)
      : { ok: true } as const;
    if (!boundary.ok) {
      logger("warn", "request_forbidden", { method, pathname, reason: boundary.reason });
      writeJsonResponse(res, 403, { error: "forbidden", reason: boundary.reason });
      return;
    }

    if (pathname === "/api/events/subscribe" && method === "POST") {
      const browserRequest = transport === "http" && isBrowserRequest(req.headers);
      if (browserRequest && headerValue(req.headers.authorization)) {
        writeJsonResponse(res, 400, { error: "browser_bearer_forbidden" });
        return;
      }
      let localManaged: LocalManagedIdentity | null = null;
      if (transport === "local-socket") {
        try {
          localManaged = localManagedIdentityFromHeaders(req.headers);
          if (providerHeadersPresent(req.headers) && !ambientIdentityFromHeaders(req.headers)) {
            throw new Error("Invalid provider claim.");
          }
        } catch {
          writeJsonResponse(res, 401, { error: "authentication_required", reason: "invalid_managed_identity" });
          return;
        }
      }
      const identity = transport === "local-socket" && options.clientAuth
        ? resolveLocalSocketIdentity(
            options.clientAuth, bearerFromHeaders(req.headers), ambientIdentityFromHeaders(req.headers),
            managedClientFromHeaders(req.headers), localManaged, { method, pathname },
          )
        : (await options.clientAuth?.authenticateInternalContext?.(
          headerValue(req.headers["x-mandible-session-context"]),
        ))
        ?? (browserRequest ? options.clientAuth?.localBrowserIdentity?.() : null)
        ?? (!browserRequest
          ? options.clientAuth?.authenticate(
              bearerFromHeaders(req.headers),
              "http_bearer",
              { method, pathname },
            )
          : null)
        ?? null;
      if (!identity) {
        writeJsonResponse(res, 401, {
          error: "authentication_required",
          reason: "local_access_required",
        });
        return;
      }
      const eventDecision = authorizeEffects(
        instance,
        identity,
        router.resolveRequestOperation(method, pathname),
      );
      if (!eventDecision.allowed) {
        writeJsonResponse(res, 403, { error: eventDecision.code, missing_effects: eventDecision.missing });
        return;
      }
      if (transport === "http" && (identity.source === "local_os_user" || identity.source === "installation_context")
          && !options.clientAuth?.validateBrowserCsrf?.(
            identity,
            headerValue(req.headers["x-mandible-csrf"]),
          )) {
        writeJsonResponse(res, 403, { error: "csrf_required" });
        return;
      }
      const body = await readIncomingBody(req);
      const topics = parseTopics(url?.searchParams, body);
      sse.addClient(req, res, topics, identity);
      return;
    }

    try {
      const handled = await router.handle(req, res, transport);
      if (!handled) {
        if (transport === "http" && !isApi && (method === "GET" || method === "HEAD")) {
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

/** Only this listener can mark a request as local-socket transport. */
export function createLocalSocketServer(options: ServerOptions): http.Server {
  return createServer(options, "local-socket");
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
  ) => void,
  instance: InstanceInfo = resolveInstanceInfo(),
): void {
  server.on("upgrade", (req, socket, head) => {
    // The terminal dispatcher also checks the exact registered origin and
    // authorizes the resolved local or preview identity for the target session.
    const boundary = validateDaemonBrowserBoundary(req, instance, true, false);
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

function readIncomingBody(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<string | null> {
  return new Promise((resolve) => {
    let total = 0;
    let data = "";
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
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
  instance: InstanceInfo,
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
  instance: InstanceInfo,
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
  // The served HTML carries no client-auth credential. This bootstrap
  // contains public instance registration metadata only.
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
  pathname: string,
  isApi: boolean,
  instance: InstanceInfo,
): WriteBoundaryResult {
  const normalizedMethod = method.toUpperCase();
  if (!isBrowserRequest(req.headers)) {
    return { ok: true };
  }
  return validateDaemonBrowserBoundary(
    req, instance, isApi && UNSAFE_METHODS.has(normalizedMethod),
    normalizedMethod === "GET" && pathname === "/",
  );
}

function validateDaemonBrowserBoundary(
  req: http.IncomingMessage,
  instance: InstanceInfo,
  requireOrigin: boolean,
  allowDocumentNavigation: boolean,
): WriteBoundaryResult {
  const hostHeader = firstHeader(req, "host");
  const host = parseHostHeader(hostHeader);
  const registered = new URL(instance.public_origin);
  if (!host || `${host.hostname}:${host.port}` !== registered.host.toLowerCase()) {
    return { ok: false, reason: "invalid_host" };
  }

  const secFetchSite = firstHeader(req, "sec-fetch-site")?.toLowerCase();
  const origin = firstHeader(req, "origin");
  const isTopLevelDocumentNavigation = allowDocumentNavigation
    && firstHeader(req, "sec-fetch-mode") === "navigate"
    && firstHeader(req, "sec-fetch-dest") === "document"
    && !origin;
  if (secFetchSite === "cross-site" && !isTopLevelDocumentNavigation) {
    return { ok: false, reason: "cross_site_fetch" };
  }

  const forwardedInstance = firstHeader(req, "x-mandible-instance-id");
  if (forwardedInstance && forwardedInstance !== instance.instance_id) {
    return { ok: false, reason: "instance_mismatch" };
  }
  if (!origin) {
    return requireOrigin ? { ok: false, reason: "origin_required" } : { ok: true };
  }
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return { ok: false, reason: "invalid_origin" };
  }
  if (parsedOrigin.origin !== instance.public_origin) {
    return { ok: false, reason: "origin_mismatch" };
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

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function resolveRootDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..");
}
