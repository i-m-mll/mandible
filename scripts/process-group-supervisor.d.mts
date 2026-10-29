import type { ChildProcess, StdioOptions } from 'node:child_process';
export interface SupervisedCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  processGroupSettled: boolean;
}
export interface SupervisedCommandFailure extends Error {
  code?: string | number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  processGroupSettled: boolean;
}
export function runSupervisedCommand(binary: string, args: readonly string[], options?: {
  cwd?: string; env?: NodeJS.ProcessEnv; stdio?: StdioOptions; timeout?: number; graceMs?: number;
  deadline?: number; signal?: AbortSignal; capture?: boolean; maxBuffer?: number;
  onSpawn?: (child: ChildProcess) => void;
}): Promise<SupervisedCommandResult>;
export class ProcessGroupSupervisor {
  constructor(options?: { graceMs?: number; deadline?: number; handleSignals?: boolean });
  interruptedSignal(): NodeJS.Signals | null;
  attach(child: ChildProcess): void;
  stopActive(signal?: NodeJS.Signals): Promise<void>;
  settle(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  close(): Promise<void>;
}
