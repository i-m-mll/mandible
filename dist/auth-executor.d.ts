import type { AuthOutputChunk } from "./types.js";
export interface AuthExecutionResult {
    exit_code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    output: string;
    started_at: number;
    finished_at: number;
}
export interface ExecuteAuthCommandOptions {
    request_id: string;
    command: string;
    cwd?: string | null;
    onOutput?: (chunk: AuthOutputChunk) => void;
    now?: () => number;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}
export declare function executeAuthCommand(options: ExecuteAuthCommandOptions): Promise<AuthExecutionResult>;
