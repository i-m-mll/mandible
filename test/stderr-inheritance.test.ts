// @vitest-environment node
import { expect, it } from "vitest";
import { stderrInheritanceSites } from "../scripts/stderr-inheritance.mjs";

const reasons = (source: string) => stderrInheritanceSites("fixture.ts", source).map(({ line, reason }) => `${line}: ${reason}`);

it("finds a child sharing the daemon's output however its options are laid out", () => {
  expect(reasons(`import { spawn, fork } from "node:child_process";
spawn("a", [], {
  stdio: [
    "pipe",
    "pipe",
    process.stderr,
  ],
});
spawn("b", [], { stdio: ["ignore",
  1, "pipe"] });
spawn("c", [], { stdio:
  "inherit" });
const mode = "inherit";
fork("child.js");
Bun.spawn(["d"], { stdout: "pipe" });
Bun.spawn(["e"], { stderr: process.stdout });
import * as cp from "child_process";
cp.fork("other.js");
`)).toEqual([
    "6: stdio passes process.stderr",
    "10: stdio passes fd 1",
    "12: \"inherit\"",
    "13: \"inherit\"",
    "14: fork inherits stdio by default",
    "15: Bun.spawn inherits stderr by default",
    "16: Bun.spawn inherits stderr by default",
    "16: stderr passes process.stdout",
    "18: fork inherits stdio by default",
  ]);
});

it("accepts children whose output is piped, ignored or written to their own file", () => {
  expect(reasons(`import { spawn } from "node:child_process";
const fd = 7;
spawn("a", [], { stdio: [
  "ignore",
  "pipe",
  "pipe",
] });
spawn("b", [], { stdio: ["inherit", fd, "ignore"].slice(1) });
spawn("c", [], { stdio: "ignore" });
conversation.fork("thread");
`)).toEqual(["8: \"inherit\""]);
});
