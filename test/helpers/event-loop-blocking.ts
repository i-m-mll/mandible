import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { onTestFinished, vi } from "vitest";
import { testRuntimeRoot } from "./runtime-isolation.js";

/** The longest single stretch for which `run` kept the event loop from turning. */
export async function longestEventLoopBlockMs(run: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 2);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Math.max(longest, performance.now() - last);
  } finally {
    clearInterval(ticker);
  }
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Install a shell fixture, with PATH and temporary bytes owned by this test. */
export function useStubCommand(name: string, script: string): { dir: string } {
  const dir = fs.mkdtempSync(path.join(testRuntimeRoot, `stub-${name}-`));
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  const installed = `${dir}${path.delimiter}${previous ?? ""}`;
  vi.stubEnv("PATH", installed);
  onTestFinished(() => {
    if (process.env.PATH === installed) process.env.PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir };
}

/** CPU/file-work turn budget; subprocess checks use causal acknowledgement. */
export const SYNCHRONOUS_WAIT_MS = 150;

type Invocation = { command: string; args: string[] };
type InvocationRecord = Invocation & { acknowledged: boolean; settled: boolean; failure?: string };

/** Each intercepted command must visit this test's event loop before executing. */
export async function useCommandProbe(
  commands: string[] | { [name: string]: string },
  { hold = false } = {},
) {
  const dir = fs.mkdtempSync(path.join(testRuntimeRoot, "probe-"));
  const sockets = new Map<net.Socket, Promise<void>>();
  const invocations: Invocation[] = [];
  const waiters: Array<{ resolve: (invocation: Invocation) => void; reject: (error: Error) => void }> = [];
  const pending = new Set<net.Socket>();
  let closing = false;
  const server = net.createServer(socket => {
    const closed = new Promise<void>(resolve => socket.once("close", resolve));
    sockets.set(socket, closed);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { sockets.delete(socket); pending.delete(socket); });
    let message = "";
    socket.on("data", data => {
      message += data.toString();
      if (!message.endsWith("\n")) return;
      const invocation: Invocation = JSON.parse(message);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(invocation);
      else invocations.push(invocation);
      if (closing) socket.end("cancel\n");
      else if (hold) pending.add(socket);
      else socket.write("ack\n");
    });
  });
  const previous = process.env.PATH;
  const installed = `${dir}${path.delimiter}${previous ?? ""}`;
  const verify = () => {
    const records: InvocationRecord[] = fs.readdirSync(dir).filter(name => name.endsWith(".json"))
      .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    if (!records.length) throw new Error("Command probe intercepted no invocations");
    const failed = records.filter(record => !record.acknowledged || !record.settled || record.failure);
    if (failed.length) throw new Error(`Command probe failed: ${JSON.stringify(failed)}`);
  };
  const close = async () => {
    closing = true;
    if (process.env.PATH === installed) process.env.PATH = previous;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("Command probe closed before invocation"));
    try {
      const closed = [...sockets.values()];
      for (const socket of sockets.keys()) socket.end("cancel\n");
      await Promise.all(closed);
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path.join(dir, "ack.sock"), resolve);
    });
    for (const name of Array.isArray(commands) ? commands : Object.keys(commands)) {
      let executable: string;
      if (Array.isArray(commands)) {
        executable = (previous ?? "").split(path.delimiter).map(entry => path.join(entry, name))
          .find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } }) ?? "";
        if (!executable) throw new Error(`${name} is not on PATH`);
      } else {
        executable = path.join(dir, `${name}.real`);
        fs.writeFileSync(executable, `#!/bin/sh\n${commands[name]}\n`, { mode: 0o755 });
      }
      const child = fileURLToPath(new URL("./command-probe-child.mjs", import.meta.url));
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${[process.execPath, child, dir, name].map(quote).join(" ")} "$@" || exit "$?"\nexec ${quote(executable)} "$@"\n`, { mode: 0o755 });
    }
    process.env.PATH = installed;
  } catch (error) {
    await close();
    throw error;
  }
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    try { verify(); } finally { await close(); }
  };
  onTestFinished(finish);
  return {
    dir,
    close: finish,
    verify,
    async run<T>(run: () => Promise<T>): Promise<T> {
      try { return await run(); } finally { verify(); }
    },
    nextInvocation(operation?: Promise<unknown>): Promise<Invocation> {
      const invocation = invocations.shift();
      if (invocation) return Promise.resolve(invocation);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.push(waiter);
        const ended = (error: Error) => {
          const pendingIndex = waiters.indexOf(waiter);
          if (pendingIndex < 0) return;
          waiters.splice(pendingIndex, 1);
          reject(error);
        };
        operation?.then(
          () => ended(new Error("Operation settled before command probe invocation")),
          error => ended(error instanceof Error ? error : new Error(String(error))),
        );
      });
    },
    release() {
      hold = false;
      for (const socket of pending) socket.write("ack\n");
      pending.clear();
    },
  };
}
