import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import path from "node:path";

export type StructuredProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export type StructuredProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export function providerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.MANDIBLE_EXECUTION_OBSERVER_ID;
  delete env.MANDIBLE_EXECUTION_OBSERVER_SESSION_ID;
  delete env.CLAUDECODE;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) delete env[key];
  }
  if (env.PATH) {
    env.PATH = env.PATH
      .split(path.delimiter)
      .filter((entry) => !entry.includes("/node_modules/.bin"))
      .join(path.delimiter);
  }
  return env;
}

export class StructuredJsonProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly records: unknown[] = [];
  private recordListener: ((record: unknown) => void) | null = null;
  private malformedListener: ((line: string) => void) | null = null;
  private exitListener: ((exit: StructuredProcessExit) => void) | null = null;
  private lineBuffer = "";
  private stderrBuffer = "";
  private exited = false;
  private readonly exitPromise: Promise<StructuredProcessExit>;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk.toString("utf8")}`.slice(-8_192);
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        if (this.lineBuffer.trim()) this.consume("\n");
        this.exited = true;
        const exit = { code, signal, stderr: this.stderrBuffer.trim() };
        this.exitListener?.(exit);
        resolve(exit);
      });
    });
  }

  static async start(
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; spawnProcess?: StructuredProcessSpawner } = {},
  ): Promise<StructuredJsonProcess> {
    const spawnProcess = options.spawnProcess ?? (spawn as StructuredProcessSpawner);
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env ?? providerEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const processOwner = new StructuredJsonProcess(child);
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
      wait(5_000).then(() => Promise.reject(new Error(`Timed out starting ${command}`))),
    ]).catch(async (error) => {
      await processOwner.close();
      throw error;
    });
    return processOwner;
  }

  get alive(): boolean {
    return !this.exited;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  onRecord(listener: (record: unknown) => void): void {
    this.recordListener = listener;
    for (const record of this.records.splice(0)) listener(record);
  }

  onMalformed(listener: (line: string) => void): void {
    this.malformedListener = listener;
  }

  onExit(listener: (exit: StructuredProcessExit) => void): void {
    this.exitListener = listener;
  }

  write(record: unknown): void {
    if (!this.alive || !this.child.stdin.writable) throw new Error("Structured provider process is not writable");
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  async close(): Promise<StructuredProcessExit> {
    if (this.alive) {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
      await Promise.race([this.exitPromise, wait(2_000)]);
      if (this.alive) this.child.kill("SIGKILL");
    }
    return this.exitPromise;
  }

  private consume(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (this.recordListener) this.recordListener(record);
        else this.records.push(record);
      } catch {
        this.malformedListener?.(line);
      }
    }
  }
}
