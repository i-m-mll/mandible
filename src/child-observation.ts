import { execFile, type ExecFileOptions } from "node:child_process";

type ObservationOptions = Omit<ExecFileOptions, "encoding"> & {
  encoding?: "utf8" | "utf-8";
  input?: string | Uint8Array;
  timeout?: number;
  stdio?: unknown;
};

export interface ChildObservation {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Complete a bounded child without occupying the daemon's event loop. */
export async function observeChild(program: string, args: readonly string[], options: ObservationOptions): Promise<ChildObservation> {
  const result = await observeChildBytes(program, args, options);
  return { ...result, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
}

async function observeChildBytes(program: string, args: readonly string[], options: ObservationOptions) {
  const { input, encoding: _encoding, stdio: _stdio, timeout = 5_000, ...childOptions } = options;
  return new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer; error?: Error }>((resolve) => {
    let inputError: Error | undefined;
    const child = execFile(program, [...args], { ...childOptions, timeout, encoding: "buffer" }, (error, stdout, stderr) => {
      const code = error?.code;
      const status = error ? typeof code === "number" ? code : null : 0;
      resolve({ status, signal: error?.signal ?? null, stdout, stderr,
        ...(error && status === null ? { error } : inputError ? { error: inputError } : {}) });
    });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") inputError = error;
    });
    child.stdin?.end(input);
  });
}

export async function childOutput(program: string, args: readonly string[], options: ObservationOptions & { encoding: "utf8" | "utf-8" }): Promise<string>;
export async function childOutput(program: string, args: readonly string[], options: ObservationOptions): Promise<Buffer>;
export async function childOutput(program: string, args: readonly string[], options: ObservationOptions): Promise<string | Buffer> {
  const result = await observeChildBytes(program, args, options);
  if (result.status !== 0 || result.error) {
    const { error: childError, ...details } = result;
    const error = Object.assign(childError ?? new Error(`${program} exited ${result.status ?? result.signal}`), details);
    if (result.error && "killed" in result.error && result.error.killed && result.signal) Object.assign(error, { code: "ETIMEDOUT" });
    throw error;
  }
  return options.encoding ? result.stdout.toString("utf8") : result.stdout;
}
