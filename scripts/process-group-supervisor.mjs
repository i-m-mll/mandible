import process from "node:process";
import { spawn } from 'node:child_process';

export async function runSupervisedCommand(binary, args, { cwd, env, stdio, timeout, graceMs } = {}) {
  const supervisor = new ProcessGroupSupervisor({ graceMs });
  let timer; let timedOut = false; let cleanupError;
  try {
    const child = spawn(binary, args, { cwd, env, detached: true, stdio });
    if (!child.pid) await waitForExit(child);
    supervisor.attach(child);
    timer = setTimeout(() => { timedOut = true; void supervisor.stopActive().catch(error => { cleanupError = error; }); }, timeout);
    const result = await supervisor.settle(child);
    if (cleanupError) throw cleanupError;
    if (timedOut) throw new Error(`${binary} ${args[0]} exceeded its ${timeout}ms stage deadline.`);
    if (result.code !== 0) throw new Error(`${binary} ${args[0]} failed: ${result.signal || result.code}; inspect the retained build log.`);
  } finally {
    clearTimeout(timer);
    await supervisor.close();
  }
}

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function signalGroup(groupId, signal) {
  if (!groupId) return;
  try {
    process.kill(-groupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function groupExists(groupId) {
  if (!groupId) return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForGroupExit(groupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(groupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

export class ProcessGroupSupervisor {
  #active = null;
  #cleanup = null;
  #interrupted = null;
  #graceMs;
  #handlers;

  constructor({ graceMs = 1_500 } = {}) {
    this.#graceMs = graceMs;
    this.#handlers = {
      SIGINT: () => this.#requestSignal("SIGINT"),
      SIGTERM: () => this.#requestSignal("SIGTERM"),
    };
    process.on("SIGINT", this.#handlers.SIGINT);
    process.on("SIGTERM", this.#handlers.SIGTERM);
  }

  interruptedSignal() {
    return this.#interrupted;
  }

  attach(child) {
    if (this.#active) throw new Error("A process group is already active.");
    if (this.#interrupted) throw new Error(`Runner interrupted by ${this.#interrupted}.`);
    if (!child.pid) throw new Error("Cannot supervise a child without a process-group ID.");
    this.#active = { child, groupId: child.pid };
  }

  async stopActive(signal = "SIGTERM") {
    if (!this.#active) return;
    if (!this.#cleanup) this.#cleanup = this.#terminate(this.#active, signal);
    await this.#cleanup;
  }

  async settle(child) {
    try {
      const result = await waitForExit(child);
      if (this.#cleanup) {
        await this.#cleanup;
      } else if (this.#active?.child === child && groupExists(this.#active.groupId)) {
        await this.stopActive("SIGTERM");
      }
      return result;
    } catch (error) {
      try {
        if (this.#active?.child === child) await this.stopActive("SIGTERM");
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Child failed and its process group could not be cleaned up.");
      }
      throw error;
    } finally {
      if (this.#active?.child === child) this.#active = null;
      this.#cleanup = null;
    }
  }

  async close() {
    process.off("SIGINT", this.#handlers.SIGINT);
    process.off("SIGTERM", this.#handlers.SIGTERM);
    await this.stopActive("SIGTERM");
  }

  #requestSignal(signal) {
    if (!this.#interrupted) {
      this.#interrupted = signal;
      process.exitCode = SIGNAL_EXIT_CODES[signal];
    }
    void this.stopActive(signal).catch((error) => {
      process.stderr.write(`Failed to stop active process group: ${error}\n`);
      process.exitCode = 1;
    });
  }

  async #terminate({ child, groupId }, signal) {
    signalGroup(groupId, signal);
    const leaderExit = waitForExit(child);
    if (!await waitForGroupExit(groupId, this.#graceMs)) {
      signalGroup(groupId, "SIGKILL");
      if (!await waitForGroupExit(groupId, this.#graceMs)) {
        throw new Error(`Process group ${groupId} survived SIGKILL.`);
      }
    }
    await leaderExit;
  }
}
