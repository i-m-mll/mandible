import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { normalizeAmbientProviderIdentity } from "./ambient-provider-identity.js";
import type { InstanceInfo, Logger } from "./types.js";
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
  ambient_identity?: unknown;
  request_origin?: unknown;
  // Issue 708dc4c — per-spool capability token. A file-RPC caller's identity is
  // otherwise only filesystem access with self-asserted ambient identity (now a
  // hint). A valid capability token resolves to an authenticated user at the
  // boundary; in strict mode an unauthenticated file-RPC mutation is rejected.
  capability_token?: string;
  // Large request bytes (e.g. artifact snapshot/copy content) travel as sibling
  // attachment files in the spool dir instead of inline base64 in argv/body
  // (issue 833e972). Maps a body field name to a spool-local attachment file
  // basename; the transport resolves it to the attachment's absolute path so
  // the daemon reads its own spool, never an arbitrary client-named host path.
  attachments?: Record<string, string>;
}

// Body fields an attachment is permitted to populate. Kept deliberately narrow:
// an attachment may only supply a daemon-visible bytes path, never overwrite
// arbitrary body fields.
const ATTACHMENT_TARGET_FIELDS = new Set(["content_path"]);
// Body fields that must never be honored straight from a file-RPC client body.
// `content_path`/`content_buffer` would let a sandboxed caller make the daemon
// read an arbitrary host path; over the file transport they may only be set by
// the transport itself from a validated spool attachment.
const STRIPPED_CLIENT_BODY_FIELDS = ["content_path", "content_buffer"];

