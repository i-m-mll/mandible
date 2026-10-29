import process from "node:process";
import { spawn, spawnSync } from 'node:child_process';

export async function runSupervisedCommand(binary, args, { cwd, env, stdio, timeout, graceMs = 1_500, deadline, signal, capture = false, maxBuffer = 1024 * 1024, onSpawn } = {}) {
  const startedAt = Date.now();
  const hardDeadline = deadline ?? (Number.isFinite(timeout) ? startedAt + timeout + 2 * graceMs : Infinity);
  const supervisor = new ProcessGroupSupervisor({ graceMs, deadline: hardDeadline, handleSignals: !signal });
  let timer; let timedOut = false; let aborted = false; let failure; let settled = false; let launched = false; let child;
  let result = { code: null, signal: null };
  const streams = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const truncated = { stdout: false, stderr: false };
  const collect = name => chunk => {
    const bytes = Buffer.concat([streams[name], Buffer.from(chunk)]);
    if (bytes.length > maxBuffer) truncated[name] = true;
    streams[name] = bytes.subarray(Math.max(0, bytes.length - maxBuffer));
  };
  const abort = () => { aborted = true; void supervisor.stopActive().catch(() => {}); };
  try {
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0 || !Number.isFinite(graceMs) || graceMs < 0
      || deadline !== undefined && !Number.isFinite(deadline) || timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error('Invalid supervised command bounds.');
    if (signal?.aborted) { aborted = true; throw new Error('Command aborted before spawn.'); }
    const workMs = Math.min(timeout ?? Infinity, hardDeadline - startedAt - 2 * graceMs);
    if (workMs <= 0) { timedOut = true; throw new Error('Command deadline has no remaining execution and cleanup budget.'); }
    child = spawn(binary, args, { cwd, env, detached: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : stdio });
    launched = Boolean(child.pid);
    const closed = new Promise(resolve => child.once('close', resolve));
    if (capture) {
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
    }
    if (!child.pid) await waitForExit(child);
    supervisor.attach(child);
    onSpawn?.(child);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (Number.isFinite(workMs)) timer = setTimeout(() => { timedOut = true; void supervisor.stopActive().catch(() => {}); }, workMs);
    result = await supervisor.settle(child);
    await beforeDeadline(closed, hardDeadline, 'joining command output');
    settled = true;
    if (timedOut || Date.now() >= hardDeadline) { timedOut = true; throw new Error(`${binary} ${args[0]} exceeded its stage deadline.`); }
    if (aborted) throw new Error(`${binary} ${args[0]} was aborted.`);
    if (result.code !== 0) throw new Error(`${binary} ${args[0]} failed: ${result.signal || result.code}; inspect the retained build log.`);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    try { await supervisor.close(); }
    catch (error) { failure = new AggregateError([...(failure ? [failure] : []), error], 'Command process group cleanup failed.'); settled = false; }
  }
  const completed = { code: child?.exitCode ?? result.code, signal: child?.signalCode ?? result.signal, stdout: streams.stdout.toString('utf8'), stderr: streams.stderr.toString('utf8'),
    stdoutTruncated: truncated.stdout, stderrTruncated: truncated.stderr,
    durationMs: Date.now() - startedAt, processGroupSettled: !launched || settled };
  if (failure) throw Object.assign(failure, { ...completed, code: timedOut ? 'STAGE_DEADLINE' : aborted ? 'ABORT_ERR' : failure.code,
    exitCode: completed.code, timedOut, aborted });
  return completed;
}

async function beforeDeadline(promise, deadline, phase) {
  if (!Number.isFinite(deadline)) return promise;
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Process-group deadline reached while ${phase}.`)), Math.max(0, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
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

function groupMembers(groupId, deadline = Infinity) {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,uid=,stat="], { encoding: "utf8", timeout: Math.max(1, Math.min(1_000, deadline - Date.now())) });
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

function signalGroup(active, signal, deadline = Infinity) {
  const { child, groupId } = active;
  if (!groupId) return;
  let inspection;
  if (child.exitCode !== null || child.signalCode !== null) {
    let members;
    try { members = groupMembers(groupId, deadline); }
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
      try { if (!groupExists(active, deadline)) return; }
      catch (observationError) {
        throw groupFailure(observationError, active, observationError.processGroup?.inspection ?? inspection, [
          { signal, outcome: error.code }, ...(observationError.processGroup?.probes ?? []),
        ]);
      }
    }
    throw groupFailure(error, active, inspection, [{ signal, outcome: error.code }]);
  }
}

function groupExists(active, deadline = Infinity) {
  const { groupId } = active;
  if (!groupId) return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM' && process.platform === 'darwin') {
      let members;
      try { members = groupMembers(groupId, deadline); }
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

async function waitForGroupExit(active, timeoutMs, hardDeadline = Infinity) {
  const deadline = Math.min(Date.now() + timeoutMs, hardDeadline);
  while (groupExists(active, deadline)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(0, deadline - Date.now()))));
  }
  return true;
}

export class ProcessGroupSupervisor {
  #active = null;
  #cleanup = null;
  #interrupted = null;
  #graceMs;
  #deadline;
  #handlers;

  constructor({ graceMs = 1_500, deadline = Infinity, handleSignals = true } = {}) {
    this.#deadline = deadline;
    this.#graceMs = graceMs;
    this.#handlers = {
      SIGINT: () => this.#requestSignal("SIGINT"),
      SIGTERM: () => this.#requestSignal("SIGTERM"),
    };
    if (handleSignals) {
      process.on("SIGINT", this.#handlers.SIGINT);
      process.on("SIGTERM", this.#handlers.SIGTERM);
    }
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
      } else if (this.#active?.child === child && groupExists(this.#active, this.#deadline)) {
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
    signalGroup(active, signal, this.#deadline);
    const leaderExit = waitForExit(child);
    const termGrace = Math.min(this.#graceMs, Math.max(0, (this.#deadline - Date.now()) / 2));
    if (!await waitForGroupExit(active, termGrace, this.#deadline)) {
      signalGroup(active, "SIGKILL", this.#deadline);
      if (!await waitForGroupExit(active, this.#graceMs, this.#deadline)) {
        throw new Error(`Process group ${groupId} survived SIGKILL.`);
      }
    }
    await beforeDeadline(leaderExit, this.#deadline, "joining the group leader");
  }
}
