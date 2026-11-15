import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The operator signer: the one interface through which Mandible creates
 * approval keys and asks for signatures. Production uses the approval helper
 * (issue 11a30fc), which holds keys in the Secure Enclave and signs only after a
 * fresh Touch ID match. A signer's output is never trusted: every signature it
 * returns is verified against the registered public key before it authorizes
 * anything (see `OperatorSigningAuthority`).
 */
export type SignerUnavailable =
  | { result: "biometry_unavailable" }
  | { result: "biometry_locked_out" }
  | { result: "no_interactive_session" }
  | { result: "failed"; detail: string };

export type CreateOutcome = { result: "created"; public_key: string } | SignerUnavailable;

export type SignOutcome =
  | { result: "signed"; signature: string }
  | { result: "cancelled" }
  | { result: "key_invalidated" }
  | { result: "key_missing" }
  | SignerUnavailable;

export type KeyState =
  | "usable"
  | "key_missing"
  | "key_invalidated"
  | "biometry_unavailable"
  | "biometry_locked_out"
  | "no_interactive_session"
  | "failed";

export interface KeyStatus {
  key: string;
  state: KeyState;
  public_key: string | null;
  detail: string | null;
}

export interface SignRequest {
  /** Absolute path of the wrapped key file. */
  key: string;
  namespace: string;
  message: Buffer;
  /** Shown on the system sheet. */
  reason: string;
}

export interface OperatorSigner {
  create(key: string): Promise<CreateOutcome>;
  status(keys: readonly string[]): Promise<KeyStatus[] | { result: "failed"; detail: string }>;
  sign(request: SignRequest, signal?: AbortSignal): Promise<SignOutcome>;
}

const KEY_STATES: ReadonlySet<string> = new Set<KeyState>([
  "usable", "key_missing", "key_invalidated", "biometry_unavailable", "biometry_locked_out", "no_interactive_session", "failed",
]);
const UNAVAILABLE = new Set(["biometry_unavailable", "biometry_locked_out", "no_interactive_session"]);
const SIGN_FAILURES = new Set(["cancelled", "key_invalidated", "key_missing", ...UNAVAILABLE]);
const HELPER_TIMEOUT_MS = 120_000;

type HelperReply = { ok: true; value: Record<string, unknown> } | { ok: false; detail: string; cancelled: boolean };

/** Spawns the approval helper once per operation: one JSON request on stdin, one JSON result on stdout. */
export class HelperOperatorSigner implements OperatorSigner {
  constructor(private readonly helperPath: string | null) {}

  async create(key: string): Promise<CreateOutcome> {
    const reply = await this.call({ op: "create", key });
    if (!reply.ok) return { result: "failed", detail: reply.detail };
    const result = reply.value.result;
    if (result === "created" && typeof reply.value.public_key === "string") return { result, public_key: reply.value.public_key };
    if (typeof result === "string" && UNAVAILABLE.has(result)) return { result } as SignerUnavailable;
    return failure(reply.value);
  }

  async status(keys: readonly string[]): Promise<KeyStatus[] | { result: "failed"; detail: string }> {
    if (keys.length === 0) return [];
    const reply = await this.call({ op: "status", keys });
    if (!reply.ok) return { result: "failed", detail: reply.detail };
    const entries = reply.value.keys;
    if (reply.value.result !== "status" || !Array.isArray(entries)) return failure(reply.value);
    const statuses: KeyStatus[] = [];
    for (const entry of entries as Array<Record<string, unknown>>) {
      if (typeof entry?.key !== "string" || typeof entry.state !== "string" || !KEY_STATES.has(entry.state)) {
        return { result: "failed", detail: "The approval helper returned a malformed key status." };
      }
      statuses.push({
        key: entry.key,
        state: entry.state as KeyState,
        public_key: typeof entry.public_key === "string" ? entry.public_key : null,
        detail: typeof entry.detail === "string" ? entry.detail : null,
      });
    }
    return statuses;
  }

  async sign(request: SignRequest, signal?: AbortSignal): Promise<SignOutcome> {
    const reply = await this.call({
      op: "sign", key: request.key, namespace: request.namespace,
      message: request.message.toString("base64"), reason: request.reason,
    }, signal);
    if (!reply.ok) return reply.cancelled ? { result: "cancelled" } : { result: "failed", detail: reply.detail };
    const result = reply.value.result;
    if (result === "signed" && typeof reply.value.signature === "string") return { result, signature: reply.value.signature };
    if (typeof result === "string" && SIGN_FAILURES.has(result)) return { result } as SignOutcome;
    return failure(reply.value);
  }

  private call(request: Record<string, unknown>, signal?: AbortSignal): Promise<HelperReply> {
    const helper = this.helperPath;
    if (!helper) return Promise.resolve({ ok: false, detail: "The approval helper is not installed.", cancelled: false });
    if (signal?.aborted) return Promise.resolve({ ok: false, detail: "Signing was cancelled.", cancelled: true });
    return new Promise((resolve) => {
      const child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"], env: {} });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let aborted = false;
      const abort = () => { aborted = true; child.kill("SIGKILL"); };
      const timer = setTimeout(() => child.kill("SIGKILL"), HELPER_TIMEOUT_MS);
      signal?.addEventListener("abort", abort, { once: true });
      const finish = (reply: HelperReply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(reply);
      };
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.stdin.on("error", () => undefined);
      child.on("error", (error) => finish({ ok: false, detail: `Could not run the approval helper: ${error.message}`, cancelled: false }));
      child.on("close", (code) => {
        if (aborted) return finish({ ok: false, detail: "Signing was cancelled.", cancelled: true });
        if (code !== 0) return finish({ ok: false, detail: `The approval helper exited ${code ?? "by signal"}: ${stderr.trim() || "no detail"}`, cancelled: false });
        try {
          const value = JSON.parse(stdout) as unknown;
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
          finish({ ok: true, value: value as Record<string, unknown> });
        } catch {
          finish({ ok: false, detail: "The approval helper returned malformed output.", cancelled: false });
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}

function failure(value: Record<string, unknown>): { result: "failed"; detail: string } {
  return { result: "failed", detail: typeof value.detail === "string" ? value.detail : `Unexpected approval helper result '${String(value.result)}'.` };
}

/** The installed runtime names the helper; a source checkout builds it as a nested app in Tauri resources. */
export function resolveApprovalHelperPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.MANDIBLE_APPROVAL_HELPER?.trim();
  if (configured) return path.isAbsolute(configured) ? configured : null;
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src-tauri", "resources", "MandibleApproval.app", "Contents", "MacOS", "mandible-approval-helper");
  return existsSync(source) ? source : null;
}