export interface FileRpcTransportOptions {
  router: Router;
  dir?: string;
  logger?: Logger;
  instance?: InstanceInfo;
  env?: NodeJS.ProcessEnv;
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
    this.dir = options.dir ?? defaultFileRpcDirForInstance(options.instance, options.env ?? process.env);
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
    const attachmentPaths: string[] = [];
    const startedAt = performance.now();
    try {
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as FileRpcRequest;
      const requestId = safeRequestId(request.id, requestPath);
      const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";
      const requestUrl = buildRequestUrl(request);
      const pathname = new URL(requestUrl, "http://localhost").pathname;
      const body = this.resolveRequestBody(request, attachmentPaths);
      const response = await this.dispatch(
        method,
        requestUrl,
        body,
        request.ambient_identity,
        request.capability_token,
        Object.hasOwn(request, "request_origin") ? { request_origin: request.request_origin } : {},
      );
      this.writeResponse(requestId, response);
      fs.rmSync(requestPath, { force: true });
      this.logger?.("info", "file_rpc_request", {
        subsystem: "file-rpc",
        request_id: requestId,
        ...extractBodyRefs(body),
        file: path.basename(requestPath),
        method,
        path: pathname,
        route: pathname,
        status: response.status,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      const requestId = safeRequestId(undefined, requestPath);
      this.writeResponse(requestId, {
        status: 400,
        body: { error: "bad_file_rpc_request", detail: String(error) },
      });
      fs.rmSync(requestPath, { force: true });
      this.logger?.("warn", "file_rpc_request", {
        subsystem: "file-rpc",
        request_id: requestId,
        file: path.basename(requestPath),
        status: 400,
        duration_ms: Math.round(performance.now() - startedAt),
        error: String(error),
      });
    } finally {
      for (const attachment of attachmentPaths) {
        fs.rmSync(attachment, { force: true });
      }
      this.activeFiles.delete(requestPath);
    }
  }

  /**
   * Build the dispatched body for a file-RPC request (issue 833e972).
   *
   * Client bodies may never set `content_path`/`content_buffer` directly — that
   * would let a sandboxed caller make the daemon read an arbitrary host path.
   * Those fields are stripped, then any declared `attachments` are resolved:
   * each maps an allowlisted body field to a spool-local attachment file
   * basename, which the transport rewrites to the attachment's absolute path so
   * the daemon only ever reads bytes from its own spool directory.
   */
  private resolveRequestBody(request: FileRpcRequest, attachmentPaths: string[]): unknown {
    const { body, attachments } = request;
    const hasAttachments = attachments && typeof attachments === "object" && !Array.isArray(attachments);
    if (!hasAttachments && (!body || typeof body !== "object" || Array.isArray(body))) {
      return body;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      // Attachments declared without a usable object body: nothing to inject.
      return body;
    }
    const next: Record<string, unknown> = { ...(body as Record<string, unknown>) };
    for (const field of STRIPPED_CLIENT_BODY_FIELDS) {
      delete next[field];
    }
    if (hasAttachments) {
      for (const [field, fileName] of Object.entries(attachments as Record<string, string>)) {
        if (!ATTACHMENT_TARGET_FIELDS.has(field)) {
          throw new Error(`file_rpc_attachment_field_not_allowed: ${field}`);
        }
        if (typeof fileName !== "string" || !isSafeAttachmentName(fileName)) {
          throw new Error(`file_rpc_attachment_name_invalid: ${String(fileName)}`);
        }
        const attachmentPath = path.join(this.dir, fileName);
        const resolved = path.resolve(attachmentPath);
        if (path.dirname(resolved) !== path.resolve(this.dir) || !fs.existsSync(resolved)) {
          throw new Error(`file_rpc_attachment_missing: ${fileName}`);
        }
        attachmentPaths.push(resolved);
        next[field] = resolved;
      }
    }
    return next;
  }

  private async dispatch(
    method: string,
    requestUrl: string,
    body: unknown,
    ambientIdentity?: unknown,
    capabilityToken?: string,
    originEnvelope: { request_origin?: unknown } = {},
  ): Promise<RouterInvokeResponse> {
    const pathname = new URL(requestUrl, "http://localhost").pathname;
    if (!this.router.resolveFileRpcPolicy(method, requestUrl)) {
      return {
        status: 403,
        body: { error: "file_rpc_route_denied", method, path: pathname },
      };
    }
    try {
      return await this.router.invoke({
        method,
        url: requestUrl,
        body,
        ambient_identity: normalizeAmbientProviderIdentity(ambientIdentity),
        ...originEnvelope,
        credential: typeof capabilityToken === "string" ? capabilityToken : null,
        transport: "file-rpc",
      });
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

export function defaultFileRpcDirForInstance(
  instance?: InstanceInfo,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.MANDIBLE_FILE_RPC_DIR;
  const sharedDir = path.resolve(DEFAULT_FILE_RPC_DIR);
  const configuredDir = configured ? path.resolve(configured) : null;
  if (instance?.role && instance.role !== "main") {
    if (configuredDir && configuredDir !== sharedDir) {
      return configuredDir;
    }
    return previewScopedFileRpcDir(instance);
  }
  return configuredDir ?? sharedDir;
}

function previewScopedFileRpcDir(instance: InstanceInfo): string {
  if (instance.db_path) {
    return path.join(path.dirname(instance.db_path), "agent-rpc");
  }
  return path.join(os.homedir(), ".cache", "mandible", "previews", `instance-${process.pid}`, "agent-rpc");
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Some mounts do not support chmod; creation mode still documents intent.
  }
}

function isSafeAttachmentName(name: string): boolean {
  // Plain spool-local basename only: no path separators, no traversal, no
  // absolute paths. Keeps attachment reads confined to the spool directory.
  if (!name || name.length > 255) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

function extractBodyRefs(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  const record = body as Record<string, unknown>;
  return {
    ...pickString(record, "issue_id"),
    ...pickString(record, "auth_request_id"),
    ...pickString(record, "artifact_id"),
    ...pickString(record, "session_id"),
    ...pickString(record, "repo_id"),
  };
}

function pickString(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = record[key];
  return typeof value === "string" && value.trim() ? { [key]: value } : {};
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
