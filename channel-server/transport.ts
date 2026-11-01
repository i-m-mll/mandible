import http from "node:http";
import { resolveBaseUrl, resolveTransport } from "./base-url.js";

const TIMEOUT_MS = 10_000;

/** The app the session's launcher (`mandible wrap`, the Console SDK
 * transport) assigned, or null when this Claude process is not managed. */
function launcherApp(): string | null {
  const app = process.env.MANDIBLE_MANAGED_APP;
  return app && /^[A-Za-z0-9._-]+$/.test(app) ? app : null;
}

export function ambientHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "X-Mandible-Managed-Client": "1" };
  const codeId = process.env.CLAUDE_CODE_SESSION_ID;
  const sessionId = process.env.CLAUDE_SESSION_ID;
  const providerId = codeId && sessionId && codeId !== sessionId ? null : (codeId || sessionId);
  if (providerId) {
    headers["X-Mandible-Ambient-Provider"] = "claude";
    headers["X-Mandible-Ambient-Provider-Session-Id"] = providerId;
  }
  const managedApp = launcherApp();
  const managedSessionId = process.env.MANDIBLE_SESSION_ID;
  if (managedApp && managedSessionId && !/[\x00-\x1f\x7f]/.test(managedSessionId)) {
    headers["X-Mandible-Managed-App"] = managedApp;
    headers["X-Mandible-Managed-Session-Id"] = managedSessionId;
  }
  return headers;
}

export function channelTransportHeaders(kind: "socket" | "http"): Record<string, string> {
  const headers = ambientHeaders();
  if (kind === "http") {
    const token = process.env.MANDIBLE_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function socketRequest<T>(method: string, route: string, body: unknown): Promise<T> {
  const transport = resolveTransport();
  if (transport.kind !== "socket") throw new Error("Expected local socket transport");
  const pathname = route.split("?", 1)[0];
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(pathname)
      || new URL(pathname, "http://localhost").pathname !== pathname
      || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(pathname)) throw new Error("Malformed local API route");
  try { decodeURIComponent(pathname); } catch { throw new Error("Malformed local API route encoding"); }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { ...channelTransportHeaders("socket"), "Content-Type": "application/json" };
  return new Promise<T>((resolve, reject) => {
    const req = http.request({ socketPath: transport.socketPath, host: "localhost", path: route, method, headers, timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) {
          reject(new MandibleClientError(`${method} ${route} returned ${res.statusCode}: ${raw}`, res.statusCode ?? null));
          return;
        }
        try { resolve(raw ? JSON.parse(raw) as T : undefined as T); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", (error) => reject(new MandibleClientError(
      `${method} ${route} failed on local socket ${transport.socketPath}: ${error.message}`,
      null,
      error,
    )));
    req.on("timeout", () => req.destroy(new Error("Mandible socket request timed out")));
    req.end(payload);
  });
}

export class MandibleClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MandibleClientError";
  }
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (resolveTransport().kind === "socket") return socketRequest<T>(method, path, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const opts: RequestInit = {
      method,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...channelTransportHeaders("http"),
      },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(`${resolveBaseUrl()}${path}`, opts);

    if (!res.ok) {
      let detail = "";
      try {
        const errBody = (await res.json()) as { error?: string };
        detail = errBody.error ?? res.statusText;
      } catch {
        detail = res.statusText;
      }
      throw new MandibleClientError(
        `${method} ${path} returned ${res.status}: ${detail}`,
        res.status,
      );
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof MandibleClientError) throw err;

    const isAbort =
      err instanceof DOMException && err.name === "AbortError";
    if (isAbort) {
      throw new MandibleClientError(
        `${method} ${path} timed out after ${TIMEOUT_MS}ms`,
        null,
        err,
      );
    }

    // Connection refused / network error
    const msg =
      err instanceof Error ? err.message : "Unknown network error";
    throw new MandibleClientError(
      `${method} ${path} failed: ${msg} (is the Mandible daemon running?)`,
      null,
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}
