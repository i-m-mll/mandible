import { describe, expect, it } from "vitest";

import { parseCodexTaskLockLsof } from "../src/codex-task-liveness.js";

describe("Codex Desktop task writer-lock authority", () => {
  it("accepts only exact task locks held by the Codex provider process", () => {
    const lockDir = "/Users/example/.codex/thread-writer-locks";
    const liveTask = "01a072f2-0e05-7a91-abcd-df4dc6a64e62";
    const anotherTask = "01a064d3-fc75-7a51-a5b6-f61237c52ece";
    const snapshot = parseCodexTaskLockLsof([
      "p1712",
      "ccodex",
      "f96",
      `n${lockDir}/${liveTask}.lock`,
      "p1713",
      "cnode",
      "f12",
      `n${lockDir}/${anotherTask}.lock`,
      "p1712",
      "ccodex",
      "f98",
      `n${lockDir}/not-a-task.lock`,
      "",
    ].join("\n"), lockDir);

    expect([...snapshot.entries()]).toEqual([[liveTask, 1712]]);
  });
});
