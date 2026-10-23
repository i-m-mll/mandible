import fs from "node:fs";
import type * as ChildProcess from "node:child_process";

export interface IdentityChildInput {
  program: string;
  args: readonly string[];
  cwd: string;
  pid?: number;
}

interface HeldIdentity {
  matches(input: IdentityChildInput): boolean;
  complete(input: IdentityChildInput, callback: () => void): void;
  release(): void;
}

function physicalPath(path: string): string | null {
  try { return fs.realpathSync(path); } catch { return null; }
}

export const identityChildren = {
  holds: [] as HeldIdentity[],
  active: new Set<HeldIdentity>(),
  inputs: [] as IdentityChildInput[],
  trace: false,
  synchronous: 0,
  reset() {
    for (const hold of this.active) hold.release();
    this.holds.length = 0;
    this.inputs.length = 0;
    this.trace = false;
    this.synchronous = 0;
  },
  instrument(actual: typeof ChildProcess) {
    const state = this;
    const execFile = ((...args: any[]) => {
      const input: IdentityChildInput = { program: String(args[0]), args: Array.isArray(args[1]) ? [...args[1]] : [],
        cwd: String((Array.isArray(args[1]) ? args[2] : args[1])?.cwd ?? "") };
      let held: HeldIdentity | undefined;
      if (input.program === "git" && input.args.includes("--git-common-dir")) {
        state.inputs.push(input);
        const index = state.holds.findIndex(hold => hold.matches(input));
        if (index >= 0) held = state.holds.splice(index, 1)[0];
      }
      if (held) {
        const callback = args.at(-1);
        args[args.length - 1] = (...values: unknown[]) => held!.complete(input, () => callback(...values));
      }
      const child = (actual.execFile as any)(...args);
      input.pid = child.pid;
      return child;
    }) as typeof actual.execFile;
    const custom = Object.getOwnPropertyDescriptor(actual.execFile, Symbol.for("nodejs.util.promisify.custom"));
    if (custom) Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), custom);
    return { ...actual, execFile, execFileSync: ((...args: any[]) => {
      if (state.trace) state.synchronous++;
      return (actual.execFileSync as any)(...args);
    }) as typeof actual.execFileSync };
  },
};

/** Hold a real identity answer; raw/real path aliases match unless exact order is requested. */
export function holdIdentity(target?: string | { exactPath: string }) {
  let enter!: (input: IdentityChildInput) => void;
  const entered = new Promise<IdentityChildInput>(resolve => { enter = resolve; });
  let resume: (() => void) | undefined;
  let released = false;
  const expected = typeof target === "string" ? physicalPath(target) : null;
  const hold: HeldIdentity = {
    matches: input => !target || (typeof target === "string" ? expected !== null && physicalPath(input.cwd) === expected : input.cwd === target.exactPath),
    complete(input, callback) { enter(input); if (released) callback(); else resume = callback; },
    release() {
      released = true;
      const index = identityChildren.holds.indexOf(hold);
      if (index >= 0) identityChildren.holds.splice(index, 1);
      identityChildren.active.delete(hold);
      const callback = resume;
      resume = undefined;
      callback?.();
    },
  };
  identityChildren.holds.push(hold);
  identityChildren.active.add(hold);
  return { entered, release: hold.release,
    reached(operation: Promise<unknown>) {
      return Promise.race([entered, operation.then(
        () => { throw new Error(`Operation completed before identity barrier; observed inputs: ${JSON.stringify(identityChildren.inputs)}`); },
        error => { throw new Error(`Operation rejected before identity barrier; observed inputs: ${JSON.stringify(identityChildren.inputs)}`, { cause: error }); },
      )]);
    },
  };
}
