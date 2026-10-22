/**
 * Shared file-RPC spool responder for CLI tests (issue c4f456c).
 *
 * `MANDIBLE_BASE=file://<spool>` routes the CLI through the file-RPC transport
 * in `cli/api.sh`: the CLI writes `<id>.request.json` into the spool and waits
 * for a matching `<id>.response.json`. Around ten CLI test files each carried
 * their own `setInterval` poller doing exactly that, with small drift in
 * request recording and error handling. This is the one implementation.
 *
 * The responder is a superset of the copies it replaced: it always records the
 * requests it saw, skips unparsable request files instead of throwing inside
 * the timer, and turns a throwing handler into a 500 response.
 */
import fs from "node:fs";
import path from "node:path";

export interface FileRpcRequest {
  id?: string;
  method?: string;
  path?: string;
  body?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FileRpcResponse {
  status: number;
  body: unknown;
}

export type FileRpcHandler = (request: FileRpcRequest) => FileRpcResponse;

export interface FileRpcResponderOptions {
  /** Poll interval in milliseconds. Defaults to the 10ms every copy used. */
  intervalMs?: number;
  /** Called after each response file is written. */
  afterResponse?: (request: FileRpcRequest) => void;
  /** Stop polling after answering the first request. */
  once?: boolean;
}

export interface FileRpcResponder {
  readonly dir: string;
  /** Every request the responder parsed, in arrival order. */
  readonly requests: FileRpcRequest[];
  readonly timer: NodeJS.Timeout;
  /** Idempotent. */
  stop(): void;
}

/**
 * Start answering file-RPC requests dropped into `spoolDir`. The directory is
 * created if missing. Always pair with `stop()` (or use
 * `withFileRpcResponder`) so the interval cannot outlive the test.
 */
export function startFileRpcResponder(
  spoolDir: string,
  handler: FileRpcHandler,
  options: FileRpcResponderOptions = {},
): FileRpcResponder {
  fs.mkdirSync(spoolDir, { recursive: true });
  const requests: FileRpcRequest[] = [];
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    let files: string[];
    try {
      files = fs.readdirSync(spoolDir);
    } catch {
      // The owning test already tore its spool down (for example after a
      // timeout); there is nothing left to answer.
      stopped = true;
      clearInterval(timer);
      return;
    }
    for (const file of files) {
      if (!file.endsWith(".request.json")) continue;
      const requestPath = path.join(spoolDir, file);
      let request: FileRpcRequest;
      try {
        request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as FileRpcRequest;
      } catch {
        // A partially written request file; it will be complete next tick.
        continue;
      }
      requests.push(request);
      const id = typeof request.id === "string"
        ? request.id
        : file.replace(/\.request\.json$/, "");
      let response: FileRpcResponse;
      try {
        response = handler(request);
      } catch (error) {
        response = { status: 500, body: { error: String(error) } };
      }
      fs.writeFileSync(
        path.join(spoolDir, `${id}.response.json`),
        JSON.stringify({ id, ...response }),
        "utf8",
      );
      fs.rmSync(requestPath, { force: true });
      options.afterResponse?.(request);
      if (options.once) {
        stopped = true;
        clearInterval(timer);
        return;
      }
    }
  }, options.intervalMs ?? 10);

  return {
    dir: spoolDir,
    requests,
    timer,
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Run `fn` with a responder attached to `spoolDir`, stopping it even when `fn`
 * throws. This is the shape most CLI tests want: spawn the CLI inside `fn` and
 * inspect `responder.requests` afterwards.
 */
export async function withFileRpcResponder<T>(
  spoolDir: string,
  handler: FileRpcHandler,
  fn: (responder: FileRpcResponder) => Promise<T> | T,
  options: FileRpcResponderOptions = {},
): Promise<T> {
  const responder = startFileRpcResponder(spoolDir, handler, options);
  try {
    return await fn(responder);
  } finally {
    responder.stop();
  }
}
