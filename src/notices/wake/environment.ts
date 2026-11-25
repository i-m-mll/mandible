import { spawn } from "node:child_process";
import os from "node:os";
import type { WakeEnvironment } from "./types.js";

/** The real machine: the user's home, child processes, and process liveness. */
export const DEFAULT_WAKE_ENVIRONMENT: WakeEnvironment = {
  home: os.homedir(),
  run: (command, args, options) => new Promise((resolve) => {
    let stdout = "", stderr = "", settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "pipe"], detached: false,
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, options.timeout_ms);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { stderr += String(error); finish(null); });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  }),
  alive: (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  },
};
