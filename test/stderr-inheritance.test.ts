// @vitest-environment node
import { expect, it } from "vitest";
import { stderrInheritanceSites } from "../scripts/stderr-inheritance.mjs";

const lines = (source: string) => stderrInheritanceSites("fixture.ts", source).map(({ line }) => line);

it("finds a child sharing the daemon's output however its options are laid out", () => {
  expect(lines(`import { spawn, fork } from "node:child_process";
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
    6, 10, 12, 13, 14, 15, 16, 16, 18,
  ]);
});

it("resolves fork through require, dynamic import and local aliases", () => {
  expect(lines(`const { fork } = require("child_process");
fork("a.js");
require("node:child_process").fork("b.js");
const cp = require("child_process") as typeof import("child_process");
const alias = cp;
const spawnChild = alias["fork"];
spawnChild("c.js");
const { fork: start } = await import("node:child_process");
start("d.js");
(await import("child_process")).fork("e.js");
import childProcess = require("child_process");
childProcess.fork("f.js");
const other = require("node:path");
other.fork("g.js");
`)).toEqual([2, 3, 7, 9, 10, 12]);
});
