import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchAgent } from "../src/agent-dispatch.js";
import { getDbPath } from "../src/db.js";
import { addProject } from "../src/ledger/project-registry.js";
import { createLedgerIssue, createMigratedDbWithSeeds } from "./helpers/ledger-fixtures.js";
import { longestEventLoopBlockMs, useStubCommand } from "./helpers/event-loop-blocking.js";

describe("agent dispatch", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("waits for claude-spawn off the event loop and records the session it started", async () => {
    const { db, seeds } = createMigratedDbWithSeeds({
      setGlobal: true, operator: { slug: "dispatcher", display_name: "Dispatcher" } });
    const project = addProject(db, { project_key: "dispatch", display_name: "Dispatch" });
    const issue = createLedgerIssue(db, { project_id: project.id, title: "Dispatch me" });
    const stub = useStubCommand("claude-spawn", "sleep 0.3\nprintf 'spawn-handle\\nsession_id: spawned-session\\nattach: claude-spawn attach spawn-handle\\n'");
    vi.stubEnv("MANDIBLE_CLAUDE_SPAWN_BIN", path.join(stub.dir, "claude-spawn"));
    try {
      let outcome: Awaited<ReturnType<typeof dispatchAgent>> | undefined;
      const blockedMs = await longestEventLoopBlockMs(async () => {
        outcome = await dispatchAgent(db, {
          subject: { kind: "issue", issue_ref: issue.id },
          instruction: "Look into it.",
          actorUserId: seeds.operator!.id,
        });
      });

      expect(blockedMs).toBeLessThan(50);
      expect(outcome?.event).toMatchObject({
        status: "dispatched",
        session_handle: "spawn-handle",
        session_id: "spawned-session",
        attach_command: "claude-spawn attach spawn-handle",
      });
    } finally {
      db.close();
      fs.rmSync(path.join(path.dirname(getDbPath()), "agent-dispatch"), { recursive: true, force: true });
    }
  });
});
