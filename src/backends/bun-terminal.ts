/** The pinned Bun runtime owns the PTY and subprocess together. */
export interface NativeTerminal {
  write(data: string | Uint8Array): number;
  resize(cols: number, rows: number): void;
  close(): void;
}
export interface TerminalProcess {
  pid: number;
  terminal: NativeTerminal;
  exited: Promise<number>;
  signalCode: string | null;
  kill(signal?: string): void;
}
interface BunTerminalRuntime {
  spawn(command: string[], options: {
    cwd: string;
    env: Record<string, string | undefined>;
    terminal: { cols: number; rows: number; name: string; data(terminal: NativeTerminal, bytes: Uint8Array): void };
  }): TerminalProcess;
}
export function spawnTerminal(command: string[], options: Parameters<BunTerminalRuntime['spawn']>[1]): TerminalProcess {
  const runtime = (globalThis as unknown as { Bun?: BunTerminalRuntime }).Bun;
  if (!runtime) throw new Error('Interactive terminals require the pinned Bun runtime');
  return runtime.spawn(command, options);
}
