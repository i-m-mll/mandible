import process from "node:process";

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

function signalGroup(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
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
    this.#active = child;
  }

  async stopActive(signal = "SIGTERM") {
    if (!this.#active) return;
    if (!this.#cleanup) this.#cleanup = this.#terminate(this.#active, signal);
    await this.#cleanup;
  }

  async settle(child) {
    const result = await waitForExit(child);
    if (this.#cleanup) await this.#cleanup;
    if (this.#active === child) this.#active = null;
    this.#cleanup = null;
    return result;
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

  async #terminate(child, signal) {
    signalGroup(child, signal);
    const exited = waitForExit(child);
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), this.#graceMs)),
    ]);
    if (!graceful) signalGroup(child, "SIGKILL");
    await exited;
  }
}
