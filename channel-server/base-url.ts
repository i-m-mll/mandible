import path from "node:path";
import os from "node:os";
import { PRODUCTION_ORIGIN } from "./canonical-origin.js";

export type ChannelTransport =
  | { kind: "socket"; socketPath: string }
  | { kind: "http"; baseUrl: string };

export function resolveTransport(env: NodeJS.ProcessEnv = process.env): ChannelTransport {
  const explicit = env.MANDIBLE_BASE?.trim();
  if (explicit && (explicit.replace(/\/+$/, "") !== PRODUCTION_ORIGIN || env.MANDIBLE_TRANSPORT === "http")) {
    const url = new URL(explicit);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported channel transport: ${url.protocol}`);
    }
    return { kind: "http", baseUrl: explicit.replace(/\/+$/, "") };
  }
  const socketPath = env.MANDIBLE_SOCKET?.trim()
    || path.join(env.HOME || os.homedir(), ".cache/mandible/local-api/production.sock");
  if (!path.isAbsolute(socketPath)) throw new Error("MANDIBLE_SOCKET must be absolute");
  return { kind: "socket", socketPath };
}

/** HTTP endpoint used for request framing; the socket path selects the daemon. */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const transport = resolveTransport(env);
  return transport.kind === "socket" ? "http://localhost" : transport.baseUrl;
}
