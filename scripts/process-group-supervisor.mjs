import process from "node:process";
import { spawn, spawnSync } from 'node:child_process';

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
    if (timedOut) throw Object.assign(new Error(`${binary} ${args[0]} exceeded its ${timeout}ms stage deadline.`), { code: 'STAGE_DEADLINE' });
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

function groupMembers(groupId) {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,uid=,stat="], { encoding: "utf8", timeout: 1_000 });
  if (result.error || result.status !== 0) throw new Error(`Cannot inspect process group ${groupId}.`, { cause: result.error || new Error(result.stderr) });
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [pid, pgid, uid, state] = line.trim().split(/\s+/);
    if (![pid, pgid, uid].every((value) => /^\d+$/.test(value)) || !state) throw new Error("Invalid process-group inspection output.");
    return { pid: Number(pid), pgid: Number(pgid), uid: Number(uid), state, zombie: state.startsWith("Z") };
  }).filter((member) => member.pgid === groupId);
}

function groupFailure(error, { child, groupId }, inspection, probes) {
  const processGroup = {
    groupId,
    callerUid: process.getuid(),
    child: { capturedPid: groupId, observedPid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode },
    inspection,
    probes,
  };
  return Object.assign(new Error(`${error.message}; process-group observation ${JSON.stringify(processGroup)}`, { cause: error }), {
    code: error.code,
    processGroup,
  });
}

function signalGroup(active, signal) {
  const { child, groupId } = active;
  if (!groupId) return;
  let inspection;
  if (child.exitCode !== null || child.signalCode !== null) {
    let members;
    try { members = groupMembers(groupId); }
    catch (error) {
      throw groupFailure(error, active, { error: { message: error.message, cause: error.cause?.message } }, [{ signal, outcome: 'not-sent' }]);
    }
    inspection = { members };
    // An exited leader cannot become live again. Such a PID now names a reused
    // group, and a credential change also invalidates our signal authority.
    if (members.some((member) => member.uid !== process.getuid() || (member.pid === groupId && !member.zombie))) {
      throw groupFailure(new Error(`Refusing to signal process group ${groupId}: owned leader exited and group custody changed.`), active, inspection, [{ signal, outcome: 'refused-custody' }]);
    }
  }
  try {
    process.kill(-groupId, signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    if (error?.code === 'EPERM' && process.platform === 'darwin') {
      try { if (!groupExists(active)) return; }
      catch (observationError) {
        throw groupFailure(observationError, active, observationError.processGroup?.inspection ?? inspection, [
          { signal, outcome: error.code }, ...(observationError.processGroup?.probes ?? []),
        ]);
      }
    }
    throw groupFailure(error, active, inspection, [{ signal, outcome: error.code }]);
  }
}

function groupExists(active) {
  const { groupId } = active;
  if (!groupId) return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM' && process.platform === 'darwin') {
      let members;
      try { members = groupMembers(groupId); }
      catch (inspectionError) {
        throw groupFailure(error, active, { error: { message: inspectionError.message, cause: inspectionError.cause?.message } }, [{ signal: 0, outcome: error.code }]);
      }
      // XNU excludes zombies from its group signal check and returns EPERM
      // when none remain signalable. Prove this exact state; live or foreign
      // members still constitute a permission/custody failure.
      if (members.length > 0 && members.every((member) => member.zombie && member.uid === process.getuid())) return false;
      try {
        process.kill(-groupId, 0);
        return true;
      } catch (retryError) {
        if (retryError?.code === 'ESRCH') return false;
        throw groupFailure(retryError, active, { members }, [
          { signal: 0, outcome: error.code }, { signal: 0, outcome: retryError.code },
        ]);
      }
    }
    throw groupFailure(error, active, undefined, [{ signal: 0, outcome: error.code }]);
  }
}

async function waitForGroupExit(active, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(active)) {
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
      } else if (this.#active?.child === child && groupExists(this.#active)) {
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

  async #terminate(active, signal) {
    const { child, groupId } = active;
    signalGroup(active, signal);
    const leaderExit = waitForExit(child);
    if (!await waitForGroupExit(active, this.#graceMs)) {
      signalGroup(active, "SIGKILL");
      if (!await waitForGroupExit(active, this.#graceMs)) {
        throw new Error(`Process group ${groupId} survived SIGKILL.`);
      }
    }
    await leaderExit;
  }
}
